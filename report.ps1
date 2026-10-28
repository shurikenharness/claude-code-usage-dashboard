# See your Claude Code usage, by Shuriken: https://shuriken.sh/tools/claude-code-usage-dashboard
# Source, releases and checksums: https://github.com/shurikenharness/claude-code-usage-dashboard
# SPDX-License-Identifier: MIT
#
# What this script does, in order (the same as report.sh, for Windows PowerShell 5.1 and 7):
#   1. Finds your Claude Code transcripts: the folders you name with -Dir, else the ones in
#      CLAUDE_CONFIG_DIR, else %USERPROFILE%\.claude (and ~/.config/claude).
#   2. Reads numbers from them: model names, token counts, times, effort levels and limit hits.
#      It never reads your prompts, Claude's replies, file paths or project names.
#   3. Shows you a summary and asks before anything leaves this computer.
#   4. Encrypts the report here with a new random key and uploads only the encrypted bytes.
#   5. Prints your private link. The key sits after the "#", and browsers never send that part.
#
# Options: -Dir PATH[,PATH] -Days N -DryRun (print what would be sent, send nothing) -Yes -Help
# Uses only what Windows ships: PowerShell and .NET (GZip, AES, HMAC-SHA256, a random generator).
param([string[]]$Dir = @(), [int]$Days = 0, [switch]$DryRun, [switch]$Yes, [switch]$Help)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$Version = 'ps1-1.1.0'
$Origin = if ($env:SHURIKEN_REPORT_ORIGIN) { $env:SHURIKEN_REPORT_ORIGIN } else { 'https://shuriken.sh' }
$Tool = '/tools/claude-code-usage-dashboard'
$QT = [char]34; $O = [StringComparison]::Ordinal
function Say([string]$text) { [Console]::Error.WriteLine($text) }
# A stop with a message. Not `exit`: run as a script block, that would close your PowerShell window.
function Fail([string]$text) { throw [InvalidOperationException]"usage-report: $text" }

# The same small readers as report.sh: the text after a fixed key, up to the next quote.
function Val([string]$s, [string]$key) {
  $i = $s.IndexOf($key, $O); if ($i -lt 0) { return '' }
  $call = $s.Substring($i + $key.Length, [Math]::Min(256, $s.Length - $i - $key.Length))
  $j = $call.IndexOf($QT); if ($j -lt 0) { return '' }; $call.Substring(0, $j)
}
function Last([string]$s, [string]$key) {
  $i = $s.LastIndexOf($key, $O); if ($i -lt 0) { return '' }
  $call = $s.Substring($i + $key.Length); $j = $call.IndexOf($QT); if ($j -lt 0) { return '' }; $call.Substring(0, $j)
}
function Num([string]$s, [string]$key) {
  $i = $s.IndexOf($key, $O); if ($i -lt 0) { return [long]0 }
  $m = [regex]::Match($s.Substring($i + $key.Length, [Math]::Min(24, $s.Length - $i - $key.Length)), '^[0-9]+')
  if ($m.Success) { [long]$m.Value } else { [long]0 }
}
function Epoch([string]$t) {   # ISO 8601 time to seconds since 1970 (UTC)
  $m = [regex]::Match($t, '^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]*)?(Z|([+-])([0-9]{2}):?([0-9]{2}))$')
  if (-not $m.Success) { return [long]-1 }
  [long]$y = $m.Groups[1].Value; [long]$mo = $m.Groups[2].Value; [long]$d = $m.Groups[3].Value
  $off = [long]0; if ($m.Groups[9].Success) { $off = ([long]$m.Groups[10].Value * 3600 + [long]$m.Groups[11].Value * 60) * $(if ($m.Groups[9].Value -eq '-') { -1 } else { 1 }) }
  if ($mo -le 2) { $y--; $mo += 12 }
  $dn = 365 * $y + [Math]::Floor($y / 4) - [Math]::Floor($y / 100) + [Math]::Floor($y / 400) + [Math]::Floor((153 * ($mo - 3) + 2) / 5) + $d - 719469
  [long]($dn * 86400 + [long]$m.Groups[4].Value * 3600 + [long]$m.Groups[5].Value * 60 + [long]$m.Groups[6].Value - $off)
}

function Main {
  if ($Help) { Say 'Makes a private dashboard of your Claude Code usage. Options: -Dir PATH, -Days N, -DryRun, -Yes'; return }
  if ($Origin -notmatch '^(https://|http://127\.0\.0\.1:)') { Fail 'SHURIKEN_REPORT_ORIGIN must start with https://.' }

  # Where Claude Code keeps its transcripts: <config folder>\projects\<project>\<session>.jsonl.
  $roots = @($Dir)
  if ($roots.Count -eq 0) { $roots = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR -split ',' } else { @((Join-Path $HOME '.claude'), (Join-Path $HOME '.config/claude')) } }
  $folders = @(foreach ($r in $roots) { if (-not $r) { continue }; if (Test-Path -LiteralPath (Join-Path $r 'projects') -PathType Container) { Join-Path $r 'projects' } elseif (Test-Path -LiteralPath $r -PathType Container) { $r } })
  if ($folders.Count -eq 0) { Fail "No Claude Code data found. Looked in: $($roots -join ' '). Use -Dir to point at the folder." }
  $files = @(foreach ($f in $folders) { Get-ChildItem -LiteralPath $f -Recurse -File -Filter '*.jsonl' -ErrorAction SilentlyContinue | Where-Object { $_.Extension -eq '.jsonl' } })
  if ($files.Count -eq 0) { Fail "No Claude Code data found in $($folders -join ' '). Use -Dir to point at the folder." }
  $bytes = ($files | Measure-Object -Property Length -Sum).Sum
  Say ('Reading {0} transcript files ({1:0.0} MB)...' -f $files.Count, ($bytes / 1048576))

  # 1. Pick out only the lines that can hold usage, limits, turn times or effort, then extract.
  $now = [long][Math]::Floor(([DateTime]::UtcNow - [DateTime]'1970-01-01').TotalSeconds)
  $since = if ($Days -gt 0) { $now - [long]$Days * 86400 } else { [long]0 }
  $EFF = @{ low = 1; medium = 2; high = 3; xhigh = 4; max = 5; ultracode = 6 }
  $KIND = @('five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included', 'overage')
  $marks = @("${QT}type${QT}:${QT}assistant${QT}", "${QT}subtype${QT}:${QT}turn_duration${QT}", 'command-name>/effort<', "${QT}effortLevel${QT}", "${QT}ultracode${QT}:true", "${QT}thinkingMetadata${QT}")
  $rows = New-Object 'System.Collections.Generic.List[string]'
  $Calls = @{}; $SEEN = @{}; $PROJ = @{}; $PJ = @{}; $nr = 0
  foreach ($file in $files) {
    try { $stream = New-Object IO.FileStream($file.FullName, 'Open', 'Read', 'ReadWrite') } catch { continue }
    $reader = New-Object IO.StreamReader($stream, (New-Object Text.UTF8Encoding($false)))
    while ($null -ne ($line = $reader.ReadLine())) {
      $nr++; $hit = $false; foreach ($k in $marks) { if ($line.IndexOf($k, $O) -ge 0) { $hit = $true; break } }
      if (-not $hit) { continue }
      $p = $line.IndexOf("${QT}message${QT}:{", $O); $pre = if ($p -ge 0) { $line.Substring(0, $p) } else { $line }
      $sid = (Val $pre "${QT}sessionId${QT}:${QT}").ToLowerInvariant()
      if ($sid.Length -ne 36 -or $sid -cnotmatch '^[0-9a-f-]+$') { continue }
      # Effort marks: the /effort command (its one argument word), or an effort field on the row.
      $lv = ''
      if ($line.IndexOf('<command-name>/effort</command-name>', $O) -ge 0) { $lv = Val $line '<command-args>'; $lt = $lv.IndexOf('<'); if ($lt -ge 0) { $lv = $lv.Substring(0, $lt) } }
      elseif ($line.IndexOf("${QT}ultracode${QT}:true", $O) -ge 0) { $lv = 'ultracode' }
      elseif ($line.IndexOf("${QT}effortLevel${QT}:${QT}", $O) -ge 0) { $lv = Val $line "${QT}effortLevel${QT}:${QT}" }
      elseif ($line.IndexOf("${QT}thinkingMetadata${QT}:{", $O) -ge 0) { $lv = Val $line.Substring($line.IndexOf("${QT}thinkingMetadata${QT}:{", $O)) "${QT}level${QT}:${QT}" }
      $lv = ($lv -replace '[ \t]', '').ToLowerInvariant()
      if ($EFF.ContainsKey($lv)) { $ts = Epoch (Last $line "${QT}timestamp${QT}:${QT}"); if ($ts -ge $since) { $rows.Add("P`t$sid`t$ts`t$($EFF[$lv])") } }
      if ($line.IndexOf("${QT}subtype${QT}:${QT}turn_duration${QT}", $O) -ge 0) {
        $ts = Epoch (Last $line "${QT}timestamp${QT}:${QT}"); $u = Last $line "${QT}uuid${QT}:${QT}"
        if ($ts -ge $since -and ($u -eq '' -or -not $SEEN.ContainsKey($u))) { $SEEN[$u] = 1; $rows.Add("D`t$sid`t$ts`t$(Num $line "${QT}durationMs${QT}:")") }
        continue
      }
      if ($p -lt 0) { continue }
      # The usage object: the last "usage":{ in the row (it follows the message text).
      $q = $line.LastIndexOf("${QT}usage${QT}:{", $O); if ($q -lt $p) { continue }
      $u = $line.Substring($q + 8); $dep = 0; $j = 0
      for (; $j -lt $u.Length; $j++) { $c = $u[$j]; if ($c -eq '{') { $dep++ } elseif ($c -eq '}') { $dep--; if ($dep -eq 0) { break } } }
      $tail = if ($j + 1 -lt $u.Length) { $u.Substring($j + 1) } else { '' }; $u = $u.Substring(0, [Math]::Min($j + 1, $u.Length))
      $ty = Val $pre "${QT}type${QT}:${QT}"; if ($ty -eq '') { $ty = Last $tail "${QT}type${QT}:${QT}" }; if ($ty -ne 'assistant') { continue }
      $ts = Epoch (Last $tail "${QT}timestamp${QT}:${QT}"); if ($ts -lt $since) { continue }
      if ($tail.IndexOf("${QT}isApiErrorMessage${QT}:true", $O) -ge 0 -and $tail.IndexOf("${QT}error${QT}:${QT}rate_limit${QT}", $O) -ge 0) {
        $k = Val $tail "${QT}rateLimitType${QT}:${QT}"; if ($KIND -cnotcontains $k) { $k = 'throttle' }
        $id = Last $tail "${QT}uuid${QT}:${QT}"; if ($id -eq '' -or -not $SEEN.ContainsKey($id)) { $SEEN[$id] = 1; $rows.Add("L`t$sid`t$ts`t$k") }
        continue
      }
      # message.id and message.model come before its content; the input of a tool call never counts.
      $head = $line.Substring($p, [Math]::Min(600, $line.Length - $p)); $ci = $head.IndexOf("${QT}content${QT}:", $O); if ($ci -ge 0) { $head = $head.Substring(0, $ci) }
      $model = (Val $head "${QT}model${QT}:${QT}").ToLowerInvariant()
      if ($model -eq '<synthetic>') { continue }
      if ($model.Length -gt 64 -or $model -cnotmatch '^[a-z0-9][a-z0-9._-]*$') { $model = 'other' }
      $cwd = Val $pre "${QT}cwd${QT}:${QT}"; if (-not $PROJ.ContainsKey($cwd)) { $PROJ[$cwd] = $PROJ.Count }
      if (-not $PJ.ContainsKey($sid)) { $PJ[$sid] = $PROJ[$cwd] }
      $cw = Num $u "${QT}cache_creation_input_tokens${QT}:"; $c1 = [Math]::Min((Num $u "${QT}ephemeral_1h_input_tokens${QT}:"), $cw)
      $call = @($sid, $ts, $model, (Num $u "${QT}input_tokens${QT}:"), (Num $u "${QT}output_tokens${QT}:"), (Num $u "${QT}cache_read_input_tokens${QT}:"), $cw, $c1,
        (Num $u "${QT}web_search_requests${QT}:"), [long]($u.IndexOf("${QT}speed${QT}:${QT}fast${QT}", $O) -ge 0), [long]($pre.IndexOf("${QT}isSidechain${QT}:true", $O) -ge 0), [long]($u.IndexOf("${QT}inference_geo${QT}:${QT}us${QT}", $O) -ge 0))
      # One API request is written as several rows; the copy with the largest counts wins.
      $mid = Val $head "${QT}id${QT}:${QT}"; $rid = Last $tail "${QT}requestId${QT}:${QT}"
      $key = if ($mid -ne '' -and $rid -ne '') { "${mid}:$rid" } else { "#$nr" }
      if (-not $Calls.ContainsKey($key)) { $Calls[$key] = $call; continue }
      $a = $Calls[$key]
      if ($call[1] -lt $a[1] -or ($call[1] -eq $a[1] -and [string]::CompareOrdinal($call[0], $a[0]) -lt 0)) { $a[0] = $call[0]; $a[1] = $call[1] }
      for ($i = 3; $i -le 11; $i++) { if ($call[$i] -gt $a[$i]) { $a[$i] = $call[$i] } }
    }
    $reader.Dispose()
  }
  foreach ($a in $Calls.Values) { $rows.Add('T' + "`t" + ($a -join "`t")) }
  foreach ($s in $PJ.Keys) { $rows.Add("C`t$s`t0`t$($PJ[$s])") }
  [string[]]$models = @($Calls.Values | ForEach-Object { $_[2] } | Sort-Object -Unique -CaseSensitive)
  [Array]::Sort($models, [StringComparer]::Ordinal)
  if ($models.Count -eq 0) { Fail "No Claude Code usage found in $($files.Count) files. Use -Dir to point at another folder." }

  # 2. Add it up per session and per hour, in the same order as report.sh (byte for byte the same file).
  $rows.Sort([Comparison[string]] { param($x, $y)
    $a = $x.Split("`t"); $b = $y.Split("`t"); $r = [string]::CompareOrdinal($a[1], $b[1]); if ($r) { return $r }
    $r = ([long]$a[2]).CompareTo([long]$b[2]); if ($r) { return $r }
    $r = [string]::CompareOrdinal($a[0], $b[0]); if ($r) { return $r }; [string]::CompareOrdinal($x, $y) })
  $MI = @{}; for ($i = 0; $i -lt $models.Count; $i++) { $MI[$models[$i]] = $i }
  $H = @{}; $L = @{}; $SessionRows = New-Object 'System.Collections.Generic.List[string]'; $PN = @{}; $first = [long]0; $lastT = [long]0
  $cur = $null; $st = $null
  function Flush {
    if ($null -eq $st -or $st.calls -eq 0) { return }
    if (-not $PN.ContainsKey($st.proj)) { $PN[$st.proj] = $PN.Count }
    $top = 0; for ($m = 1; $m -lt $models.Count; $m++) { if ($st.sm[$m] -gt $st.sm[$top]) { $top = $m } }
    $SessionRows.Add(("S`t{0}`t{1}`t{2}`t{3}`t{4}`t{5}`t{6}`t{7}`t{8}`t{9}" -f $PN[$st.proj], $st.start, $st.end, $st.act, $st.calls, $st.side, $top, $st.tok, $st.worked, $st.hits))
  }
  foreach ($row in $rows) {
    $f = $row.Split("`t")
    if ($f[1] -ne $cur) { Flush; $cur = $f[1]; $st = @{ proj = '0'; eff = '0'; calls = [long]0; side = [long]0; tok = [long]0; worked = [long]0; hits = [long]0; act = [long]0; start = [long]0; end = [long]0; sm = (New-Object 'long[]' $models.Count) } }
    $ts = [long]$f[2]; $hour = [long][Math]::Floor($ts / 3600)
    switch ($f[0]) {
      'C' { $st.proj = $f[3] }
      'P' { $st.eff = $f[3] }
      'D' { $st.worked += [long]$f[3] }
      'L' { $k = "$hour`t$($f[3])"; $L[$k] = 1 + $(if ($L.ContainsKey($k)) { $L[$k] } else { 0 }); $st.hits += 1 }
      'T' {
        $m = $MI[$f[3]]; $flags = [long]$f[10] + 2 * [long]$f[11] + 4 * [long]$f[12]; $k = "$hour`t$m`t$($st.eff)`t$flags"
        if (-not $H.ContainsKey($k)) { $H[$k] = New-Object 'long[]' 7 }
        $cell = $H[$k]; $cell[0]++; for ($i = 1; $i -le 6; $i++) { $cell[$i] += [long]$f[$i + 3] }
        if ($st.calls -eq 0) { $st.start = $ts } elseif ($ts - $st.end -le 900) { $st.act += $ts - $st.end }
        $st.end = $ts; $st.act += 60; $st.calls += 1; $st.side += [long]$f[11]; $st.sm[$m] += 1
        $st.tok += [long]$f[4] + [long]$f[5] + [long]$f[6] + [long]$f[7]
        if ($first -eq 0 -or $ts -lt $first) { $first = $ts }; if ($ts -gt $lastT) { $lastT = $ts }
      }
    }
  }
  Flush
  $numeric = { param($text, $n) [long]($text.Split("`t")[$n]) }
  $hours = @($H.Keys | Sort-Object { & $numeric $_ 0 }, { & $numeric $_ 1 }, { & $numeric $_ 2 }, { & $numeric $_ 3 } | ForEach-Object { "H`t$_`t" + ($H[$_] -join "`t") })
  [string[]]$sessions = $SessionRows.ToArray(); [Array]::Sort($sessions, [Comparison[string]] { param($x, $y) $r = (& $numeric $x 2).CompareTo((& $numeric $y 2)); if ($r) { $r } else { [string]::CompareOrdinal($x, $y) } })
  $truncated = [Math]::Max(0, $sessions.Count - 20000); if ($truncated) { $sessions = $sessions[$truncated..($sessions.Count - 1)] }
  [string[]]$limits = @($L.Keys | ForEach-Object { "L`t$_`t$($L[$_])" }); [Array]::Sort($limits, [Comparison[string]] { param($x, $y) $r = (& $numeric $x 1).CompareTo((& $numeric $y 1)); if ($r) { $r } else { [string]::CompareOrdinal($x, $y) } })
  $offset = [TimeZoneInfo]::Local.GetUtcOffset([DateTime]::Now); $tz = '{0}{1:00}{2:00}' -f $(if ($offset -lt [TimeSpan]::Zero) { '-' } else { '+' }), [Math]::Abs($offset.Hours), [Math]::Abs($offset.Minutes)
  $lines = @("#v`t1", "#meta`tgenerated=$now`ttz=$tz`tscript=$Version`tfiles=$($files.Count)`tfirst=$first`tlast=$lastT`ttruncated_sessions=$truncated") +
    @(for ($i = 0; $i -lt $models.Count; $i++) { "M`t$i`t$($models[$i])" }) + $hours + $sessions + $limits
  $tsv = ($lines -join "`n") + "`n"

  $plain = New-Object IO.MemoryStream; $gz = New-Object IO.Compression.GZipStream($plain, [IO.Compression.CompressionLevel]::Optimal)
  $data = (New-Object Text.UTF8Encoding($false)).GetBytes($tsv); $gz.Write($data, 0, $data.Length); $gz.Dispose(); $zipped = $plain.ToArray()
  if ($zipped.Length -gt 1400000) { Fail 'The report is too large to upload. Try -Days 90.' }
  $projects = @($sessions | ForEach-Object { $_.Split("`t")[1] } | Sort-Object -Unique).Count
  $callCount = [long]0; foreach ($s in $sessions) { $callCount += [long]$s.Split("`t")[5] }
  Say "Found $($sessions.Count) sessions in $projects projects: $callCount model calls."
  Say "Sends: counts per hour, model names, token totals, effort levels, session lengths and limit-hit times ($([Math]::Floor($zipped.Length / 1024) + 1) KB, encrypted here first)."
  Say "Never sends: your prompts, Claude's replies, file paths or project names."
  if ($DryRun) { Say 'Dry run: this is the whole report, before encryption. Nothing was sent.'; [Console]::Out.Write($tsv); return }
  if (-not $Yes) { $answer = Read-Host 'Continue? [Y/n]'; if ($answer -notmatch '^(|y|yes|j|ja)$') { Say 'Nothing was sent.'; return } }

  # 3. Encrypt (AES-256-CBC, then HMAC-SHA256 over everything before the tag). Two keys are derived
  #    from one random key K, and K goes only into your link.
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $RawKey = New-Object byte[] 32; $IV = New-Object byte[] 16; $rng.GetBytes($RawKey); $rng.GetBytes($IV)
  function Mac([byte[]]$key, [byte[]]$data) { $cell = New-Object Security.Cryptography.HMACSHA256(, $key); try { $cell.ComputeHash($data) } finally { $cell.Dispose() } }
  $EK = Mac $RawKey ([Text.Encoding]::ASCII.GetBytes('shuriken usage report v1 enc')); $MK = Mac $RawKey ([Text.Encoding]::ASCII.GetBytes('shuriken usage report v1 mac'))
  $aes = [Security.Cryptography.Aes]::Create(); $aes.Mode = 'CBC'; $aes.Padding = 'PKCS7'; $aes.Key = $EK; $aes.IV = $IV
  $ct = $aes.CreateEncryptor().TransformFinalBlock($zipped, 0, $zipped.Length)
  $out = New-Object IO.MemoryStream; $out.Write([byte[]](0x53, 0x4B, 0x55, 0x52, 1), 0, 5); $out.Write($IV, 0, 16); $out.Write($ct, 0, $ct.Length)
  $tag = Mac $MK $out.ToArray(); $out.Write($tag, 0, 32); $envelope = $out.ToArray()
  $key = [Convert]::ToBase64String($RawKey).TrimEnd('=').Replace('+', '-').Replace('/', '_')

  # 4. Upload the encrypted bytes. The answer is: ok <id> <delete token> <expiry>.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  try { $text = (Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$Origin/api/public/usage-reports" -ContentType 'application/octet-stream' -Body $envelope).Content }
  catch {
    $resp = $_.Exception.PSObject.Properties['Response']; if ($null -eq $resp -or $null -eq $resp.Value) { Fail "Couldn't reach $Origin. Check your internet connection and run the command again." }
    $msg = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { (New-Object IO.StreamReader($resp.Value.GetResponseStream())).ReadToEnd() }
    Fail "The upload was refused ($([int]$resp.Value.StatusCode)): $(($msg.Trim() -split ' ', 3)[-1])"
  }
  if ($text -is [byte[]]) { $text = [Text.Encoding]::UTF8.GetString($text) }
  $ok, $id, $del, $expires = $text.Trim() -split ' '
  if ($ok -ne 'ok' -or $id -notmatch '^[A-Za-z0-9_-]+$' -or $del -notmatch '^[A-Za-z0-9_-]+$') { Fail "Unexpected answer from $Origin." }
  $lang = if ((Get-Culture).Name -like 'nl*' -or "$env:LANG" -like 'nl*') { '/nl' } else { '' }
  Write-Output ''
  Write-Output "Your report: $Origin$lang$Tool/report#r=$id&k=$key&d=$del"
  Write-Output "Only you can see this. We can't read it: the key never leaves your link."
  Write-Output "Anyone with this link can open the report. It is deleted on $(("$expires" -split 'T')[0])."
}

$code = 0
try { Main } catch { if ("$($_.Exception.Message)" -like 'usage-report: *') { Say "Error: $($_.Exception.Message.Substring(14))"; $code = 1 } else { throw } }
if ($PSCommandPath) { exit $code }

// The other half of the encryption contract (docs/FORMAT.md): opens what the scripts upload, the
// way the dashboard page does in the browser, written here with node:crypto so the tests need
// nothing but Node. The tag is checked before anything is decrypted.
import { createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";

const MAGIC = "SKUR";
const VERSION = 1;
const HEADER = 5;
const IV = 16;
const TAG = 32;

/** The link's fragment: `#r=<report id>&k=<key>&d=<delete token>`. */
export function readFragment(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = (name) => {
    const value = params.get(name);
    return value && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
  };
  return { report: token("r"), key: token("k"), deleteToken: token("d") };
}

/** Opens an envelope with the link's key: { ok: true, text } or { ok: false, reason }. */
export function openEnvelope(envelope, key) {
  const raw = key && /^[A-Za-z0-9_-]+$/.test(key) ? Buffer.from(key, "base64url") : null;
  if (!raw) return { ok: false, reason: "no-key" };
  const bytes = Buffer.from(envelope);
  if (bytes.length < HEADER + IV + 16 + TAG || bytes.subarray(0, 4).toString("latin1") !== MAGIC) {
    return { ok: false, reason: "not-a-report" };
  }
  if (bytes[4] !== VERSION) return { ok: false, reason: bytes[4] > VERSION ? "newer-version" : "not-a-report" };
  if ((bytes.length - HEADER - IV - TAG) % 16 !== 0) return { ok: false, reason: "not-a-report" };
  if (raw.length !== 32) return { ok: false, reason: "bad-key" };
  const label = (text) => createHmac("sha256", raw).update(text).digest();
  const enc = label("shuriken usage report v1 enc");
  const mac = label("shuriken usage report v1 mac");
  const signed = bytes.subarray(0, bytes.length - TAG);
  const tag = bytes.subarray(bytes.length - TAG);
  if (!timingSafeEqual(createHmac("sha256", mac).update(signed).digest(), tag)) return { ok: false, reason: "bad-key" };
  try {
    const decipher = createDecipheriv("aes-256-cbc", enc, bytes.subarray(HEADER, HEADER + IV));
    const plain = Buffer.concat([decipher.update(bytes.subarray(HEADER + IV, bytes.length - TAG)), decipher.final()]);
    return { ok: true, text: gunzipSync(plain).toString("utf8") };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

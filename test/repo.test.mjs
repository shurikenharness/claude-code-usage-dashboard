// The release contract: the two scripts are plain ASCII with LF line ends (so their SHA-256 is the
// same on every system that checks out or downloads them), and one version number runs through
// both scripts, package.json, the changelog and the release tag.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

/** The version each place carries. */
export function versions() {
  return {
    sh: read("report.sh").match(/^SCRIPT=sh-([0-9]+\.[0-9]+\.[0-9]+)$/m)?.[1],
    ps1: read("report.ps1").match(/^\$Version = 'ps1-([0-9]+\.[0-9]+\.[0-9]+)'$/m)?.[1],
    package: JSON.parse(read("package.json")).version,
    changelog: read("CHANGELOG.md").match(/^## \[?v?([0-9]+\.[0-9]+\.[0-9]+)\]?/m)?.[1],
  };
}

describe("the scripts", () => {
  for (const file of ["report.sh", "report.ps1"]) {
    it(`${file} is ASCII with LF line ends and a final newline`, () => {
      const bytes = readFileSync(path.join(root, file));
      assert.ok(bytes.every((byte) => byte === 0x0a || (byte >= 0x20 && byte < 0x7f) || byte === 0x09), `${file} has a non-ASCII or control byte`);
      assert.ok(!bytes.includes(0x0d), `${file} has a CR`);
      assert.equal(bytes.at(-1), 0x0a);
    });
  }

  it("send only to https (or to 127.0.0.1 for these tests)", () => {
    assert.ok(read("report.sh").includes('https://*|http://127.0.0.1:*) ;;'));
    assert.ok(read("report.ps1").includes("'^(https://|http://127\\.0\\.0\\.1:)'"));
  });
});

describe("the version", () => {
  it("is the same in both scripts, package.json and the newest changelog entry", () => {
    const found = versions();
    assert.ok(found.sh, "report.sh has no SCRIPT=sh-x.y.z line");
    for (const [where, version] of Object.entries(found)) assert.equal(version, found.sh, where);
  });

  it("matches the release tag, when this runs for one", () => {
    const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : null;
    if (tag) assert.equal(tag, `v${versions().sh}`);
  });
});

describe("the workflows", () => {
  const dir = path.join(root, ".github", "workflows");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".yml"))) {
    const text = read(path.join(".github", "workflows", file));
    it(`${file} pins every action to a full commit SHA`, () => {
      const unpinned = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)]
        .map((match) => match[1])
        .filter((ref) => !ref.startsWith("./") && !/@[0-9a-f]{40}$/.test(ref));
      assert.deepEqual(unpinned, [], "the release job can write releases; a moved tag must not run in it");
    });
    it(`${file} leaves no token in the checkout`, () => {
      const checkouts = text.match(/uses:\s*actions\/checkout@/g)?.length ?? 0;
      const off = text.match(/persist-credentials:\s*false/g)?.length ?? 0;
      assert.equal(off, checkouts);
    });
  }
});

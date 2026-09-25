import { describe, expect, it } from "vitest";
import { filterPatch, parseAddedLines, parseCommentableLines, touchedFiles } from "../src/diff.ts";

const lines = (patch: string, path: string) => [...(parseCommentableLines(patch).get(path) ?? [])];

describe("parseCommentableLines", () => {
  it("allows added and context lines, not removed ones", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,4 +10,5 @@ function x() {",
      " keep10",
      "-old11",
      "+new11",
      "+new12",
      " keep13",
      " keep14",
    ].join("\n");
    expect(lines(patch, "src/a.ts")).toEqual([10, 11, 12, 13, 14]);
  });

  it("handles several hunks and several files", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+y",
      "@@ -50,2 +50,3 @@",
      " a",
      "+b",
      " c",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -3 +3 @@",
      "-q",
      "+r",
    ].join("\n");
    const map = parseCommentableLines(patch);
    expect([...(map.get("a.ts") ?? [])]).toEqual([1, 50, 51, 52]);
    expect([...(map.get("b.ts") ?? [])]).toEqual([3]);
  });

  it("covers new files, skips deleted files, and uses the new name of a rename", () => {
    const patch = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-bye",
      "diff --git a/old.ts b/renamed.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to renamed.ts",
      "--- a/old.ts",
      "+++ b/renamed.ts",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
    ].join("\n");
    const map = parseCommentableLines(patch);
    expect([...(map.get("new.ts") ?? [])]).toEqual([1, 2]);
    expect(map.has("gone.ts")).toBe(false);
    expect([...(map.get("renamed.ts") ?? [])]).toEqual([1]);
  });

  it("ignores the no-newline marker, CRLF, and a trailing newline", () => {
    const patch = `${[
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,2 @@",
      " a",
      "+b",
      "\\ No newline at end of file",
    ].join("\r\n")}\r\n`;
    expect(lines(patch, "a.ts")).toEqual([1, 2]);
  });

  it("reads a line that starts with +++ inside a hunk as an added line", () => {
    const patch = [
      "diff --git a/a.md b/a.md",
      "--- a/a.md",
      "+++ b/a.md",
      "@@ -1,0 +1,1 @@",
      "+++ not a header",
    ].join("\n");
    expect(lines(patch, "a.md")).toEqual([1]);
  });
});

const TWO_FILES = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,4 +10,5 @@",
  " keep10",
  "-old11",
  "+new11",
  "+new12",
  " keep13",
  " keep14",
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-bye",
  "diff --git a/old.ts b/new.ts",
  "similarity index 100%",
  "rename from old.ts",
  "rename to new.ts",
].join("\n");

describe("parseAddedLines", () => {
  it("keeps only added lines, never context", () => {
    expect([...(parseAddedLines(TWO_FILES).get("src/a.ts") ?? [])]).toEqual([11, 12]);
  });
});

describe("touchedFiles", () => {
  it("lists files with added or removed lines, including deleted files", () => {
    expect(touchedFiles(TWO_FILES)).toEqual(new Set(["src/a.ts", "gone.ts"]));
  });
});

describe("filterPatch", () => {
  it("keeps only the sections of the given files, by old or new name", () => {
    const kept = filterPatch(TWO_FILES, new Set(["gone.ts", "new.ts"]));
    expect(kept).not.toContain("src/a.ts");
    expect(kept).toContain("+++ /dev/null");
    expect(kept).toContain("rename to new.ts");
  });

  it("keeps nothing when no file matches", () => {
    expect(filterPatch(TWO_FILES, new Set(["other.ts"]))).toBe("");
  });
});

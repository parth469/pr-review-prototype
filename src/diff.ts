const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Lines GitHub accepts an inline review comment on (side RIGHT): every added or context line
 * inside a hunk of the new file. Commenting anywhere else makes the whole review call fail.
 */
export function parseCommentableLines(patch: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  let current: Set<number> | undefined;
  let newLine = 0;
  // Lines left in the current hunk, from the @@ header counts. Both zero = between hunks.
  let oldLeft = 0;
  let newLeft = 0;

  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    if (oldLeft > 0 || newLeft > 0) {
      const tag = line[0];
      if (tag === "+") {
        current?.add(newLine++);
        newLeft--;
      } else if (tag === "-") {
        oldLeft--;
      } else if (tag === "\\") {
        // "\ No newline at end of file" belongs to neither side.
      } else {
        // Context line; some tools strip the leading space of an empty one.
        current?.add(newLine++);
        oldLeft--;
        newLeft--;
      }
      continue;
    }

    if (line.startsWith("diff --git ")) {
      current = undefined;
    } else if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      // Deleted files have no new side to comment on.
      current = target === "/dev/null" ? undefined : new Set<number>();
      if (current) result.set(target.replace(/^b\//, ""), current);
    } else {
      const hunk = HUNK.exec(line);
      if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        newLine = Number(hunk[2]);
        newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      }
    }
  }
  return result;
}

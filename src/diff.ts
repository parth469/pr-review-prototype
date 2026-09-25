const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** New-file line numbers per path, with or without the context lines around each change. */
function parseNewLines(patch: string, withContext: boolean): Map<string, Set<number>> {
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
        if (withContext) current?.add(newLine);
        newLine++;
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

/**
 * Lines GitHub accepts an inline review comment on (side RIGHT): every added or context line
 * inside a hunk of the new file. Commenting anywhere else makes the whole review call fail.
 */
export function parseCommentableLines(patch: string): Map<string, Set<number>> {
  return parseNewLines(patch, true);
}

/** Lines the patch really adds or changes; context lines around them are left out. */
export function parseAddedLines(patch: string): Map<string, Set<number>> {
  return parseNewLines(patch, false);
}

/** The patch cut into one section per file, each with every name the file has in it. */
function fileSections(
  patch: string,
): Array<{ text: string; paths: Set<string>; changed: boolean }> {
  const sections: Array<{ lines: string[]; paths: Set<string>; changed: boolean }> = [];
  let section: (typeof sections)[number] | undefined;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      section = { lines: [], paths: new Set(), changed: false };
      sections.push(section);
      inHunk = false;
      const names = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (names?.[1] && names[2] && !line.includes('"')) {
        section.paths.add(names[1]);
        section.paths.add(names[2]);
      }
    }
    if (!section) continue;
    section.lines.push(raw);
    if (line.startsWith("@@")) {
      inHunk = true;
    } else if (!inHunk) {
      const name = /^(?:--- a\/|\+\+\+ b\/|rename from |rename to )(.+)$/.exec(line)?.[1];
      if (name) section.paths.add(name.trim());
    } else if (
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    ) {
      section.changed = true;
    }
  }
  return sections.map((s) => ({ text: s.lines.join("\n"), paths: s.paths, changed: s.changed }));
}

/** Every file a patch names, old and new names alike. */
export function patchFiles(patch: string): Set<string> {
  return new Set(fileSections(patch).flatMap((s) => [...s.paths]));
}

/** Files the patch adds or removes lines in, by every name they have (a deleted file too). */
export function touchedFiles(patch: string): Set<string> {
  return new Set(
    fileSections(patch)
      .filter((s) => s.changed)
      .flatMap((s) => [...s.paths]),
  );
}

/** Only the sections of the patch about one of `paths` (old or new name). */
export function filterPatch(patch: string, paths: Set<string>): string {
  return fileSections(patch)
    .filter((s) => [...s.paths].some((p) => paths.has(p)))
    .map((s) => s.text)
    .join("\n");
}

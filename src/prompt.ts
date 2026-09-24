import { readFile } from "node:fs/promises";

/** Replace {{key}} placeholders. An unknown key is an error, so a typo never reaches Claude. */
export function renderPrompt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    if (!(key in vars)) throw new Error(`Prompt uses {{${key}}}, which has no value`);
    return String(vars[key]);
  });
}

export async function loadPrompt(
  path: string,
  vars: Record<string, string | number>,
): Promise<string> {
  return renderPrompt(await readFile(path, "utf8"), vars);
}

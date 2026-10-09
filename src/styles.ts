import { fileURLToPath } from "node:url";
import type { Style } from "./config.ts";

/** The plugin a style loads: the skill bundled in this repo, or the installed caveman plugin. */
export type PluginId = "bundled" | "caveman";

export interface StyleSpec {
  /** Shown on the status page. */
  label: string;
  /** Skill named on the first line of the prompt; the run fails if it does not load. */
  skill: string;
  plugin: PluginId;
  reviewPrompt: string;
  followUpPrompt: string;
  /** true: findings come in readable parts. false: one free-text body, as before issue #6. */
  structured: boolean;
}

export const STYLE_SPECS: Record<Style, StyleSpec> = {
  readable: {
    label: "New skill + new format",
    skill: "proxy-reviewer:readable-review",
    plugin: "bundled",
    reviewPrompt: "prompts/review.md",
    followUpPrompt: "prompts/follow-up.md",
    structured: true,
  },
  "caveman-readable": {
    label: "Caveman + new format",
    skill: "caveman:caveman-review",
    plugin: "caveman",
    reviewPrompt: "prompts/review.md",
    followUpPrompt: "prompts/follow-up.md",
    structured: true,
  },
  "caveman-classic": {
    label: "Caveman + old format",
    skill: "caveman:caveman-review",
    plugin: "caveman",
    reviewPrompt: "prompts/review-classic.md",
    followUpPrompt: "prompts/follow-up-classic.md",
    structured: false,
  },
};

/** The plugin folder that ships with this repo; independent of the working directory. */
export const BUNDLED_PLUGIN = fileURLToPath(new URL("../plugin", import.meta.url));

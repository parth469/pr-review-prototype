# Proxy Reviewer

A local background process that finds GitHub PRs where you are a requested reviewer, has Claude review them, and posts the review under your account. Architecture: [`docs/architecture.html`](docs/architecture.html).

**Status: M2 (review offline).** It finds review requests, checks out each PR, has Claude review it and saves the findings in `reviews/`. It does not post anything to GitHub yet (M3).

## Requirements
- Node.js 24.15 or newer (see `.node-version`). With nvm-windows: `nvm install 24.21.0` then `nvm use 24.21.0`
- [GitHub CLI](https://cli.github.com/), logged in with `gh auth login`. The daemon reuses that login.
- [Claude Code](https://code.claude.com/), logged in. Reviews use your Claude Code login through the Agent SDK.
- The `caveman` Claude Code plugin (provides `/caveman:caveman-review`), or another skill set in `review.skill` and `review.pluginPath`.

## Setup
```sh
npm ci
npm run once                                  # poll, review what is queued, exit
npm run review -- owner/repo#123              # review one PR now, ignoring skip rules
npm start                                     # poll every 60 s and review in the background
```

## Commands
| Command | What it does |
|---|---|
| `npm start` | Poll loop plus review worker |
| `npm run dev` | Same, restarting on file changes |
| `npm run once` | One poll, review every ready job, exit |
| `npm run review -- owner/repo#123` | Review one PR (also accepts a PR URL) and exit |
| `npm run check` | Type-check, lint and test |
| `npm run format` | Format with Biome |

## Config (`config.json`)
| Field | Default | Meaning |
|---|---|---|
| `pollIntervalSec` | `60` | Seconds between polls (min 30) |
| `repos.allow` | `["*"]` | Repos to review: `*`, `owner/*` or `owner/name` |
| `repos.deny` | `[]` | Repos never reviewed; beats `allow` |
| `skipDrafts` | `true` | Ignore draft PRs |
| `skipOwnPrs` | `true` | Ignore PRs you authored |
| `maxChangedLines` | `3000` | Skip PRs with more added + deleted lines |
| `dataDir` | `data` | Where `state.db` lives |
| `cacheDir` | `cache` | Partial clones, reused between reviews |
| `workDir` | `work` | One checkout per review, removed afterwards |
| `reviewsDir` | `reviews` | Saved review output |
| `logLevel` | `info` | `debug` also shows PRs already seen |
| `review.enabled` | `true` | Turn the review worker off to only detect |
| `review.model` | `claude-opus-5-5` | Claude model |
| `review.effort` | `high` | `low`, `medium`, `high`, `xhigh` or `max` |
| `review.skill` | `caveman:caveman-review` | Skill named on the first line of the prompt |
| `review.promptFile` | `prompts/review.md` | Prompt template (`{{skill}}`, `{{repo}}`, `{{number}}`, `{{sha}}`, `{{baseRef}}`) |
| `review.pluginPath` | `null` | Plugin folder; `null` finds the installed `caveman@caveman` |
| `review.timeoutMin` | `20` | Stop a review after this long |
| `review.maxTurns` | `80` | Stop a review after this many turns |
| `review.maxAttempts` | `3` | Tries before a job is marked `failed` (retries after 5 and 20 min) |
| `review.keepWorktree` | `false` | Keep the checkout for debugging |

## How it works
1. **Detect.** Searches GitHub for `is:pr is:open user-review-requested:@me archived:false` (direct requests only), applies the skip rules and records `(repo, pr, head_sha)` in `data/state.db`. The same commit is only handled once, even across restarts. A newer push supersedes an older commit that is still waiting.
2. **Prepare.** Fetches the PR head into a partial clone under `cache/` and checks it out in its own folder under `work/`, with `.review/diff.patch`, `files.json` and `pr.json`.
3. **Review.** Runs Claude in that folder through the Agent SDK with the prompt from `prompts/review.md`. Findings come back as JSON checked against a schema.
4. **Save.** Writes everything to `reviews/<owner>-<repo>-<pr>-<sha>/`, marks the job `reviewed` and removes the checkout.

Job states: `queued → preparing → reviewing → reviewed`, or `skipped` / `failed`. Jobs interrupted by a crash or shutdown go back to `queued`.

### Review output
| File | Contents |
|---|---|
| `review.md` | Readable summary and findings, most severe first |
| `result.json` | Parsed review, cost, duration, turns, session id |
| `transcript.jsonl` | Every message from the Claude run |
| `prompt.md`, `diff.patch`, `pr.json` | Exactly what Claude was given |

### Safety
- Claude gets only `Read`, `Grep` and `Glob` in the checkout. Everything else is denied.
- No Claude Code settings, hooks or `CLAUDE.md` are loaded from the PR's repo, since a PR could add them. Only the review plugin is loaded.
- Claude runs without any GitHub token in its environment.
- Git never prompts for credentials. The token goes to git through environment variables, not the command line.
- The PR title and description are marked as untrusted in the prompt.

## Layout
```
src/index.ts      entry point: loop, --once, --review, shutdown
src/config.ts     config schema (zod)
src/github.ts     Octokit client, auth via gh
src/filters.ts    skip rules
src/state.ts      SQLite job store and migrations (node:sqlite)
src/poller.ts     poll once / poll loop with backoff
src/git.ts        non-interactive git runner
src/workspace.ts  partial clone, per-review checkout, cleanup
src/prompt.ts     prompt template rendering
src/reviewer.ts   Claude Agent SDK run, output schema
src/report.ts     review.md rendering
src/worker.ts     job processing, retries, output files
prompts/review.md review prompt
test/             vitest tests
```

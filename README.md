# Proxy Reviewer

A local background process that finds GitHub PRs where you are a requested reviewer, has Claude review them, and posts the review under your account. Architecture: [`docs/architecture.html`](docs/architecture.html).

**Status: M4 (runs unattended).** It finds review requests, checks out each PR, has Claude review it, and posts the review to the PR under your account: a summary plus one inline comment per finding.

## Requirements
- Node.js 24.15 or newer (see `.node-version`). With nvm-windows: `nvm install 24.21.0` then `nvm use 24.21.0`
- [GitHub CLI](https://cli.github.com/), logged in with `gh auth login`. The daemon reuses that login.
- [Claude Code](https://code.claude.com/), logged in. Reviews use your Claude Code login through the Agent SDK.
- The `caveman` Claude Code plugin (provides `/caveman:caveman-review`), or another skill set in `review.skill` and `review.pluginPath`.

## Setup
```sh
npm ci
npm run once                                  # poll, review what is queued, exit
npm run review -- owner/repo#123              # review and post one PR now, ignoring skip rules
npm start                                     # poll every 60 s and review in the background
```

## Run in the background (Windows)
```sh
npm run service -- install      # register the logon task and start it now
npm run status                  # task, processes, recent jobs, log file
npm run service -- stop         # stop it (it comes back at next logon)
npm run service -- start        # start it again
npm run service -- uninstall    # stop it and remove the task
npm run service -- test-notify  # show a sample desktop notification
```
- **Starts by itself.** A Task Scheduler task named "Proxy Reviewer" starts 30 s after you log on, runs as you with no window, and never needs admin rights. It only runs while you are logged on, because it uses your `gh` and Claude logins.
- **Restarts itself.** A small supervisor restarts the server after a crash (5 s, 15 s, 1 min, then every 5 min). If startup checks fail (for example, no network yet or logged out of `gh`), it retries more slowly and sends one notification with the reason.
- **One at a time.** A lock file stops a second server. `npm start` while the service runs says "already running".
- **Notifications.** A Windows notification appears when a review is posted ("Requested changes · owner/repo#12") or when a job fails for good. Click it to open the PR.
- **Logs.** `logs/proxy-reviewer.<date>.N.log` (server) and `logs/supervisor.<date>.N.log`, rotated daily or at 10 MB, keeping the last 7.
- **Sleep.** Nothing runs while the PC sleeps. On wake the next poll picks up whatever is waiting.

## Commands
| Command | What it does |
|---|---|
| `npm start` | Poll loop plus review worker |
| `npm run dev` | Same, restarting on file changes |
| `npm run once` | One poll, review every ready job, exit |
| `npm run review -- owner/repo#123` | Review and post one PR (also accepts a PR URL) and exit |
| `node src/index.ts --publish-only <jobId>` | Post a saved review again without re-running Claude |
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
| `gitTimeoutSec` | `300` | Kill a git command (and its helpers) that runs longer than this |
| `logDir` | `logs` | Where log files go |
| `notify.enabled` | `true` | Desktop notifications on/off |
| `notify.onPosted` | `true` | Notify when a review is posted |
| `notify.onFailed` | `true` | Notify when a job gives up after its last attempt |
| `publish.mode` | `submit` | `submit` posts at once · `pending` leaves a draft only you can see · `dry-run` posts nothing and writes the payload |
| `publish.requireStillRequested` | `true` | Don't post if you are no longer a requested reviewer (for example, you already reviewed by hand). `--review` ignores this |

## How it works
1. **Detect.** Searches GitHub for `is:pr is:open user-review-requested:@me archived:false` (direct requests only), applies the skip rules and records `(repo, pr, head_sha)` in `data/state.db`. The same commit is only handled once, even across restarts. A newer push supersedes an older commit that is still waiting.
2. **Prepare.** Fetches the PR head into a partial clone under `cache/` and checks it out in its own folder under `work/`, with `.review/diff.patch`, `files.json` and `pr.json`.
3. **Review.** Runs Claude in that folder through the Agent SDK with the prompt from `prompts/review.md`. Findings come back as JSON checked against a schema.
4. **Save.** Writes everything to `reviews/<owner>-<repo>-<pr>-<sha>/`, marks the job `reviewed` and removes the checkout.
5. **Publish.** Posts one review against the reviewed commit:
   - **Request changes** when there is at least one 🔴 bug or 🟡 risk. Only 🔵 nits and ❓ questions, or nothing found, posts a plain **Comment**. It never approves.
   - On your own PR it always posts a Comment, because GitHub does not allow requesting changes there.
   - Findings on lines in the diff become inline comments; the rest are listed in the review body.
   - It posts nothing if the PR was closed or merged, has a newer commit, or no longer requests your review.
   - A hidden marker in the body means a restart or retry finds the earlier review instead of posting a second one.
   - If GitHub rejects an inline comment position, it posts again with every finding in the body.

Job states: `queued → preparing → reviewing → reviewed → posting → done`, or `skipped` / `failed`. A failed post retries as `reviewed` without running Claude again. Jobs interrupted by a crash or shutdown resume where they stopped.

### Review output
| File | Contents |
|---|---|
| `review.md` | Readable summary and findings, most severe first |
| `review-payload.json` | Exactly what was sent to GitHub |
| `posted.json` | GitHub review id, URL and state |
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
src/diff.ts       lines of the diff that can take a comment
src/publish.ts    builds the GitHub review from the findings
src/publisher.ts  de-duplication, relevance checks, posting
src/worker.ts     job processing, retries, output files
src/preflight.ts  startup checks with a fix for each problem
src/lock.ts       single-instance lock
src/notify.ts     Windows desktop notifications
src/supervisor.ts restarts the server with backoff
src/service.ts    Task Scheduler install / start / stop / status
prompts/review.md review prompt
test/             vitest tests
```

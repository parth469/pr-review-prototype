# Proxy Reviewer

A local background process that finds GitHub PRs where you are a requested reviewer, has Claude review them, and posts the review under your account. Architecture: [`docs/architecture.html`](docs/architecture.html).

**Status: M1 (detect).** It finds review requests, applies skip rules and records each PR commit once. It does not review or post anything yet.

## Requirements
- Node.js 24.15 or newer (see `.node-version`). With nvm-windows: `nvm install 24.21.0` then `nvm use 24.21.0`
- [GitHub CLI](https://cli.github.com/), logged in with `gh auth login`. The daemon reuses that login.

## Setup
```sh
npm ci
npm run once     # one poll, print what was found, exit
npm run dev      # poll every 60 s, restart on file changes
npm start        # poll every 60 s
```

## Commands
| Command | What it does |
|---|---|
| `npm run once` | Single poll, then exit |
| `npm run dev` | Poll loop with `--watch` |
| `npm start` | Poll loop |
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
| `logLevel` | `info` | `debug` also shows PRs already seen |

## How it works
1. Searches GitHub for `is:pr is:open user-review-requested:@me archived:false` (direct requests only, not team requests).
2. Loads each PR's head commit, draft flag, author and size.
3. Applies the skip rules above.
4. Records `(repo, pr, head_sha)` in `data/state.db` as `queued` or `skipped`. The same commit is only reported once, even across restarts. A skipped PR that becomes eligible (for example, a draft marked ready) is requeued.

## Layout
```
src/index.ts     entry point, --once, shutdown
src/config.ts    config schema (zod)
src/github.ts    Octokit client, auth via gh
src/filters.ts   skip rules
src/state.ts     SQLite job store (node:sqlite)
src/poller.ts    poll once / poll loop with backoff
test/            vitest unit tests
```

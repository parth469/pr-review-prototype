# Proxy Reviewer

A local background process that finds GitHub PRs where you are a requested reviewer, has Claude review them, and posts the review under your account. Architecture: [`docs/architecture.html`](docs/architecture.html).

**Status: M6 (follow-up review).** It finds review requests, checks out each PR, has Claude review it, and posts the review to the PR under your account: a summary plus one inline comment per finding. When the author pushes fixes and asks for your review again, it checks each earlier finding, replies in its thread, and approves or asks only for what is still open. Design: [`docs/follow-up-review.html`](docs/follow-up-review.html).

Each finding is written so a person can judge it and an AI tool can fix it: a plain title, what's wrong, what happens if it's not fixed, the fix (with a one-click GitHub suggestion when safe), and the reasoning folded underneath. Three review styles can be picked on the status page; why, what each costs and what we picked: [`docs/review-styles.html`](docs/review-styles.html).

A review that would **request changes** waits on the status page for your OK first: post it, drop findings you disagree with, take your time or discard it. If you do nothing, it posts as it is after 30 minutes. Design, decisions and what is left for later: [`docs/hold-for-your-ok.html`](docs/hold-for-your-ok.html).

## Requirements
- Node.js 24.15 or newer (see `.node-version`). With nvm-windows: `nvm install 24.21.0` then `nvm use 24.21.0`
- [GitHub CLI](https://cli.github.com/), logged in with `gh auth login`. The daemon reuses that login.
- [Claude Code](https://code.claude.com/), logged in. Reviews use your Claude Code login through the Agent SDK.
- Only for the two caveman review styles: the `caveman` Claude Code plugin (provides `/caveman:caveman-review`). The default style uses the skill in `plugin/`, which ships with this repo.

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
- **Notifications.** A Windows notification appears when a review is posted ("Requested changes · owner/repo#12"), when one waits for your OK ("Needs your OK · owner/repo#12", click to open it on the status page), or when a job fails for good. Click the others to open the PR.
- **Logs.** `logs/proxy-reviewer.<date>.N.log` (server) and `logs/supervisor.<date>.N.log`, rotated daily or at 10 MB, keeping the last 7.
- **Sleep.** Nothing runs while the PC sleeps. On wake the next poll picks up whatever is waiting.

## Status page
Open **http://localhost:4777** while the server runs. It lists recent PRs with their status, findings, cost and a link to the posted review, and refreshes every 5 s. Click a row to read the full review.

| Button | Shown for | What it does |
|---|---|---|
| **Retry** | failed | Tries again. A saved review is only posted, not re-run. |
| **Re-review** | posted, waiting, failed | Runs Claude again on the same commit. If a review of that commit is already on GitHub, it is not posted twice. An older commit of a PR that has moved on is marked superseded. |
| **Review now** | skipped | Reviews it anyway, ignoring the skip rule (draft, too large...). |
| **Post** | needs your OK | Posts it now, without the findings you dropped. |
| **I'll handle it** | needs your OK, timer running | Stops the timer; it waits until you press Post or Discard. |
| **Discard** | needs your OK | Posts nothing for this commit. |
| **Drop / Keep** | each new finding of a review that needs your OK | Leaves the finding out of the post (the author never sees it), or puts it back. Saved at once; the timer uses your choices. |
| **Pause posting / Resume** | header | While paused, reviews still run and wait unposted. Resume posts them. Survives restarts. |

The header also has **Model**, **Effort** and **Style** pickers for the next review. Style is how findings are written: *New skill + new format* (default), *Caveman + new format* or *Caveman + old format*. A pick applies from the next review on, survives restarts, and a running review keeps what it started with. See [`docs/review-styles.html`](docs/review-styles.html). **Wait for OK** sets how long a review that would request changes waits for you: Off, 15, 30 min, 1 h or 2 h. A review already waiting keeps its time.

It listens on 127.0.0.1 only. Buttons need a secret token that is only in the page, and requests for other host names are refused, so other websites open in your browser can't press them. Turn it off or move it with `statusPage.enabled` and `statusPage.port`.

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
| `skipBranches` | `[]` | Head branches never reviewed, e.g. release merges: exact names or a prefix ending in `*`, any case. This repo's `config.json` skips `staging`, `dev` and `cycle-*` |
| `maxChangedLines` | `3000` | Skip PRs with more added + deleted lines |
| `dataDir` | `data` | Where `state.db` lives |
| `cacheDir` | `cache` | Partial clones, reused between reviews |
| `workDir` | `work` | One checkout per review, removed afterwards |
| `reviewsDir` | `reviews` | Saved review output |
| `logLevel` | `info` | `debug` also shows PRs already seen |
| `review.enabled` | `true` | Turn the review worker off to only detect |
| `review.model` | `claude-opus-5-5` | `claude-opus-5-5` or `claude-sonnet-5-5`. Default only: a pick on the status page wins |
| `review.effort` | `high` | `low`, `medium` or `high`. Default only, like `model` |
| `review.maxSessionUsagePct` | `90` | Reviews wait in the queue while the 5-hour session usage is at or above this percent, until the window resets. `null` = never |
| `review.style` | `readable` | `readable` (new skill + new format), `caveman-readable` or `caveman-classic` (the format before issue #6). Default only, like `model`. Each style's skill, plugin and prompts are in `src/styles.ts` |
| `review.pluginPath` | `null` | Caveman plugin folder, for the caveman styles; `null` finds the installed `caveman@caveman` |
| `review.timeoutMin` | `20` | Stop a review after this long |
| `review.maxTurns` | `80` | Stop a review after this many turns |
| `review.maxAttempts` | `3` | Tries before a job is marked `failed` (retries after 5 and 20 min) |
| `review.keepWorktree` | `false` | Keep the checkout for debugging |
| `gitTimeoutSec` | `300` | Kill a git command (and its helpers) that runs longer than this |
| `logDir` | `logs` | Where log files go |
| `statusPage.enabled` | `true` | Serve the status page |
| `statusPage.port` | `4777` | Its port (on 127.0.0.1) |
| `notify.enabled` | `true` | Desktop notifications on/off |
| `notify.onPosted` | `true` | Notify when a review is posted |
| `notify.onFailed` | `true` | Notify when a job gives up after its last attempt |
| `notify.onHeld` | `true` | Notify when a review waits for your OK |
| `publish.mode` | `submit` | `submit` posts at once · `pending` leaves a draft only you can see · `dry-run` posts nothing and writes the payload |
| `publish.holdMin` | `30` | A review that would request changes waits this many minutes for your OK, then posts as it is. `0` = post at once. Default only: the **Wait for OK** pick on the status page wins. `--review` never waits |
| `publish.requireStillRequested` | `true` | Don't post if you are no longer a requested reviewer (for example, you already reviewed by hand). `--review` ignores this |
| `followUp.enabled` | `true` | Check earlier findings when a PR you reviewed asks for you again. Off: every commit gets a full review |
| `followUp.approve` | `submit` | `submit` approves at once · `pending` leaves every approval as a draft for you |
| `followUp.explainedBugNeedsYou` | `false` | `true`: a 🔴 bug the author explained instead of fixing waits as an approval draft for you. `false`: a reason that holds approves |
| `followUp.explainedRiskNeedsYou` | `false` | The same for an explained 🟡 risk |
| `followUp.maxAutoRounds` | `3` | Later rounds are only posted as a draft for you |
| `followUp.freshReviewOverLines` | `1000` | A push this big since the last review (counting only files in the PR) gets a full review instead. Earlier open bugs and risks are listed in it and checked next round |
| `followUp.resolveThreads` | `true` | Resolve threads whose finding is fixed, explained or gone |
| `ticket.enabled` | `true` | Give Claude the PR's Linear ticket and check round 1 against it (see Ticket context) |
| `ticket.maxChars` | `8000` | The ticket text is cut down to this many characters, about 2,000 tokens |

## How it works
1. **Detect.** Searches GitHub for `is:pr is:open user-review-requested:@me archived:false` (direct requests only), applies the skip rules and records `(repo, pr, head_sha)` in `data/state.db`. The same commit is only handled once, even across restarts. A newer push supersedes an older commit that is still waiting.
2. **Prepare.** Fetches the PR head into a partial clone under `cache/` and checks it out in its own folder under `work/`, with `.review/diff.patch`, `files.json` and `pr.json`.
3. **Review.** Runs Claude in that folder through the Agent SDK with the prompt from `prompts/review.md`. Findings come back as JSON checked against a schema.
4. **Save.** Writes everything to `reviews/<owner>-<repo>-<pr>-<sha>/`, marks the job `reviewed` and removes the checkout.
5. **Publish.** Posts one review against the reviewed commit:
   - **Request changes** when there is at least one 🔴 bug or 🟡 risk. Only 🔵 nits and ❓ questions, or nothing found, **approves**; the nits stay as inline comments. Nits and questions never block.
   - A Request changes (round one or later) first **waits for your OK** on the status page, for `publish.holdMin` minutes. You can post it, drop findings, stop the timer or discard it; with findings dropped the event is worked out again, so dropping every bug and risk approves. When the timer runs out it posts with your choices so far. If it ran out while the PC slept, you get a fresh wait instead. Dropped findings never reach GitHub or later rounds; the AI's original stays in `result.ai.json`.
   - On your own PR it always posts a Comment, because GitHub does not allow approving or requesting changes there.
   - Findings on lines in the diff become inline comments; the rest are listed in the review body.
   - It posts nothing if the PR was closed or merged, has a newer commit, or no longer requests your review.
   - A hidden marker in the body means a restart or retry finds the earlier review instead of posting a second one.
   - If GitHub rejects an inline comment position, it posts again with every finding in the body.

### Ticket context
Claude also gets the Linear ticket the PR is for, so a change the ticket asked for isn't called wrong (issue #3).
- **Where from.** Linear's GitHub app comments on every PR linked to an issue, with each issue's title and description. That comment is read; no Linear key is needed. It needs linkbacks turned on in Linear's GitHub settings. With several linked tickets, the one in the branch name (`parth/kgit-1316-…`) comes first.
- **Cleaned.** Lines still equal to the unfilled KGIT Bug, Story or Task template are removed. A ticket that was only the template gives its title alone. Long tickets are cut to `ticket.maxChars`, key sections (goal, acceptance criteria, scope) first.
- **Read once.** Saved per PR in `state.db` and reused every round, so each round sees the same text. With no ticket found, the next round looks again. **Refresh ticket** on the status page reads it again on the next review.
- **Round 1 only.** Round 1 checks the code against the ticket: a contradiction becomes a ❓ question, never a blocker, and things the ticket asks for that this PR doesn't touch are not reported (tickets are often split across PRs). Later rounds use it only as background.
- **No ticket.** Claude reviews the code for problems only. The status page says "No ticket found"; nothing about it goes to GitHub.

### Follow-up review (round 2+)
When a new commit comes in on a PR whose earlier review is on GitHub, the job becomes a follow-up (R2, R3... on the status page).
1. **Gather.** Loads the earlier findings (numbered F1, F2... in every review), the replies in their threads, PR comments since then, and the changes since the reviewed commit, into `.review/previous.json`, `threads.json` and `since-last.patch`. After a force-push the whole PR diff is used.
2. **Verify.** Claude, locked down as in round one, gives each earlier finding one verdict: fixed, partly fixed, explained, no longer applies or not fixed, plus a short reply. It reviews only the new changes for new problems.
3. **Check.** Plain code checks the answer. A missing or unknown finding id fails the run and retries. Otherwise a claim that does not hold counts as not fixed:
   - "Fixed" and "partly fixed" must cite a line the new commits really add (not a context line next to a change).
   - "No longer applies" needs a change to the finding's file.
   - "Explained" needs a reply from the PR author in the finding's thread, or a PR comment that names its id (F2...). Every finding shows its id for this.
   - Only files in the PR count as changes, so merging the base branch in does not "fix" anything.
   - A 🔴/🟡 fixed only in another file, or fixed after a force-push, holds but goes to you (below).
4. **Decide.** `src/decide.ts`, not Claude, picks the event:
   - Every finding carries `mustFix`: always true for a 🔴 bug, true for a 🟡 risk only when it is serious (security, data loss, a crash, broken behaviour in production). Round one requests changes for any bug or risk; from round two on only `mustFix` findings block, so round two usually approves.
   - A `mustFix` finding not fixed or partly fixed (and not explained), or a new `mustFix` finding in the new commits: **Request changes**. A minor risk left open is settled: it is never checked or raised again.
   - CI plays no part: red or running checks never hold back an approval and are never mentioned.
   - An explained finding whose reason holds: **Approve**. With `explainedBugNeedsYou`/`explainedRiskNeedsYou` on, it waits as an **Approve draft** for you instead.
   - A `mustFix` fix the checks above could not confirm: an **Approve draft** only you can see, and a "Needs your OK" notification. Submitting it accepts the fix. If you delete it instead, the finding is checked again next round.
   - Otherwise: **Approve**. Minor risks, nits and questions never block a follow-up. The body says what is left is non-blocking.
   - Your own PR: Comment. After `maxAutoRounds`: a draft for you.
   - To overrule it, press **Approve** on the status page. It shows only on a posted follow-up (a re-requested review) that is not an approval yet. It submits the draft left for your OK as the approval, or posts a new approving review.
5. **Post.** Creates the review as pending, replies in each finding's thread (skipped nits get no reply, only an "optional" row in the table), submits, then resolves the threads that are done. A crash midway resumes the same pending review without duplicate replies.

GitHub allows one pending review per person per PR. While you have one on a PR (a draft left for you, or a review you started by hand), its jobs wait and re-check every 15 min, without running Claude or using attempts. The status page shows why.

Reviews posted before M6 have no finding markers; round two then matches your comments by file and line.

Job states: `queued → preparing → reviewing → reviewed → posting → done`, or `skipped` / `failed`. A review that would request changes goes `posting → held` and waits for your OK, then back to `posting`. A failed post retries as `reviewed` without running Claude again. Jobs interrupted by a crash or shutdown resume where they stopped.

### Review output
| File | Contents |
|---|---|
| `review.md` | Readable summary and findings, most severe first |
| `result.ai.json` | The AI's review before you dropped findings; only when you dropped some |
| `review-payload.json` | Exactly what was sent to GitHub |
| `posted.json` | GitHub review id, URL, state, and the thread of each inline finding |
| `result.json` | Parsed review, cost, duration, turns, session id |
| `transcript.jsonl` | Every message from the Claude run |
| `prompt.md`, `diff.patch`, `pr.json` | Exactly what Claude was given |
| `ticket.json` | The PR's ticket as Claude got it; only when one was found |
| `previous.json`, `threads.json`, `since-last.patch` | Follow-ups only: the earlier findings, replies and changes Claude checked |

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
src/publisher.ts  de-duplication, relevance checks, posting, follow-up replies and submit
src/followup.ts   round two: finding ledger, thread matching, .review inputs, verdict checks
src/decide.ts     the approval rule for follow-ups
src/worker.ts     job processing, retries, output files
src/preflight.ts  startup checks with a fix for each problem
src/lock.ts       single-instance lock
src/notify.ts     Windows desktop notifications
src/supervisor.ts restarts the server with backoff
src/service.ts    Task Scheduler install / start / stop / status
src/runtime.ts    live facts for the page (last poll, pause setting)
src/web/server.ts status page HTTP server and API
src/web/page.ts   status page HTML
prompts/review.md review prompt
prompts/follow-up.md follow-up (round 2+) prompt
test/             vitest tests
```

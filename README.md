# Durable Factory

A small AI software factory that runs on your own computer. You describe a code change in plain English. A planner, a builder and a reviewer (Claude models) plan it, build it, run your tests and review it on a separate git branch. Then the factory **waits for you** to approve, decline or send it back. Every step is checkpointed to SQLite by [Durable Pi](https://github.com/disler/durable-pi), so you can `kill -9` it at any point and it carries on from where it stopped.

Companion code for the article *I Built an AI Software Factory You Can Unplug*.

**Quick start**

```bash
git clone https://github.com/DavidROliverBA/durable-factory && cd durable-factory
bun run setup     # once: fetches durable-pi beside this folder and patches it
bun start         # free practice mode, no API key → http://localhost:4791/factory
bun run live      # real Claude agents (needs an Anthropic API key, see USAGE.md)
```

> **Safety.** The agents read files and run shell commands, and the factory runs your test command, inside a git worktree under `~/.dpi-lab/runs/`. That limits where they write, but it is not a sandbox: only point it at repos you trust, with a budget and an API spend limit set. Nothing is merged into your branches for you.

---

## Crash Lab

**New here? Read [USAGE.md](USAGE.md)** for how to use the factory day to day. This README covers how it works.

A visual demo for [disler/durable-pi](https://github.com/disler/durable-pi). It runs a **real `dpi-backend`** as a child process. You can `kill -9` that process from the browser and watch durable agent work survive.

```
browser ──► bun server.ts (:4791) ──supervises──► node dpi-backend (:4790) ──► ~/.dpi-lab/backend/**/agent.sqlite
              │  /api/* proxy (injects bearer token)
              └  /lab/* kill · start · crash-restart · auto-restart · reset
```

## Run

You need [Bun](https://bun.sh), Node.js 22+ with npm (the backend ships `package-lock.json`), and git.

```bash
git clone https://github.com/DavidROliverBA/durable-factory && cd durable-factory
bun run setup     # clones disler/durable-pi beside this folder, pins it, applies patches/durable-pi-factory.patch, installs deps
bun start         # → http://localhost:4791  (free practice mode, no key)
```

The lab uses the backend's **faux** model by default: free, offline and deterministic (`!cmd` runs bash). To use a real model, run `LAB_PROVIDER=openrouter OPENROUTER_API_KEY=sk-or-... bun start`.

Data lives in `~/.dpi-lab/`, outside iCloud. The **⟲ reset** button wipes it.

## Scenarios

| # | What runs | Do this | What you'll see |
|---|---|---|---|
| 1 | `change-watch` job: 12 checks, one checkpoint each | **kill -9** at around check 5, then **start** | The timeline shows a red "dead" band, then the checks carry on from 5, not 1. The job reports *survived 1 crash* |
| 2 | `release-check` job: plan → subagent gather → **approve** → publish | Kill the server while it waits, leave it dead, start it, then approve | The approval wait is a durable task, so it is still waiting after the restart. It publishes exactly once |
| 3 | A 15-step `bash` loop | Kill it around step 6 | After the restart, the tool result is marked **INTERRUPTED · may have partially run**. It is not silently re-run |
| 4 | Free-form composer | | Talk to the agent |

Panels: the durable job pipeline and timeline, the live transcript (with streaming tool output), pi-durable's live task graph, the supervisor log, and the raw SSE wire events. The wire events show `hello → snapshot` after every reconnect: streams never replay, and a fresh snapshot from SQLite is the whole recovery story.

Env overrides: `LAB_PORT` (4791), `LAB_BACKEND_PORT` (4790), `LAB_HOME` (`~/.dpi-lab`), `DPI_REPO` (`../durable-pi`), `LAB_REPOS_DIR` (the folder holding this lab: the repos offered in the factory form).

---

# Durable Factory — `http://localhost:4791/factory`

An agent-factory-style SDLC workflow (plan, build, test, review) as one durable Durable Pi job. You type a request against a repo, and it runs:

```
Intake → Plan → Commit plan → Build → Test ⟲ fix (≤3) → Review ⟲ revise (≤2) → Approve (you) → Ship → Report
```

Each run gets its own git worktree (`~/.dpi-lab/runs/<id>/repo`, branch `factory/<id>`) and its own Durable Pi session. Runs go in parallel.

| Rule (enforced by code) | How |
|---|---|
| Write scope per role | A git tree snapshot is taken before each agent turn (memoised, so it survives a crash). Changes outside scope are rolled back and fail the run. The planner may write only `plan.md`, the reviewer nothing, and the builder never tests. |
| Claims match reality | Each agent writes a JSON result (`envelopes.ts`). `changedFiles` must equal that step's real diff. A mismatch goes back to the same durable conversation, up to 3 turns. |
| Bounded loops | 3 test attempts and 2 revisions, then it fails closed with the branch left for inspection |
| Budget | Model spend is checked before every agent turn |
| Human approval | A durable wait: approve, decline, or **send back with a note** (re-enters Review) |
| No double effects | The base commit, test results, commits, push and PR are memoised in the run record |

**Modes:** *scripted* (default, no key): the faux model runs fixed scripts (`factory/scripted.ts`) through the same machinery, on the `greeter` fixture. They take one wrong turn on purpose, so both loops run. Add `[breach]` to the request to see the write-scope guard. *Live*: `bun run live` (the Anthropic key comes from `ANTHROPIC_API_KEY` in the environment or a git-ignored `.env.local`, or on macOS from the Keychain item `durable-pi-lab-anthropic`; set `LAB_KEYCHAIN_SERVICE` to use another item name) (planner and reviewer on Opus 5.5, builder on Sonnet 5.5; override with `FACTORY_PLANNER_MODEL` / `FACTORY_BUILDER_MODEL` / `FACTORY_REVIEWER_MODEL`). `LAB_PROVIDER=openrouter` also works.

Desktop notifications (macOS, or Linux with `notify-send`) fire when a run needs your decision, ships, or fails.

### Files
- `factory/sdlc.ts`: the workflow as a durable job (loaded into dpi-backend via `DPI_JOB_MODULES`)
- `factory/roles.ts`: planner, builder and reviewer: tools, write scope, instructions, models
- `factory/envelopes.ts`: typed results, validated without dependencies
- `factory/scripted.ts`: the faux-mode scripts
- `factory/routes.ts`: lab API: worktree, session and job creation, diff, approval, agent transcripts, notifications
- `public/factory.html`: the factory floor

### Changes to durable-pi (`patches/durable-pi-factory.patch`, applied by `bun run setup` as branch `factory` in `../durable-pi`)
`registerJob()` and `DPI_JOB_MODULES`; keyed sub-agents with their own tools, instructions and model; `Phase.memo` / `Phase.cost`, and a `shell` timeout; approvals with **send back** (`sendBackTo`); `DPI_PROVIDER=anthropic`. Upstream's tests still pass.

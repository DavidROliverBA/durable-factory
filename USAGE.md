# How to use the Durable Factory

You describe a code change. Three AI agents plan it, build it, test it and review it on a separate branch. Then the factory **waits for you**. Nothing is committed to your work until you approve it, and it is never merged for you.

## 1. Start it

```bash
cd durable-factory
bun run live      # real Claude agents, using your Anthropic API key (see "Your API key" below)
bun start         # or: free practice mode with no key and no cost (scripted agents, greeter repo only)
```

Open **http://localhost:4791/factory**. The header shows **live · anthropic** or **scripted · faux model**. Stop the lab with `Ctrl-C`. Runs that haven't finished carry on from where they stopped the next time you start it.

> First time: run `bun run setup` once before starting. It needs Bun, Node.js 22+ and git.

### Your API key

Live mode needs an Anthropic API key from https://console.anthropic.com. Set a monthly spend limit on it there. Give it to the lab in one of three ways:

- **macOS Keychain** (recommended on a Mac; the key never sits in a file):
  `security add-generic-password -a "$USER" -s durable-pi-lab-anthropic -w` (it prompts for the key, so it never lands in your shell history). To use a different item name, put `LAB_KEYCHAIN_SERVICE=<name>` in `.env.local`.
- **`.env.local`** in the lab folder (git-ignored): `ANTHROPIC_API_KEY=sk-ant-...`
- **Environment:** `ANTHROPIC_API_KEY=sk-ant-... bun run live`

## 2. Make a request

Fill in the form at the top of the page:

| Field | What to put |
|---|---|
| **Repo** | Any git repo in the folder that holds the lab (set `LAB_REPOS_DIR` to use another folder), or **greeter (fixture)**, a tiny practice repo |
| **Request** | The change you want, in plain English (tips below) |
| **Test command** | The command that proves the code works, e.g. `bun test`, `npm test`, `uv run pytest`. If you leave it blank, the factory uses `bun test` when the repo has a `package.json`, and **otherwise no tests at all**, so set it for anything that isn't a JS/TS repo |
| **Ship** | **branch**: leave the finished work on a branch for you to merge (the safe default). **pr**: push the branch and open a GitHub pull request |
| **Budget ($)** | The run stops if model spend passes this. $5 is plenty; small changes cost $0.20–$2 |

**Writing a good request**
- Name one change with a clear finish line: *"Add a `--dry-run` flag to the sync command that prints what it would do without writing anything."*
- Say what "done" means when it isn't obvious: *"…and the existing tests must still pass."*
- Keep it to one job. *"Refactor everything and add three features"* will run out of revisions.
- The agents can't change test files, CI config (`.github/`) or `factory.config.yaml`. If your change needs new tests, write them yourself first and commit them; then the factory builds the code to make them pass. This works well.

## 3. Watch it work

Each request becomes a card moving across the board:

**Plan → Build → Test ⟲ fix → Review ⟲ revise → Waiting for you → Shipped** (or **Stopped** if it failed or you declined)

Click a card to see:
- **Timeline**: each step with its timing. Red bands mark times the server was down.
- **Agents**: the full conversation of each agent: planner 📐, builder 🔨, reviewer 🔍.
- **Diff**: exactly what has changed so far.

What happens automatically:
- **Tests fail?** The builder gets the failure output and fixes the code, up to 3 attempts.
- **Reviewer asks for changes?** The builder revises, up to 2 times.
- **The builder can't fix a finding** without breaking the rules? The finding goes to you instead of being forced through.
- **An agent touches a file it shouldn't?** The change is undone and the run stops.

You'll get a macOS notification when a run needs you, ships or fails. You can close the browser tab: runs keep going in the background.

## 4. Decide

When a card reaches **Waiting for you**, open it. The **⏸ Your decision** tab shows the reviewer's verdict and findings. Check the **Diff** tab too. Then choose:

- **✓ Approve & ship**: the change is committed to the run's branch (or pushed as a PR).
- **↩ Send back with a note**: type what you want changed, e.g. *"also handle an empty name"*. The builder acts on your note, the tests run again, the reviewer looks again, and it comes back to you.
- **✕ Decline**: stop. Nothing is committed.

The decision waits for you indefinitely, even across restarts.

## 5. After it ships

The work is on a branch called `factory/<run-id>` in the repo you chose. Your own checkout isn't touched. To take it:

```bash
cd <your repo>
git log --oneline main..factory/<run-id>     # see what it did: a plan commit, then the change
git merge factory/<run-id>                   # or cherry-pick, or open a PR yourself
```

Clean up when you're done with a run:

```bash
git worktree remove ~/.dpi-lab/runs/<run-id>/repo
git branch -D factory/<run-id>                # only if you didn't merge it
```

## The crash buttons (optional)

The header has **💥 kill -9** and **▶ start** buttons. They hard-kill the server underneath the factory, as a power cut would. Use them to see the durability: kill the server mid-build, start it again, and the run carries on from its last checkpoint. It doesn't start over or redo anything that already happened. The original Crash Lab demo is at http://localhost:4791/.

## Costs

- Planner and reviewer use **Claude Opus 5.5**; the builder uses **Sonnet 5.5**.
- The greeter practice run costs about **$0.17**. Expect **$0.50–$2** on a real repo, more if it needs several fix or revision rounds.
- Each run's spend so far is shown on its card and in its detail view. The budget field is a hard stop.
- Your Anthropic console also has a monthly spend limit on the key, as a backstop.

## When something goes wrong

| You see | Do this |
|---|---|
| Header says **scripted · faux model** after `bun run live` | No key was found. On a Mac, check the Keychain item with `security find-generic-password -s durable-pi-lab-anthropic` (it prints details, not the key), or the name in `LAB_KEYCHAIN_SERVICE` |
| macOS asks whether `security` may read the item | Choose **Always Allow** |
| **Run failed: permission breach** | An agent changed a protected file. The change was undone. Rephrase the request so it doesn't need that file, or make that edit yourself first |
| **Suite still failing after 3 attempts** | The worktree at `~/.dpi-lab/runs/<id>/repo` is left as it was so you can look. Check the test command is right |
| **Budget exceeded** | Raise the budget, or split the request into smaller ones |
| `git worktree add failed` for a repo in an iCloud-synced folder | macOS may be blocking access to the iCloud folder. Give your terminal **Full Disk Access** in System Settings → Privacy & Security |
| Page shows "dpi-backend is not running" | Press **▶ start** in the header |

## Where things live

- `~/.dpi-lab/runs/<id>/`: each run's working copy (`repo/`) and the agents' result files (`out/`)
- `~/.dpi-lab/backend/`: the durable database: checkpoints, conversations, approvals
- **⟲ reset** in the Crash Lab wipes the database. It doesn't delete run branches or worktrees.

**Removing your key:** `security delete-generic-password -s durable-pi-lab-anthropic` (or delete it from `.env.local`), then revoke the key in the Anthropic console.

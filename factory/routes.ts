// Lab-side factory API (runs in the Bun lab server, not in dpi-backend).
//
//   GET  /factory/repos                     git repos you can point the factory at (+ the greeter fixture)
//   GET  /factory/runs                      every run with its live durable job record
//   POST /factory/runs                      {repo, request, ship?, testCommand?, budgetCents?} → worktree + session + job
//   GET  /factory/runs/:id/diff             the run's change against its base commit (untracked files included)
//   POST /factory/runs/:id/approval         {approved, note?, sendBack?}
//   POST /factory/runs/:id/abort            stop the run
//   GET  /factory/runs/:id/agents/:key      one agent's transcript (planner, builder, reviewer, …)
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, cpSync } from "node:fs";
import { join, basename, resolve } from "node:path";

export interface FactoryDeps {
  labHome: string;
  labDir: string;
  /** fetch against dpi-backend /v1 with the token injected */
  backend: (path: string, init?: RequestInit) => Promise<Response>;
  mode: () => "scripted" | "live";
}

type RunMeta = {
  id: string;
  repo: string;
  repoName: string;
  request: string;
  branch: string;
  worktree: string;
  outDir: string;
  session: string;
  taskId: number;
  ship: string;
  mode: string;
  createdAt: number;
};

const json = (v: unknown, init?: ResponseInit) => Response.json(v, init);
const fail = (message: string, status = 400) => json({ error: { code: "invalid", message } }, { status });

export function factoryRoutes(d: FactoryDeps) {
  const runsFile = join(d.labHome, "factory-runs.json");
  const runsDir = join(d.labHome, "runs");
  mkdirSync(runsDir, { recursive: true });
  const load = (): RunMeta[] => (existsSync(runsFile) ? JSON.parse(readFileSync(runsFile, "utf8")) : []);
  const save = (runs: RunMeta[]) => writeFileSync(runsFile, JSON.stringify(runs, null, 2));
  const byId = (id: string) => load().find((r) => r.id === id);

  async function ensureFixture() {
    const dir = join(d.labHome, "fixtures", "greeter");
    if (existsSync(join(dir, ".git"))) return dir;
    mkdirSync(dir, { recursive: true });
    cpSync(join(d.labDir, "fixtures", "greeter"), dir, { recursive: true });
    await $`git init -q -b main && git add -A && git -c user.name=factory -c user.email=factory@localhost commit -q -m "greeter fixture"`.cwd(dir).quiet();
    return dir;
  }

  async function repos() {
    // Repos offered in the form: every git repo directly inside LAB_REPOS_DIR (default: the folder this lab sits in).
    const root = resolve(process.env.LAB_REPOS_DIR ?? join(d.labDir, ".."));
    const found = existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory() && existsSync(join(root, e.name, ".git")))
          .map((e) => ({ name: e.name, path: join(root, e.name) }))
      : [];
    return [{ name: "greeter (fixture)", path: await ensureFixture(), fixture: true }, ...found];
  }

  async function jobRun(meta: RunMeta) {
    try {
      const r = await d.backend(`/sessions/${meta.session}/agents/main/docs/demo.job-runs`);
      if (!r.ok) return null;
      const doc = (await r.json()) as { value: { items: Record<string, unknown> } };
      return doc.value.items[String(meta.taskId)] ?? null;
    } catch {
      return null;
    }
  }

  async function create(body: { repo?: string; request?: string; ship?: string; testCommand?: string; budgetCents?: number }) {
    const request = body.request?.trim();
    if (!request) return fail("request is required");
    const repo = body.repo || (await ensureFixture());
    if (!existsSync(join(repo, ".git"))) return fail(`${repo} is not a git repository`);
    const ship = body.ship === "pr" ? "pr" : "branch";
    const id = `${new Date().toISOString().slice(2, 10).replaceAll("-", "")}-${Math.random().toString(36).slice(2, 6)}`;
    const branch = `factory/${id}`;
    const runDir = join(runsDir, id);
    const worktree = join(runDir, "repo");
    const outDir = join(runDir, "out");
    mkdirSync(outDir, { recursive: true });
    const wt = await $`git worktree add -q -b ${branch} ${worktree} HEAD`.cwd(repo).nothrow().quiet();
    if (wt.exitCode !== 0) return fail(`git worktree add failed: ${wt.stderr.toString().trim()}`);
    // Commits in the worktree need an identity even where the repo has none configured.
    await $`git config user.name >/dev/null || git config user.name "Durable Factory"; git config user.email >/dev/null || git config user.email factory@localhost`.cwd(worktree).nothrow().quiet();

    const device = (await (await d.backend("/device")).json()) as { defaultModel: string; models: { id: string; provider: string }[] };
    const model = device.models.find((m) => m.id === device.defaultModel) ?? device.models[0];
    if (!model) return fail("The backend has no models (is the API key set?)", 503);
    const session = `factory-${id}`;
    const s = await d.backend("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `factory-session-${id}` },
      body: JSON.stringify({ name: session, cwd: worktree, model: { provider: model.provider, modelId: model.id } }),
    });
    if (!s.ok) return fail(`create session: ${await s.text()}`, 502);
    const mode = d.mode();
    const testCommand = body.testCommand?.trim() || (existsSync(join(worktree, "package.json")) ? "bun test" : "true");
    const j = await d.backend(`/sessions/${session}/agents/main/demo/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job: "factory-sdlc",
        input: { request, test_command: testCommand, out_dir: outDir, ship, budget_cents: body.budgetCents ?? 500, mode },
      }),
    });
    if (!j.ok) return fail(`start job: ${await j.text()}`, 502);
    const { taskId } = (await j.json()) as { taskId: number };
    const meta: RunMeta = { id, repo, repoName: basename(repo), request, branch, worktree, outDir, session, taskId, ship, mode, createdAt: Date.now() };
    save([...load(), meta]);
    return json(meta, { status: 201 });
  }

  async function diff(meta: RunMeta) {
    const run = (await jobRun(meta)) as { memo?: { base?: string } } | null;
    const base = run?.memo?.base ?? "HEAD";
    // Snapshot the working tree (untracked included) into a tree object without touching the real index.
    const tree = await $`idx="$(git rev-parse --git-path factory-diff-index)"; rm -f "$idx"; GIT_INDEX_FILE="$idx" git add -A >/dev/null && GIT_INDEX_FILE="$idx" git write-tree; rm -f "$idx"`
      .cwd(meta.worktree)
      .nothrow()
      .text();
    const t = tree.trim();
    const patch = await $`git --no-pager diff --no-color ${base} ${t}`.cwd(meta.worktree).nothrow().text();
    const stat = await $`git --no-pager diff --stat --no-color ${base} ${t}`.cwd(meta.worktree).nothrow().text();
    const log = await $`git --no-pager log --oneline --no-color ${base}..HEAD`.cwd(meta.worktree).nothrow().text();
    return json({ base, patch: patch.slice(0, 400_000), stat, log });
  }

  // Local desktop notifications when a run needs you or ends (nothing leaves the machine).
  // macOS: osascript. Linux: notify-send, if installed. Elsewhere: none (the board still updates).
  const seen = new Map<string, string>();
  const notify = (title: string, body: string) =>
    process.platform === "darwin"
      ? $`osascript -e ${`display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "Glass"`}`.nothrow().quiet()
      : process.platform === "linux"
        ? $`notify-send ${title} ${body}`.nothrow().quiet()
        : Promise.resolve();
  setInterval(async () => {
    for (const meta of load()) {
      const run = (await jobRun(meta)) as { status: string; approval?: string; error?: string } | null;
      if (!run) continue;
      const state = `${run.status}:${run.approval ?? ""}`;
      const before = seen.get(meta.id);
      seen.set(meta.id, state);
      if (before === undefined || before === state) continue;
      const what = meta.request.length > 60 ? `${meta.request.slice(0, 57)}…` : meta.request;
      if (run.status === "waiting") notify("Factory: your decision", `${meta.repoName}: ${what}`);
      else if (run.status === "completed") notify("Factory: shipped", `${meta.repoName}: ${what}`);
      else if (run.status === "failed") notify("Factory: run failed", `${meta.repoName}: ${run.error?.slice(0, 80) ?? what}`);
    }
  }, 3000);

  return async function handle(req: Request, url: URL): Promise<Response | undefined> {
    const p = url.pathname;
    if (!p.startsWith("/factory/")) return;
    if (p === "/factory/repos") return json(await repos());
    if (p === "/factory/runs" && req.method === "GET") {
      const runs = load().sort((a, b) => b.createdAt - a.createdAt);
      return json(await Promise.all(runs.map(async (m) => ({ ...m, run: await jobRun(m) }))));
    }
    if (p === "/factory/runs" && req.method === "POST") return create(await req.json().catch(() => ({})));
    const m = p.match(/^\/factory\/runs\/([^/]+)(?:\/(.*))?$/);
    if (!m) return;
    const meta = byId(m[1]);
    if (!meta) return fail("No such run", 404);
    const rest = m[2] ?? "";
    if (rest === "" && req.method === "GET") return json({ ...meta, run: await jobRun(meta) });
    if (rest === "diff") return diff(meta);
    if (rest === "approval" && req.method === "POST") {
      const r = await d.backend(`/sessions/${meta.session}/agents/main/demo/jobs/${meta.taskId}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await req.text(),
      });
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
    }
    if (rest === "abort" && req.method === "POST") {
      const r = await d.backend(`/sessions/${meta.session}/tasks/${meta.taskId}/abort`, { method: "POST" });
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
    }
    const a = rest.match(/^agents\/(.+)$/);
    if (a) {
      const run = (await jobRun(meta)) as { agents?: Record<string, number> } | null;
      const child = run?.agents?.[decodeURIComponent(a[1])];
      if (child === undefined) return fail("No such agent in this run", 404);
      const r = await d.backend(`/sessions/${meta.session}/agents/${child}/transcript?format=json`);
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
    }
    return fail("Not found", 404);
  };
}

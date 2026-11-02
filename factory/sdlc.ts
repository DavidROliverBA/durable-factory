/**
 * The Durable Factory: agent-factory's SDLC workflow as one Durable Pi job.
 *
 *   intake → plan → commit_plan → build → test⟲fix → review⟲revise → approve (you) → ship → report
 *
 * Deterministic TypeScript owns the graph; agents are bounded, durable nodes inside it. Every phase is a pi-durable
 * checkpoint, every agent is its own durable conversation, and every value that must not be recomputed after a crash
 * (the file baseline before an agent runs, commits, pushes) is memoised in the run record. Kill the backend anywhere
 * and the run resumes where it stopped: nothing is lost and nothing irreversible runs twice.
 *
 * Loaded into dpi-backend with DPI_JOB_MODULES=<this file>. Runs in a session whose cwd is the run's git worktree.
 */
import { registerJob, type Phase, type JobData } from "../../durable-pi/apps/dpi-backend/src/jobs.js";
import { PROTECTED, ROLES, type Role } from "./roles.js";
import { BuildEnvelope, PlanEnvelope, ReviewEnvelope, SHAPES, type Build, type Plan, type Review } from "./envelopes.js";
import { scripts } from "./scripted.js";

/** Bounded, named, finite. Not a while-true with a vibe check. */
const MAX_TEST_ATTEMPTS = 3;
const MAX_REVISIONS = 2;
const MAX_ENVELOPE_TURNS = 3;
const TEST_TIMEOUT_SEC = 900;

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const tail = (s: string, n = 40) => s.trim().split("\n").slice(-n).join("\n");
const slug = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, "-");

// ------------------------------------------------------------------ git helpers (run in the worktree)

/** A tree object of the whole working tree (tracked + untracked, .gitignore respected) without touching the index. */
async function snapshotTree(p: Phase): Promise<string> {
  const r = await p.shell(
    `idx="$(git rev-parse --git-path factory-index)"; rm -f "$idx"; GIT_INDEX_FILE="$idx" git add -A >/dev/null && GIT_INDEX_FILE="$idx" git write-tree; rc=$?; rm -f "$idx"; exit $rc`,
  );
  if (r.code !== 0) throw Error(`snapshot failed: ${tail(r.out, 4)}`);
  return r.out.trim();
}

async function changedBetween(p: Phase, a: string, b: string): Promise<string[]> {
  if (a === b) return [];
  const r = await p.shell(`git diff --name-only ${a} ${b}`);
  return r.out.split("\n").map((l) => l.trim()).filter(Boolean);
}

async function restore(p: Phase, tree: string, paths: string[]) {
  for (const path of paths) {
    const exists = (await p.shell(`git cat-file -e ${tree}:${q(path)} 2>/dev/null`)).code === 0;
    await p.shell(exists ? `git restore --source=${tree} --worktree -- ${q(path)}` : `rm -f -- ${q(path)}`);
  }
}

const globRe = (g: string) =>
  new RegExp(
    "^" +
      g
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, "\u0000")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, "(?:.*/)?") +
      "$",
  );
const matchesAny = (path: string, globs: string[]) => globs.some((g) => globRe(g).test(path));
const permitted = (path: string, role: Role) => (role.writes !== undefined ? matchesAny(path, role.writes) : !matchesAny(path, PROTECTED));

// ------------------------------------------------------------------ one agent step: prompt → envelope → gates

interface AgentStep<T> {
  key: string;
  role: Role;
  prompt: string;
  shape: string;
  check: (v: unknown) => T;
  /** Extra gates on the envelope and the files this step changed; return failure lines (empty = pass). */
  gates?: (env: T, changed: string[]) => Promise<string[]> | string[];
  /** Scripted mode: the shell script the faux model runs instead of a real agent, given the envelope path. */
  script?: (file: string) => string;
}

async function agentStep<T>(p: Phase, s: AgentStep<T>): Promise<{ env: T; changed: string[] }> {
  const scripted = p.input.mode === "scripted";
  const file = `${p.input.out_dir}/${slug(s.key)}.json`;
  // Taken once, before the agent's first turn, and kept across restarts: the baseline the write scope is judged against.
  const before = await p.memo(`tree:${s.key}`, () => snapshotTree(p));
  const instructions =
    `${s.prompt}\n\nWhen you have finished, write your result as JSON to this file (outside the repository): ${file}\n` +
    `It must have exactly this shape:\n${s.shape}`;

  let problem = "";
  for (let turn = 0; turn < MAX_ENVELOPE_TURNS; turn++) {
    const budget = Number(p.input.budget_cents) / 100;
    const spent = await p.cost();
    if (spent > budget) throw Error(`Budget exceeded: $${spent.toFixed(2)} of $${budget.toFixed(2)}`);
    const message = scripted
      ? `!${s.script?.(file) ?? `echo '{}' > ${q(file)}`}`
      : turn === 0
        ? instructions
        : `Your result did not pass the factory's checks:\n${problem}\n\nFix the work or the JSON file ${file}, then write the file again.`;
    await p.agent(message, {
      key: s.key,
      role: s.role.name,
      tools: s.role.tools,
      instructions: s.role.instructions,
      ...(s.role.model ? { model: s.role.model } : {}),
      ...(s.role.thinkingLevel && !scripted ? { thinkingLevel: s.role.thinkingLevel } : {}),
      turn,
    });

    // Write scope first: a breach is rolled back and fails the phase. Re-prompting cannot undo a write.
    const after = await snapshotTree(p);
    const changed = await changedBetween(p, before, after);
    const offending = changed.filter((path) => !permitted(path, s.role));
    if (offending.length) {
      await restore(p, before, offending);
      await p.note(`✕ ${s.role.name} changed protected paths, rolled back`, offending.join(", "));
      throw Error(`${s.key}: permission breach, ${offending.length} path(s) outside the ${s.role.name}'s write scope: ${offending.join(", ")}`);
    }

    let env: T;
    try {
      const raw = await p.shell(`cat ${q(file)} 2>/dev/null`);
      if (raw.code !== 0) throw Error(`the file ${file} does not exist`);
      env = s.check(JSON.parse(raw.out));
    } catch (e) {
      problem = `- envelope: ${(e as Error).message}`;
      await p.note(`✕ ${s.key}: envelope invalid (turn ${turn + 1})`, problem);
      continue;
    }
    const failures = [...(await (s.gates?.(env, changed) ?? []))];
    if (failures.length) {
      problem = failures.map((f) => `- ${f}`).join("\n");
      await p.note(`✕ ${s.key}: gates failed (turn ${turn + 1})`, problem);
      continue;
    }
    await p.note(`✓ ${s.key}: envelope valid, gates passed`, changed.length ? `changed: ${changed.join(", ")}` : "no files changed");
    return { env, changed };
  }
  throw Error(`${s.key}: still failing the factory's checks after ${MAX_ENVELOPE_TURNS} turns:\n${problem}`);
}

/** The git diff of this step matches what the agent said it changed. The gate that earns its keep. */
const diffMatchesClaims = (claimed: string[], changed: string[], allowNoChange = false) => {
  const out: string[] = [];
  const actual = new Set(changed);
  for (const f of new Set(claimed)) if (!actual.has(f)) out.push(`${f}: claimed as changed but not in the diff`);
  for (const f of actual) if (!claimed.includes(f)) out.push(`${f}: changed but not declared in changedFiles`);
  if (!allowNoChange && !claimed.length && !changed.length) out.push("no files changed and none claimed");
  return out;
};

const verdictConsistent = (r: Review) => {
  const high = r.findings.filter((f) => f.severity === "high").length;
  return r.verdict === "approved" && high > 0 ? [`verdict: approved despite ${high} high-severity finding(s)`] : [];
};

/**
 * Run the suite once per (phase, iteration, label) and keep the result: after a restart the run continues from the
 * result it already acted on (a failure that sent the builder to fix it stays a failure in the record), rather than
 * re-running the suite against files the interrupted fix may already have changed.
 */
async function runTests(p: Phase, label: string): Promise<{ passed: boolean; out: string }> {
  const cmd = String(p.input.test_command);
  const key = `test:${p.iteration}:${label}`;
  let fresh = false;
  const r = await p.memo(key, async () => {
    fresh = true;
    return p.step("command", `${cmd}  (${label})`, async () => {
      const r = await p.shell(`${cmd} 2>&1`, TEST_TIMEOUT_SEC);
      const passed = r.code === 0;
      return { value: { passed, out: tail(r.out) }, detail: `${passed ? "PASS" : `FAIL (exit ${r.code})`}\n${tail(r.out, 12)}` };
    });
  });
  if (!fresh) await p.note(`${cmd}  (${label}): ${r.passed ? "PASS" : "FAIL"}, result kept from before the restart`, tail(r.out, 12));
  return r;
}

/** allowNoChange: for answers to review findings and human notes, where "nothing I may change fixes this" is honest. */
const build = (p: Phase, key: string, prompt: string, script: (file: string) => string, allowNoChange = false) =>
  agentStep<Build>(p, {
    key,
    role: ROLES.builder,
    prompt,
    shape: SHAPES.build,
    check: BuildEnvelope,
    gates: (env, changed) => diffMatchesClaims(env.changedFiles, changed, allowNoChange),
    script,
  });

// ------------------------------------------------------------------ the job

registerJob(
  {
    id: "factory-sdlc",
    title: "Factory run",
    summary: "Plan, build, test, review, then wait for your approval before shipping. Agent-factory's workflow, made durable.",
    phases: [
      { id: "intake", label: "Intake", summary: "Record the base commit and check the worktree" },
      { id: "plan", label: "Plan", summary: "The planner reads the code and writes plan.md" },
      { id: "commit_plan", label: "Commit plan", summary: "The spec goes on record before any code exists" },
      { id: "build", label: "Build", summary: "The builder implements plan.md" },
      { id: "test", label: "Test ⟲ fix", summary: "Run the suite; on failure the builder fixes from the verbatim output", kind: "repeat" },
      { id: "review", label: "Review ⟲ revise", summary: "The reviewer checks the work against plan.md", kind: "repeat" },
      { id: "approve", label: "Approve", summary: "You approve, decline, or send it back with a note", kind: "approval", sendBackTo: "review" },
      { id: "ship", label: "Ship", summary: "Commit, and push / open a PR when asked" },
      { id: "report", label: "Report", summary: "Save the run's summary to App State" },
    ],
    inputs: [
      { name: "request", type: "string", default: "Describe the change", description: "What the factory should build" },
      { name: "test_command", type: "string", default: "bun test", description: "The suite that decides whether it runs" },
      { name: "out_dir", type: "string", default: "/tmp", description: "Where agents write their JSON envelopes (outside the repo)" },
      { name: "ship", type: "string", default: "branch", description: "branch (leave it) or pr (push and open a pull request)" },
      { name: "budget_cents", type: "integer", default: 500, min: 1, max: 100000, description: "Stop when model spend passes this" },
      { name: "mode", type: "string", default: "live", description: "live (real agents) or scripted (faux model runs fixed scripts)" },
    ],
    approval: true,
    resultPath: "/factory",
    seconds: 60,
  },
  {
    intake: async (p) => {
      const base = await p.memo("base", async () => (await p.exec("git rev-parse HEAD", "git rev-parse HEAD")).trim());
      const branch = (await p.exec("git rev-parse --abbrev-ref HEAD", "git rev-parse --abbrev-ref HEAD")).trim();
      if (!["branch", "pr"].includes(String(p.input.ship))) throw Error(`ship must be branch or pr, not ${p.input.ship}`);
      await p.exec(`mkdir -p ${q(String(p.input.out_dir))}`, "prepare the envelope folder");
      await p.note(`Request: ${p.input.request}`);
      return { done: `${branch} from ${base.slice(0, 8)}`, data: { base, branch } };
    },

    plan: async (p) => {
      const { env } = await agentStep<Plan>(p, {
        key: "plan",
        role: ROLES.planner,
        prompt: `${p.input.request}\n\nWrite an implementation plan to plan.md. Explore the codebase first: read before you propose. Declare plan.md in artifacts. Never plan a change to a protected path; list it under risks instead.`,
        shape: SHAPES.plan,
        check: PlanEnvelope,
        gates: async (_env, changed) => {
          const ok = (await p.shell("test -s plan.md")).code === 0;
          return [...(ok ? [] : ["plan.md: missing or empty"]), ...(changed.includes("plan.md") ? [] : ["plan.md: not written in this step"])];
        },
        script: scripts.plan,
      });
      return { done: env.summary, data: { plan: { summary: env.summary, steps: env.steps, commitMessage: env.commitMessage } } };
    },

    commit_plan: async (p) => {
      const plan = p.data.plan as { commitMessage: string };
      const sha = await p.memo("commit:plan", async () =>
        (await p.exec(`git add -A && (git commit -q -m ${q(plan.commitMessage || "Plan")} || true) && git rev-parse HEAD`, "git commit plan.md")).trim(),
      );
      return { done: `Committed ${sha.slice(0, 8)}: ${plan.commitMessage}` };
    },

    build: async (p) => {
      const plan = p.data.plan as { summary: string; steps: string[] };
      const { env } = await build(
        p,
        "build",
        `Implement the plan in plan.md exactly. Do not expand its scope.\n\nPlan summary: ${plan.summary}\nSteps:\n${plan.steps.map((s) => `- ${s}`).join("\n")}`,
        (f) => scripts.build(f, String(p.input.request)),
      );
      return { done: env.summary, data: { build: { summary: env.summary, commitMessage: env.commitMessage } } };
    },

    test: async (p) => {
      const attempt = p.iteration + 1;
      await p.progress(attempt, MAX_TEST_ATTEMPTS);
      const r = await runTests(p, `attempt ${attempt}/${MAX_TEST_ATTEMPTS}`);
      if (r.passed) return { done: `Suite passed on attempt ${attempt}`, data: { testAttempts: attempt } };
      if (attempt >= MAX_TEST_ATTEMPTS)
        throw Error(`Suite still failing after ${MAX_TEST_ATTEMPTS} attempts. Plan is committed; the worktree is left dirty for inspection.`);
      const { env } = await build(
        p,
        `fix:${attempt}`,
        `The test suite failed. Repair it from this verbatim output. Do not weaken or delete the tests.\n\n${r.out}`,
        scripts.fix,
      );
      return { again: { ...p.data, build: { ...(p.data.build as JobData), summary: env.summary } } as JobData, summary: `Attempt ${attempt} failed; fixed, re-running` };
    },

    review: async (p) => {
      const data = p.data as JobData & { sentBack?: number; noteHandled?: number; revisions?: number; note?: string; build: { summary: string; commitMessage: string } };
      const sentBack = Number(data.sentBack ?? 0);

      // Sent back by a person: act on their note first, then review again.
      if (sentBack > Number(data.noteHandled ?? 0)) {
        const { env } = await build(p, `human:${sentBack}`, `A person reviewed this work and sent it back with this note. Address it:\n\n${data.note}`, (f) => scripts.human(f, String(data.note ?? "")), true);
        const t = await runTests(p, `after your note #${sentBack}`);
        if (!t.passed) throw Error(`The change for your note #${sentBack} broke the suite. Stopping.`);
        return { again: { ...data, noteHandled: sentBack, revisions: 0, build: { ...data.build, summary: env.summary } } as JobData, summary: "Your note addressed; reviewing again" };
      }

      const { env: review } = await agentStep<Review>(p, {
        key: `review:${p.iteration}`,
        role: ROLES.reviewer,
        prompt:
          `Does the implementation match plan.md? Report EVERY issue you find, including low-severity and ones you are unsure about. ` +
          `Do not filter for importance yourself. Use git diff ${String(data.base).slice(0, 12)} to see the change.\n\nBuild summary: ${data.build.summary}`,
        shape: SHAPES.review,
        check: ReviewEnvelope,
        gates: (env) => verdictConsistent(env),
        script: scripts.review,
      });
      await p.note(
        `Reviewer verdict: ${review.verdict === "approved" ? "approved" : "changes requested"}`,
        [review.summary, ...review.findings.map((f) => `[${f.severity}] ${f.file}: ${f.detail}`)].join("\n"),
      );
      const counts = `${review.findings.length} finding(s), ${review.findings.filter((f) => f.severity === "high").length} high`;
      const kept = { verdict: review.verdict, summary: review.summary, findings: review.findings.slice(0, 30) };
      const revisions = Number(data.revisions ?? 0);
      if (review.verdict === "approved" || revisions >= MAX_REVISIONS)
        return { done: `${review.verdict === "approved" ? "Approved" : `Still changes requested after ${revisions} revisions`}: ${counts}`, data: { review: kept } };

      const { env, changed } = await build(
        p,
        `revise:${p.iteration}`,
        `Address these review findings:\n\n${review.findings.map((f) => `- [${f.severity}] ${f.file}: ${f.detail}`).join("\n")}`,
        scripts.revise,
        true,
      );
      if (!changed.length) {
        await p.note("Builder changed nothing: the findings need you", env.notes || env.summary);
        return {
          done: `Changes requested (${counts}); the builder could not address them within its rules, so they are left for you`,
          data: { review: { ...kept, unresolved: env.notes || env.summary } },
        };
      }
      const t = await runTests(p, `retest after revision ${revisions + 1}`);
      if (!t.passed) throw Error(`Revision ${revisions + 1} broke the suite. Stopping.`);
      return { again: { ...data, revisions: revisions + 1, review: kept, build: { ...data.build, summary: env.summary } } as JobData, summary: `Changes requested (${counts}); revised` };
    },

    ship: async (p): Promise<{ done: string; data: JobData }> => {
      const b = p.data.build as { commitMessage: string };
      const sha = await p.memo("commit:build", async () =>
        (await p.exec(`git add -A && (git commit -q -m ${q(b.commitMessage || "Factory build")} || true) && git rev-parse HEAD`, "git commit the build")).trim(),
      );
      const branch = String(p.data.branch);
      if (p.input.ship === "pr") {
        await p.memo("push", async () => (await p.exec(`git push -u origin ${q(branch)} 2>&1`, `git push ${branch}`)).trim().slice(-300));
        const url = await p.memo("pr", async () =>
          (await p.exec(`gh pr create --head ${q(branch)} --title ${q(b.commitMessage)} --body-file plan.md 2>&1 | tail -1`, "gh pr create")).trim(),
        );
        return { done: `PR opened: ${url}`, data: { sha, url } };
      }
      return { done: `Branch ${branch} at ${sha.slice(0, 8)}, ready for you to merge`, data: { sha } };
    },

    report: async (p) => {
      const review = p.data.review as { verdict: string; findings: unknown[] } | undefined;
      const cost = await p.cost();
      await p.saveState(`/factory/${slug(String(p.data.branch)).replace(/^factory-/, "")}`, {
        request: String(p.input.request),
        branch: String(p.data.branch),
        base: String(p.data.base),
        sha: String(p.data.sha),
        ...(p.data.url ? { url: String(p.data.url) } : {}),
        testAttempts: Number(p.data.testAttempts ?? 0),
        verdict: review?.verdict ?? "",
        findings: review?.findings.length ?? 0,
        sentBack: Number(p.data.sentBack ?? 0),
        costUsd: Math.round(cost * 10000) / 10000,
        at: new Date(p.now()).toISOString(),
      });
      return { done: `Done. $${cost.toFixed(4)} spent` };
    },
  },
);

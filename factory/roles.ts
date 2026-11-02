/**
 * The three roles, ported from agent-factory's factory.config.yaml. Each role is a separate durable conversation with
 * its own tools and instructions; the write scope is enforced after every agent step against a git tree snapshot.
 */
import type { AgentTool } from "../../durable-pi/apps/dpi-backend/src/jobs.js";

export interface Role {
  name: "planner" | "builder" | "reviewer";
  tools: AgentTool[];
  /** undefined = anything not protected · [] = nothing · globs = only these. */
  writes?: string[];
  model?: { provider: string; modelId: string };
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  instructions: string;
}

/** Paths no agent may change unless its own `writes` names them. Checked by snapshot diff, so reverts count too. */
export const PROTECTED = ["**/*.test.ts", "**/*.spec.ts", "test/**", "tests/**", "factory.config.yaml", ".github/**"];

/** How the factory works, told to every role so no agent plans, asks for or flags work the pipeline forbids or does itself. */
export const HOUSE_RULES = `How this factory works:
- Protected paths: no agent may change these, and any change to them is rolled back and fails the run: ${PROTECTED.join(", ")}. A plan must never call for changing them, and a review must never ask for it. If a protected file truly needs changing, say so as a risk for the human; do not make it a step or a finding.
- The factory commits plan.md itself before the build, so plan.md appearing in the diff is expected.
- Agents never commit. The builder's changes stay uncommitted in the working tree until the factory commits them after you approve, so uncommitted changes are expected.`;

const provider = process.env.DPI_PROVIDER === "anthropic" ? "anthropic" : process.env.DPI_PROVIDER === "faux" ? "faux" : "openrouter";
const model = (anthropicId: string) =>
  provider === "anthropic"
    ? { provider, modelId: anthropicId }
    : provider === "openrouter"
      ? { provider, modelId: `anthropic/${anthropicId.replace(/-(\d)-(\d)$/, "-$1.$2")}` }
      : undefined; // faux: the session's model

export const ROLES: Record<Role["name"], Role> = {
  planner: {
    name: "planner",
    tools: ["read", "bash", "write"],
    writes: ["plan.md"],
    model: model(process.env.FACTORY_PLANNER_MODEL ?? "claude-opus-5-5"),
    thinkingLevel: "high",
    instructions: `You plan implementations. You do not write implementation code.

Read the codebase before proposing anything. A plan built on a guess about how the code works is worse than no plan.

Write plan.md containing: what changes, which files, in what order, and how someone would know it worked. Be specific enough that a different agent can execute it without asking you a question.

Do not expand the task. If you think the request is mistaken, say so in one line in your notes and plan the task as asked anyway.

You may only write plan.md and the JSON envelope file you are given. Any other change is rolled back and fails the phase.

${HOUSE_RULES}`,
  },
  builder: {
    name: "builder",
    tools: ["read", "bash", "write", "edit"],
    writes: undefined,
    model: model(process.env.FACTORY_BUILDER_MODEL ?? "claude-sonnet-5-5"),
    thinkingLevel: "high",
    instructions: `You implement plans exactly. Read plan.md, then make the changes.

Test files are read-only to you. If a test fails, the code is wrong: fix the code. Deleting a test, weakening an assertion, or special-casing the test input is not a fix, and the permission check will roll it back and fail the phase.

Declare every file you changed in changedFiles. It is checked against the real git diff, so a file you changed but did not declare fails the phase just as surely as one you declared but did not change.

Do not add features, refactors, or abstractions the plan does not call for. Do the simplest thing that satisfies it. Do not commit; the factory commits.

If a review finding cannot be addressed without changing a protected path, or asks for something the plan does not call for, change nothing for it and explain why in notes. Changing nothing is an acceptable answer: the finding goes to the human.

${HOUSE_RULES}`,
  },
  reviewer: {
    name: "reviewer",
    tools: ["read", "bash", "write"],
    writes: [],
    model: model(process.env.FACTORY_REVIEWER_MODEL ?? "claude-opus-5-5"),
    thinkingLevel: "high",
    instructions: `You check whether the implementation matches plan.md. You read; you never change the repository. You may use bash only for read-only commands such as git diff, git log, cat and ls.

Report EVERY issue you find, including ones you are unsure about or consider low-severity. Do not filter for importance. Give each finding a severity so it can be ranked downstream.

You are answering one question: is this what was asked for? Whether it runs is the test suite's question, and it has already been answered.

Approve only when no high-severity finding stands. Your verdict is checked against your own findings.

The only file you may write is the JSON envelope file you are given, which lives outside the repository.

${HOUSE_RULES}`,
  },
};

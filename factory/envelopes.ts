/**
 * Typed envelopes passed between phases, from agent-factory's types.ts, validated by hand so this module needs no
 * dependencies of its own (it is loaded into dpi-backend's process). Each agent writes its envelope as JSON to a file
 * outside the repository; a missing or invalid envelope is sent back to the same durable conversation to fix.
 */
export type Envelope = { summary: string; commitMessage: string; artifacts: string[]; notes: string };
export type Plan = Envelope & { steps: string[]; risks: string[] };
export type Build = Envelope & { changedFiles: string[] };
export type Finding = { file: string; severity: "high" | "medium" | "low"; detail: string };
export type Review = Envelope & { verdict: "approved" | "changes_requested"; findings: Finding[] };

type Check<T> = (v: unknown) => T;

const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("the envelope must be a JSON object");
  return v as Record<string, unknown>;
};
const str = (o: Record<string, unknown>, k: string) => {
  if (typeof o[k] !== "string") throw Error(`"${k}" must be a string`);
  return o[k] as string;
};
const strs = (o: Record<string, unknown>, k: string) => {
  if (!Array.isArray(o[k]) || !(o[k] as unknown[]).every((x) => typeof x === "string")) throw Error(`"${k}" must be an array of strings`);
  return o[k] as string[];
};
const base = (o: Record<string, unknown>): Envelope => ({
  summary: str(o, "summary"),
  commitMessage: str(o, "commitMessage"),
  artifacts: strs(o, "artifacts"),
  notes: str(o, "notes"),
});

export const PlanEnvelope: Check<Plan> = (v) => {
  const o = obj(v);
  return { ...base(o), steps: strs(o, "steps"), risks: strs(o, "risks") };
};
export const BuildEnvelope: Check<Build> = (v) => {
  const o = obj(v);
  return { ...base(o), changedFiles: strs(o, "changedFiles") };
};
export const ReviewEnvelope: Check<Review> = (v) => {
  const o = obj(v);
  const verdict = str(o, "verdict");
  if (verdict !== "approved" && verdict !== "changes_requested") throw Error(`"verdict" must be "approved" or "changes_requested"`);
  if (!Array.isArray(o.findings)) throw Error(`"findings" must be an array`);
  const findings = (o.findings as unknown[]).map((f, i) => {
    const x = obj(f);
    const severity = str(x, "severity");
    if (!["high", "medium", "low"].includes(severity)) throw Error(`findings[${i}].severity must be high, medium or low`);
    return { file: str(x, "file"), severity: severity as Finding["severity"], detail: str(x, "detail") };
  });
  return { ...base(o), verdict, findings };
};

/** The shape, written into the prompt so the agent knows exactly what to produce. */
export const SHAPES = {
  plan: `{"summary": string, "commitMessage": string, "artifacts": string[], "notes": string, "steps": string[], "risks": string[]}`,
  build: `{"summary": string, "commitMessage": string, "artifacts": string[], "notes": string, "changedFiles": string[]}`,
  review: `{"summary": string, "commitMessage": string, "artifacts": string[], "notes": string, "verdict": "approved" | "changes_requested", "findings": [{"file": string, "severity": "high" | "medium" | "low", "detail": string}]}`,
};

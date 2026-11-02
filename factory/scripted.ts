/**
 * Scripted mode: with the free faux model, each agent turn is a "!<script>" prompt that the faux model runs as one
 * bash tool call in the agent's durable conversation. Everything else is identical to a live run: the same durable
 * child conversations, envelopes, gates, write-scope checks, test loop, review loop, approval and crash recovery.
 *
 * The scripts target the greeter fixture (fixtures/greeter) and deliberately take a wrong turn so every loop runs:
 * the first build forgets the "!" (the suite fails, the builder fixes it), and the first review asks for the README to
 * document the option (the builder revises, the reviewer approves). Each script sleeps a few seconds so there is time
 * to kill the backend mid-agent. Other repos get a generic fallback that only writes FACTORY_NOTES.md.
 */
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const json = (file: string, value: unknown) => `cat > ${q(file)} <<'__ENVELOPE__'\n${JSON.stringify(value)}\n__ENVELOPE__`;
const greeter = (fixture: string, fallback: string) => `if [ -f src/greet.ts ]; then\n${fixture}\nelse\n${fallback}\nfi`;
const envelope = (summary: string, commitMessage: string, changedFiles: string[]) => ({
  summary,
  commitMessage,
  artifacts: changedFiles,
  notes: "",
  changedFiles,
});

export const scripts = {
  plan: (file: string) =>
    `echo "planner: reading the code"; ls -R src test 2>/dev/null | head -20; sleep 3
` +
    greeter(
      `cat > plan.md <<'__PLAN__'
# Plan: add a shout option to greet()

1. \`src/greet.ts\`: accept an optional second argument \`{ shout?: boolean }\` (default \`{}\`).
2. When \`shout\` is true, return the whole greeting upper-cased, punctuation included.
3. Leave the existing behaviour unchanged when no options are given.

**Done when** \`bun test\` passes; \`test/greet.test.ts\` already covers both cases.
__PLAN__
${json(file, {
  summary: "Add an optional { shout } flag to greet() that upper-cases the greeting",
  commitMessage: "Plan: shout option for greet()",
  artifacts: ["plan.md"],
  notes: "",
  steps: ["Add an optional options argument to greet() in src/greet.ts", "Upper-case the full greeting when shout is true", "Run bun test"],
  risks: [],
})}`,
      `printf '# Plan\\n\\nRecord the request in FACTORY_NOTES.md.\\n' > plan.md
${json(file, { summary: "Record the request", commitMessage: "Plan", artifacts: ["plan.md"], notes: "", steps: ["Write FACTORY_NOTES.md"], risks: [] })}`,
    ),

  /** A request containing "[breach]" makes the scripted builder also weaken the test, to show the write-scope guard. */
  build: (file: string, request = "") =>
    `echo "builder: implementing plan.md"; sleep 5
` +
    (request.includes("[breach]") ? `sed -i.bak 's/HELLO, ADA!/HELLO, ADA/' test/greet.test.ts && rm -f test/greet.test.ts.bak\n` : "") +
    greeter(
      `cat > src/greet.ts <<'__SRC__'
export function greet(name: string, opts: { shout?: boolean } = {}): string {
  const text = \`Hello, \${name}\`;
  return opts.shout ? text.toUpperCase() : text + "!";
}
__SRC__
${json(file, envelope("greet() takes { shout } and upper-cases the greeting", "Add a shout option to greet()", ["src/greet.ts"]))}`,
      `echo "Built by the factory." > FACTORY_NOTES.md
${json(file, envelope("Wrote FACTORY_NOTES.md", "Factory notes", ["FACTORY_NOTES.md"]))}`,
    ),

  fix: (file: string) =>
    `echo "builder: reading the failure"; sleep 3
` +
    greeter(
      `cat > src/greet.ts <<'__SRC__'
export function greet(name: string, opts: { shout?: boolean } = {}): string {
  const text = \`Hello, \${name}!\`;
  return opts.shout ? text.toUpperCase() : text;
}
__SRC__
${json(file, envelope("Keep the ! when shouting", "Fix: keep the exclamation mark when shouting", ["src/greet.ts"]))}`,
      `echo "Fixed by the factory." >> FACTORY_NOTES.md
${json(file, envelope("Updated FACTORY_NOTES.md", "Factory fix", ["FACTORY_NOTES.md"]))}`,
    ),

  review: (file: string) =>
    `echo "reviewer: comparing the change with plan.md"; git --no-pager diff --stat HEAD; sleep 3
` +
    greeter(
      `if grep -q shout README.md; then
${json(file, { summary: "Matches plan.md; README documents the option", commitMessage: "", artifacts: [], notes: "", verdict: "approved", findings: [{ file: "src/greet.ts", severity: "low", detail: "Options object could be named for reuse; fine as is" }] })}
else
${json(file, { summary: "Implementation matches plan.md, but the new option is undocumented", commitMessage: "", artifacts: [], notes: "", verdict: "changes_requested", findings: [{ file: "README.md", severity: "medium", detail: "README does not mention the new shout option" }] })}
fi`,
      json(file, { summary: "Looks fine", commitMessage: "", artifacts: [], notes: "", verdict: "approved", findings: [] }),
    ),

  revise: (file: string) =>
    `echo "builder: addressing review findings"; sleep 3
` +
    greeter(
      `cat >> README.md <<'__DOC__'

## Options

\`greet(name, { shout: true })\` returns the greeting upper-cased: \`greet("ada", { shout: true })\` → \`HELLO, ADA!\`
__DOC__
${json(file, envelope("Documented the shout option in the README", "Docs: document greet()'s shout option", ["README.md"]))}`,
      `echo "Revised by the factory." >> FACTORY_NOTES.md
${json(file, envelope("Updated FACTORY_NOTES.md", "Factory revision", ["FACTORY_NOTES.md"]))}`,
    ),

  human: (file: string, note: string) => {
    const line = note.replaceAll("\n", " ").replaceAll("__NOTE__", "");
    const append = (target: string) => `cat >> ${target} <<'__NOTE__'\n\n> Reviewer note addressed: ${line}\n__NOTE__`;
    return (
      `echo "builder: acting on your note"; sleep 3\n` +
      greeter(
        `${append("README.md")}\n${json(file, envelope("Addressed your note in the README", "Address review note", ["README.md"]))}`,
        `${append("FACTORY_NOTES.md")}\n${json(file, envelope("Addressed your note", "Address review note", ["FACTORY_NOTES.md"]))}`,
      )
    );
  },
};

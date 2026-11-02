// One-time setup: fetch disler/durable-pi next to this folder, pin it to the commit the factory was built
// against, apply the factory patch on a branch called `factory`, and install the backend's dependencies.
// Safe to re-run. Override the location with DPI_REPO.
import { $ } from "bun";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const UPSTREAM = "https://github.com/disler/durable-pi";
const PINNED = "37165c619573dbaf425463038bbffecfe576beec";
const dpi = resolve(process.env.DPI_REPO ?? join(import.meta.dir, "..", "durable-pi"));
const patch = join(import.meta.dir, "patches", "durable-pi-factory.patch");

if (!existsSync(join(dpi, ".git"))) {
  console.log(`Cloning ${UPSTREAM} → ${dpi}`);
  await $`git clone -q ${UPSTREAM} ${dpi}`;
}

const branch = (await $`git rev-parse --abbrev-ref HEAD`.cwd(dpi).text()).trim();
if (branch === "factory") {
  console.log("durable-pi is already on the factory branch: patch step skipped.");
} else {
  if ((await $`git status --porcelain`.cwd(dpi).text()).trim()) {
    console.error(`${dpi} has uncommitted changes. Commit or stash them, then re-run.`);
    process.exit(1);
  }
  await $`git fetch -q origin`.cwd(dpi).nothrow();
  await $`git checkout -q -b factory ${PINNED}`.cwd(dpi);
  await $`git apply --index ${patch}`.cwd(dpi);
  await $`git -c user.name=factory-setup -c user.email=setup@localhost commit -q -m ${"factory hooks (applied by durable-factory setup)"}`.cwd(dpi);
  console.log("Applied the factory patch on branch `factory`.");
}

for (const app of ["dpi-sdk", "dpi-backend"]) {
  console.log(`Installing ${app} dependencies…`);
  await $`npm ci --silent`.cwd(join(dpi, "apps", app));
}
console.log("\nDone. Next: bun start   (free practice mode)  or  bun run live   (real Claude models)");

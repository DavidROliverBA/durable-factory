// Durable Pi Crash Lab — supervises a real dpi-backend process and serves a visual UI.
//
//   bun server.ts            → http://localhost:4791
//
// The lab owns one dpi-backend child (faux model by default, so it is free and offline), lets the
// browser SIGKILL / restart it, and proxies /api/* → backend /v1/* with the bearer token injected,
// so the browser never sees the token.
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Subprocess } from "bun";
import { factoryRoutes } from "./factory/routes.ts";

const LAB_PORT = Number(process.env.LAB_PORT ?? 4791);
const BACKEND_PORT = Number(process.env.LAB_BACKEND_PORT ?? 4790);
const DPI_REPO = resolve(process.env.DPI_REPO ?? join(import.meta.dir, "..", "durable-pi"));
const BACKEND_DIR = join(DPI_REPO, "apps", "dpi-backend");
const LAB_HOME = resolve(process.env.LAB_HOME ?? join(homedir(), ".dpi-lab"));
const WORK_DIR = join(LAB_HOME, "work");
const DATA_DIR = join(LAB_HOME, "backend");
// The Anthropic key can live in the macOS Keychain (service "durable-pi-lab-anthropic", or LAB_KEYCHAIN_SERVICE) instead of the shell
// environment. It is read only when LAB_PROVIDER=anthropic, kept in memory, handed to the backend child's
// environment, and never logged.
const KEYCHAIN_SERVICE = process.env.LAB_KEYCHAIN_SERVICE ?? "durable-pi-lab-anthropic";
if (process.env.LAB_PROVIDER === "anthropic" && !process.env.ANTHROPIC_API_KEY && process.platform === "darwin") {
  const r = Bun.spawnSync(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { stderr: "ignore" });
  const key = r.exitCode === 0 ? r.stdout.toString().trim() : "";
  if (key) process.env.ANTHROPIC_API_KEY = key;
  else console.warn(`No ANTHROPIC_API_KEY in the environment or .env.local, and no Keychain item "${KEYCHAIN_SERVICE}"`);
}
// faux (free, offline, scripted factory) unless LAB_PROVIDER names a live provider whose key is set.
const PROVIDER =
  process.env.LAB_PROVIDER === "anthropic" && process.env.ANTHROPIC_API_KEY
    ? "anthropic"
    : process.env.LAB_PROVIDER === "openrouter" && process.env.OPENROUTER_API_KEY
      ? "openrouter"
      : "faux";
if (process.env.LAB_PROVIDER && process.env.LAB_PROVIDER !== PROVIDER)
  console.warn(`LAB_PROVIDER=${process.env.LAB_PROVIDER} but its API key is not set: using the faux model`);
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;

if (!existsSync(join(BACKEND_DIR, "node_modules"))) {
  console.error(`dpi-backend dependencies missing. Run: cd ${BACKEND_DIR} && npm ci  (and the same in apps/dpi-sdk)`);
  process.exit(1);
}
mkdirSync(WORK_DIR, { recursive: true });

// Token persists across lab restarts so a restarted lab can still talk to the same data.
const tokenFile = join(LAB_HOME, "token");
const TOKEN = existsSync(tokenFile)
  ? readFileSync(tokenFile, "utf8").trim()
  : (() => {
      const t = randomBytes(24).toString("hex");
      writeFileSync(tokenFile, t, { mode: 0o600 });
      return t;
    })();

// ------------------------------------------------------------------ supervisor

type LabEvent =
  | { type: "status"; status: Status }
  | { type: "log"; line: string; at: number }
  | { type: "crash"; at: number; pid: number }
  | { type: "reset"; at: number };

type Status = {
  state: "starting" | "running" | "dead";
  pid?: number;
  startedAt?: number;
  diedAt?: number;
  crashes: number[];
  starts: number;
  provider: string;
  autoRestart: boolean;
  workDir: string;
  dataDir: string;
};

let child: Subprocess | undefined;
const status: Status = {
  state: "dead",
  crashes: [],
  starts: 0,
  provider: PROVIDER,
  autoRestart: false,
  workDir: WORK_DIR,
  dataDir: DATA_DIR,
};
const listeners = new Set<(e: LabEvent) => void>();
const logs: { line: string; at: number }[] = [];
const emit = (e: LabEvent) => listeners.forEach((l) => l(e));
const pushStatus = () => emit({ type: "status", status: { ...status } });
const log = (line: string) => {
  const entry = { line, at: Date.now() };
  logs.push(entry);
  if (logs.length > 200) logs.shift();
  emit({ type: "log", ...entry });
};

async function pipeLines(stream: ReadableStream<Uint8Array> | undefined, prefix = "") {
  if (!stream) return;
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trimEnd();
      buf = buf.slice(i + 1);
      if (line) log(prefix + line);
    }
  }
}

async function start() {
  if (child) return;
  status.state = "starting";
  status.diedAt = undefined;
  pushStatus();
  const proc = Bun.spawn(["node", "--import", "tsx", "src/main.ts"], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      DPI_HOME: LAB_HOME,
      DPI_ENV_FILE: join(LAB_HOME, "none.env"),
      DPI_DATA_DIR: DATA_DIR,
      DPI_TOKEN: TOKEN,
      DPI_PORT: String(BACKEND_PORT),
      DPI_HOST: "127.0.0.1",
      DPI_START_DIRS: WORK_DIR,
      DPI_DEVICE_NAME: "crash-lab",
      DPI_PROVIDER: PROVIDER,
      DPI_JOB_MODULES: join(import.meta.dir, "factory", "sdlc.ts"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  child = proc;
  status.pid = proc.pid;
  status.starts += 1;
  log(`▶ spawned dpi-backend pid ${proc.pid} (provider: ${PROVIDER})`);
  pipeLines(proc.stdout as ReadableStream<Uint8Array>);
  pipeLines(proc.stderr as ReadableStream<Uint8Array>, "stderr: ");
  proc.exited.then((code) => {
    if (child !== proc) return;
    child = undefined;
    status.state = "dead";
    status.diedAt = Date.now();
    log(`✕ dpi-backend pid ${proc.pid} exited (${proc.signalCode ?? `code ${code}`})`);
    pushStatus();
    if (status.autoRestart && !stopping) setTimeout(() => start(), 1500);
  });
  // Wait for /healthz.
  for (let i = 0; i < 80 && child === proc; i++) {
    try {
      const r = await fetch(`${BACKEND}/healthz`);
      if (r.ok) {
        status.state = "running";
        status.startedAt = Date.now();
        log(`● healthy on ${BACKEND} — unfinished durable tasks are recovering from SQLite`);
        pushStatus();
        return;
      }
    } catch {}
    await Bun.sleep(150);
  }
}

let stopping = false;
async function kill(signal: "SIGKILL" | "SIGTERM" = "SIGKILL") {
  const proc = child;
  if (!proc) return;
  if (signal === "SIGKILL") {
    status.crashes.push(Date.now());
    emit({ type: "crash", at: Date.now(), pid: proc.pid });
    log(`💥 kill -9 ${proc.pid} — no shutdown hooks, no flush, mid-whatever-it-was-doing`);
  }
  proc.kill(signal);
  await proc.exited;
}

async function reset() {
  stopping = true;
  await kill("SIGTERM");
  stopping = false;
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
  status.crashes = [];
  log("⟲ lab reset: SQLite data and workspace wiped");
  emit({ type: "reset", at: Date.now() });
  await start();
}

const shutdown = () => {
  stopping = true;
  child?.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ------------------------------------------------------------------ http

const json = (v: unknown, init?: ResponseInit) => Response.json(v, init);

async function proxy(req: Request, path: string) {
  const url = new URL(req.url);
  const headers = new Headers();
  headers.set("authorization", `Bearer ${TOKEN}`);
  const ct = req.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);
  try {
    const upstream = await fetch(`${BACKEND}/v1/${path}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      signal: req.signal,
    });
    const out = new Headers();
    for (const k of ["content-type", "cache-control", "idempotent-replay"]) {
      const v = upstream.headers.get(k);
      if (v) out.set(k, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch {
    return json({ error: { code: "offline", message: "dpi-backend is not running" } }, { status: 502 });
  }
}

function labEvents(req: Request) {
  const enc = new TextEncoder();
  let send: (e: LabEvent | { type: "logs"; items: typeof logs }) => void = () => {};
  let ping: ReturnType<typeof setInterval>;
  const stream = new ReadableStream({
    start(ctrl) {
      send = (e) => {
        try {
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {}
      };
      listeners.add(send);
      send({ type: "status", status: { ...status } });
      send({ type: "logs", items: logs.slice(-60) });
      ping = setInterval(() => send({ type: "status", status: { ...status } }), 5000);
      req.signal.addEventListener("abort", () => {
        listeners.delete(send);
        clearInterval(ping);
        try {
          ctrl.close();
        } catch {}
      });
    },
    cancel() {
      listeners.delete(send);
      clearInterval(ping);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

const factory = factoryRoutes({
  labHome: LAB_HOME,
  labDir: import.meta.dir,
  backend: (path, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${TOKEN}`);
    return fetch(`${BACKEND}/v1${path}`, { ...init, headers });
  },
  mode: () => (PROVIDER === "faux" ? "scripted" : "live"),
});

Bun.serve({
  port: LAB_PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/" || p === "/index.html") return new Response(Bun.file(join(import.meta.dir, "public", "index.html")));
    if (p === "/factory" || p === "/factory.html") return new Response(Bun.file(join(import.meta.dir, "public", "factory.html")));
    if (p.startsWith("/factory/")) {
      try {
        const r = await factory(req, url);
        if (r) return r;
      } catch (e) {
        return json({ error: { code: "internal", message: String((e as Error)?.message ?? e) } }, { status: 500 });
      }
    }
    if (p.startsWith("/api/")) return proxy(req, p.slice(5));
    if (p === "/lab/events") return labEvents(req);
    if (p === "/lab/status") return json(status);
    if (req.method === "POST") {
      if (p === "/lab/kill") return (await kill("SIGKILL"), json({ ok: true }));
      if (p === "/lab/start") return (await start(), json({ ok: true }));
      if (p === "/lab/crash-restart") {
        await kill("SIGKILL");
        await Bun.sleep(1200);
        await start();
        return json({ ok: true });
      }
      if (p === "/lab/auto-restart") {
        status.autoRestart = !status.autoRestart;
        pushStatus();
        if (status.autoRestart && !child) start();
        return json({ ok: true });
      }
      if (p === "/lab/reset") return (await reset(), json({ ok: true }));
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`Durable Pi Crash Lab → http://localhost:${LAB_PORT}   (backend :${BACKEND_PORT}, provider ${PROVIDER}, data ${LAB_HOME})`);
start();

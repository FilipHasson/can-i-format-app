#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// The flag above silences the one-off notice that `node:sqlite` is
// experimental. It has to be a process flag: static imports load `node:sqlite`
// while the module graph is being instantiated, before any of our code has run
// and could intercept the warning.
//
// There was a `process.env.UV_THREADPOOL_SIZE ??= "16"` here, on the theory
// that the walker and the metadata reader are bounded by libuv's pool and its
// default of four leaves a fast disk idle. It never did anything: the pool is
// built during Node's own bootstrap, ahead of this line and ahead even of a
// `--require` preload, so the variable can only come from the environment.
// `npm run probe:pool` measures what a run actually got.
//
// Nothing is lost by dropping it. Indexing 3,000 files with capture times read
// took 210ms at four threads and 220ms at sixteen — the concurrency that
// matters is `core/pool.ts`, which this code sets for itself. Export the
// variable before launching if a cold or networked library ever suggests
// otherwise.

import { spawn } from "node:child_process";
import { loadConfig } from "./core/config.ts";
import { openDb, closeDb } from "./core/db.ts";
import { configFile, dbFile } from "./core/paths.ts";
import { startServer } from "./server/server.ts";

function parseArgs(argv: string[]): { port?: number; open: boolean; help: boolean } {
  const args = { open: true, help: false } as { port?: number; open: boolean; help: boolean };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-open") args.open = false;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--port" || arg === "-p") {
      const value = Number(argv[++i]);
      if (Number.isFinite(value)) args.port = value;
    }
  }
  return args;
}

function openBrowser(url: string): void {
  const [command, commandArgs] =
    process.platform === "win32"
      ? ["cmd.exe", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];

  try {
    // Detached and ignored: the browser must outlive nothing and must not hold
    // this process open or spill output into the terminal.
    spawn(command, commandArgs, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // Headless boxes and bare containers have no browser; the URL is printed.
  }
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`can-i-format — audit physical media against your libraries

  Usage: can-i-format [options]

  Options:
    -p, --port <n>   Port for the local UI (default: from config, else 4111)
        --no-open    Do not open a browser window
    -h, --help       Show this message

  Config: ${configFile()}
  Index:  ${dbFile()}

This tool never writes to, deletes from, or formats a card. It reports only.`);
  process.exit(0);
}

const config = await loadConfig();
if (args.port !== undefined) config.port = args.port;

const db = openDb();
const server = await startServer(db, config);

console.log(`\n  Can I Format?  ${server.url}\n`);
if (config.libraries.length === 0) {
  console.log("  No libraries configured yet — the page will walk you through it.\n");
}

if (args.open) openBrowser(server.url);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.close().catch(() => {});
  closeDb();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

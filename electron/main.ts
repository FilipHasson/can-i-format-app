/**
 * The desktop shell.
 *
 * Nothing about reading a card, matching it or copying from it lives here.
 * This process boots the same `startServer` the CLI does and points a window
 * at it, so the app and `npm start` cannot drift apart in behaviour — only in
 * how they are launched. The window is the browser, removed as a thing the
 * user has to think about.
 *
 * The renderer gets no Node access whatsoever: `contextIsolation` on,
 * `nodeIntegration` off, `sandbox` on, no preload. It reaches the filesystem
 * the way the page always has, through the loopback API, which already refuses
 * a request whose Host header is not local.
 *
 * There is deliberately no `process.env.UV_THREADPOOL_SIZE = ...` here. The
 * pool the walker and the metadata reader are bounded by is already built by
 * the time any of this runs — measurably so, even from a `--require` preload —
 * so setting it from inside the process reads as a tuning that is happening
 * and is not one. It can only come from the environment the app was launched
 * with, and `npm run probe:pool` says what was actually got.
 */

import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, Menu, dialog, nativeTheme, screen, shell } from "electron";

import { loadConfig } from "../src/core/config.ts";
import { openDb, closeDb } from "../src/core/db.ts";
import { configDir } from "../src/core/paths.ts";
import { startServer, type StartedServer } from "../src/server/server.ts";
import {
  isInternalUrl,
  isSafeExternal,
  parseWindowState,
  placeWindow,
  type WindowBounds,
} from "./policy.ts";

/** Matches `--bg` in `web/style.css`, so opening does not flash the wrong colour. */
const BACKGROUND = { light: "#f6f7f9", dark: "#14171b" };
const DEFAULT_SIZE = { width: 1180, height: 820 };
const APP_ID = "com.filiphasson.can-i-format";

let server: StartedServer | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

/**
 * A second launch must not start a second server against the same index. Two
 * job runners writing one SQLite file is a way to lose an index that no
 * amount of care inside either process would prevent. Whoever holds the lock
 * gets the window; everyone else hands their argv over and leaves.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // Registered now rather than after the first await: with an ESM entry point
  // the app can become ready while this module is still evaluating, and a
  // lifecycle listener attached afterwards misses the event it was for.
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    void shutdown();
  });

  void boot();
}

async function boot(): Promise<void> {
  try {
    if (process.platform === "win32") app.setAppUserModelId(APP_ID);
    await app.whenReady();

    const config = await loadConfig();
    const db = openDb();
    server = await startServer(db, config);

    Menu.setApplicationMenu(buildMenu());
    mainWindow = createWindow(server.url);
    await mainWindow.loadURL(server.url);
  } catch (err) {
    // There is no terminal to print a stack to. Saying nothing would leave an
    // icon that was clicked and did nothing at all.
    dialog.showErrorBox(
      "Can I Format? could not start",
      `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n\n` +
        `Configuration and index live in:\n${safeConfigDir()}`,
    );
    quitting = true;
    app.exit(1);
  }
}

function createWindow(origin: string): BrowserWindow {
  const placed = placeWindow(readWindowState(), screen.getAllDisplays().map((d) => d.workArea), DEFAULT_SIZE);

  const window = new BrowserWindow({
    ...placed,
    minWidth: 860,
    minHeight: 560,
    title: "Can I Format?",
    // Shown on `ready-to-show` instead, so the first thing on screen is the
    // page rather than an empty frame filling in.
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    autoHideMenuBar: true,
    ...(icon() ? { icon: icon() as string } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  if (placed.maximized) window.maximize();
  window.once("ready-to-show", () => window.show());

  // Anything that is not this app opens where links belong: in the browser,
  // in a process that cannot see the API.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url) && !isInternalUrl(url, origin)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isInternalUrl(url, origin)) return;
    event.preventDefault();
    if (isSafeExternal(url)) void shell.openExternal(url);
  });

  window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 is ERR_ABORTED, which a cancelled sub-request reports and which means
    // nothing went wrong.
    if (!isMainFrame || code === -3) return;
    dialog.showErrorBox("The page did not load", `${description} (${code})\n${url}`);
  });

  window.on("close", () => saveWindowState(window));
  window.on("closed", () => {
    mainWindow = null;
  });

  return window;
}

/**
 * Quitting has to end, so the server is given a moment and then left behind.
 * `close()` waits for open connections and the page holds an event stream
 * open for job progress; if the window is already gone that socket dies with
 * it, but a wedged one must not turn File → Quit into a process to hunt down
 * in Task Manager.
 */
async function shutdown(): Promise<void> {
  quitting = true;
  for (const window of BrowserWindow.getAllWindows()) window.destroy();

  const closed = server?.close().catch(() => {}) ?? Promise.resolve();
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1500))]);

  try {
    closeDb();
  } catch {
    // Already closed, or never opened, because startup is where this failed.
  }
  app.quit();
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [{ role: "quit" }],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
  ]);
}

/**
 * Beside the config and the index, not in Electron's own userData directory:
 * one installation, one place, whichever way it was started.
 */
function windowStateFile(): string {
  return path.join(configDir(), "window.json");
}

function safeConfigDir(): string {
  try {
    return configDir();
  } catch {
    return "(unavailable)";
  }
}

function readWindowState(): Partial<WindowBounds> | null {
  try {
    return parseWindowState(fs.readFileSync(windowStateFile(), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Written synchronously: this runs while the window is closing, and an async
 * write is a promise the process may not be alive to keep.
 */
function saveWindowState(window: BrowserWindow): void {
  try {
    if (window.isDestroyed()) return;
    // `getNormalBounds` is the un-maximised geometry, so restoring down after
    // a restart gives back the window that was there before, not a full screen.
    const bounds = window.getNormalBounds();
    const state: WindowBounds = { ...bounds, maximized: window.isMaximized() };
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(windowStateFile(), JSON.stringify(state));
  } catch {
    // Where the window was is not worth failing to close over.
  }
}

/** Present once `npm run icon` has drawn it; Electron's own is the fallback. */
function icon(): string | null {
  const file = path.join(import.meta.dirname, "..", "build", "icon.ico");
  return fs.existsSync(file) ? file : null;
}

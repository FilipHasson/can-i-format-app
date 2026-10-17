/**
 * Boots the real desktop app against a throwaway installation, photographs
 * what came up, and leaves.
 *
 * A window that opens is not the same as a window with the app in it: a failed
 * `loadURL`, a server that never listened, a page whose stylesheet 404ed from
 * inside an asar archive all produce a window. So this asks the shell for a
 * picture of itself and writes it out, which is the one check that cannot pass
 * while the thing is blank.
 *
 *   npm run app:smoke                 # into build/smoke.png
 *   npm run app:smoke -- out.png
 *
 * It imports `main.ts` rather than reproducing it, so what is photographed is
 * the app and not an arrangement that resembles it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describePool, measurePool } from "../tools/pool-probe.ts";

// Before importing main.ts, which resolves the installation on the way up.
// A smoke run must never open the real index, and must never be the reason a
// `window.json` appears in someone's config directory.
const home =
  process.env.CAN_I_FORMAT_HOME ??
  fs.mkdtempSync(path.join(os.tmpdir(), "can-i-format-smoke-"));
process.env.CAN_I_FORMAT_HOME = home;

const { app, BrowserWindow } = await import("electron");
await import("./main.ts");

const target = path.resolve(process.argv[2] ?? "build/smoke.png");
const deadline = Date.now() + 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function window(): Promise<Electron.BrowserWindow> {
  for (;;) {
    const [first] = BrowserWindow.getAllWindows();
    if (first) return first;
    if (Date.now() > deadline) throw new Error("no window appeared");
    await sleep(100);
  }
}

async function shoot(): Promise<void> {
  await app.whenReady();
  const win = await window();

  if (win.webContents.isLoadingMainFrame()) {
    await new Promise<void>((resolve, reject) => {
      win.webContents.once("did-finish-load", () => resolve());
      win.webContents.once("did-fail-load", (_e, code, description) =>
        reject(new Error(`did-fail-load ${code}: ${description}`)),
      );
    });
  }

  // The page fetches its state after load; a picture taken the instant the
  // document is parsed shows an empty shell and proves nothing.
  await sleep(1500);

  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  if (png.length === 0) throw new Error("captured nothing");

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, png);

  const title = await win.webContents.executeJavaScript("document.title");
  const headline = await win.webContents.executeJavaScript(
    "document.querySelector('h1')?.textContent ?? ''",
  );
  console.log(`${target}  ${image.getSize().width}×${image.getSize().height}`);
  console.log(`title: ${JSON.stringify(title)}  h1: ${JSON.stringify(headline)}`);
  console.log(`home:  ${home}`);

  // What the app really got, which no line inside the app can change: the
  // pool exists before the entry module is evaluated.
  console.log(describePool(await measurePool()));
}

/**
 * Started rather than awaited, and this is not a style choice: Electron emits
 * `ready` only once the entry module has finished evaluating, so a top-level
 * `await app.whenReady()` is a module waiting on an event that is waiting on
 * the module. It hangs with no window and no output. `main.ts` is safe for the
 * same reason — it calls `boot()` without awaiting it.
 */
void shoot().then(
  () => app.exit(0),
  (err: unknown) => {
    console.error(`smoke failed: ${err instanceof Error ? err.message : String(err)}`);
    app.exit(1);
  },
);

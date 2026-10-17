import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import type { Db } from "../core/db.ts";
import {
  CONFIGURABLE_KINDS,
  IMPORT_GROUPS,
  defaultLibrary,
  makeKey,
  suggestRule,
  validateConfig,
  type AppConfig,
  type ImportConfig,
  type ImportGroup,
  type LibraryConfig,
} from "../core/config.ts";
import { FOLDER_PRESETS, TOKENS } from "../core/template.ts";
import { IMPORT_STAGES, exampleFor, importFromScan, libraryRoots, planImport } from "../scan/import.ts";
import { validateRule } from "../core/rules.ts";
import { TIER_LABEL, TIERS } from "../core/tiers.ts";
import { normPath } from "../core/paths.ts";
import {
  indexLibrary,
  indexStage,
  indexStages,
  renameLibraryKey,
  summarizeLibraries,
} from "../index/library.ts";
import type { IndexProgress } from "../index/types.ts";
import { SCAN_STAGES, scanCard } from "../scan/card.ts";
import { describePath, listVolumes } from "../scan/volumes.ts";
import { identify } from "../scan/identity.ts";
import {
  deleteAllScans,
  deleteScan,
  getScanFileRow,
  getScanFiles,
  getScanRow,
  getScanTree,
  listScans,
} from "../scan/query.ts";
import { readThumbnail } from "../core/thumbnail.ts";
import { browse } from "./browse.ts";
import type { JobManager } from "./jobs.ts";

export interface AppContext {
  db: Db;
  jobs: JobManager;
  config: AppConfig;
  saveConfig: (config: AppConfig) => Promise<void>;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2 * 1024 * 1024) throw new HttpError(413, "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("expected an object");
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new HttpError(400, `Invalid JSON body: ${(err as Error).message}`);
  }
}

/** Everything the UI needs to render, in one round trip. */
function appState(ctx: AppContext) {
  const problems = validateConfig(ctx.config);
  return {
    config: ctx.config,
    libraries: summarizeLibraries(ctx.db).map((summary) => {
      const configured = ctx.config.libraries.find((l) => l.key === summary.key);
      return {
        ...summary,
        configured: configured ?? null,
        // Where an import into this library would put files. For a catalog
        // that is not the catalog file itself, so the UI cannot work it out.
        importRoots: configured ? libraryRoots(ctx.db, configured) : [],
      };
    }),
    /** Configured but never indexed — the UI nudges these. */
    unindexed: ctx.config.libraries
      .filter((l) => !ctx.db.getLibrary(l.key))
      .map((l) => l.key),
    problems,
    ready: problems.length === 0 && ctx.config.libraries.length > 0,
    tiers: TIERS.map((tier) => ({ tier, label: TIER_LABEL[tier] })),
    activeJob: ctx.jobs.active,
    platform: process.platform,
    /** The template vocabulary, so the UI never keeps its own copy of the list. */
    importGroups: IMPORT_GROUPS,
    importTokens: TOKENS,
    folderPresets: FOLDER_PRESETS,
  };
}

/**
 * Merges an import-settings patch onto the current one.
 *
 * Pure and total: it either returns settings worth saving or throws with a
 * message worth showing. A destination folder is required to exist — creating
 * it here would mean a typo silently becomes a new folder tree holding half
 * someone's archive.
 */
async function mergeImportSettings(
  current: ImportConfig,
  raw: unknown,
  libraries: readonly LibraryConfig[],
): Promise<ImportConfig> {
  if (typeof raw !== "object" || raw === null) {
    throw new HttpError(400, "Import settings must be an object.");
  }
  const r = raw as Record<string, unknown>;
  const next: ImportConfig = {
    ...current,
    destinations: { ...current.destinations },
  };

  if (typeof r.folderTemplate === "string") next.folderTemplate = r.folderTemplate;
  if (typeof r.filenameTemplate === "string") {
    if (r.filenameTemplate.trim() === "") {
      throw new HttpError(400, "A file name template cannot be empty.");
    }
    next.filenameTemplate = r.filenameTemplate;
  }

  if (typeof r.destinations === "object" && r.destinations !== null) {
    const patch = r.destinations as Record<string, unknown>;
    for (const group of IMPORT_GROUPS) {
      if (!(group in patch)) continue;
      const value = patch[group];

      if (value === null) {
        delete next.destinations[group as ImportGroup];
        continue;
      }
      if (typeof value !== "object") throw new HttpError(400, `Bad destination for ${group}.`);
      const mode = (value as Record<string, unknown>).mode;

      if (mode === "skip") {
        next.destinations[group as ImportGroup] = { mode: "skip" };
      } else if (mode === "library") {
        const key = (value as Record<string, unknown>).libraryKey;
        if (typeof key !== "string" || !libraries.some((l) => l.key === key)) {
          throw new HttpError(400, `${group} were pointed at a library that does not exist.`);
        }
        next.destinations[group as ImportGroup] = { mode: "library", libraryKey: key };
      } else if (mode === "folder") {
        const target = (value as Record<string, unknown>).path;
        if (typeof target !== "string" || target.trim() === "") {
          throw new HttpError(400, `${group} were given no destination folder.`);
        }
        const resolved = normPath(target.trim());
        const stat = await fs.stat(resolved).catch(() => null);
        if (!stat?.isDirectory()) throw new HttpError(400, `${resolved} is not a folder.`);
        next.destinations[group as ImportGroup] = { mode: "folder", path: resolved };
      } else {
        throw new HttpError(400, `Unknown destination mode for ${group}.`);
      }
    }
  }

  return next;
}

async function addLibrary(ctx: AppContext, body: Record<string, unknown>): Promise<void> {
  const target = typeof body.path === "string" ? body.path.trim() : "";
  if (target === "") throw new HttpError(400, "A path is required.");

  const resolved = normPath(target);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) throw new HttpError(400, `${resolved} does not exist.`);

  const isCatalog = resolved.toLowerCase().endsWith(".lrcat");
  if (isCatalog ? !stat.isFile() : !stat.isDirectory()) {
    throw new HttpError(
      400,
      isCatalog ? `${resolved} is not a file.` : `${resolved} is not a folder.`,
    );
  }

  if (ctx.config.libraries.some((l) => l.path === resolved)) {
    throw new HttpError(409, "That location is already configured as a library.");
  }

  const label =
    typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim() : undefined;
  const taken = ctx.config.libraries.map((l) => l.key);

  const library = defaultLibrary({
    path: resolved,
    ...(label ? { label, key: makeKey(label, taken) } : {}),
    ...(body.metadata === "full" || body.metadata === "lazy"
      ? { metadata: body.metadata }
      : {}),
  });
  if (!label) library.key = makeKey(library.label, taken);

  const before = [...ctx.config.libraries];
  ctx.config.libraries.push(library);

  // Keep the default rule in step with the library list, but never clobber a
  // rule the user wrote. Without this, adding a second library would leave the
  // rule naming only the first — and files present in just one place would go
  // on reporting as safe, which is the one mistake this tool must not make.
  if (ctx.config.rule.trim() === "" || ctx.config.rule === suggestRule(before)) {
    ctx.config.rule = suggestRule(ctx.config.libraries);
  }

  await ctx.saveConfig(ctx.config);
}

/**
 * Phase names are internal identifiers. Everything here reaches the progress
 * banner verbatim, so each one has to read as a sentence — "sweeping" and
 * "done" were being shown to the user as-is.
 */
function indexMessage(p: IndexProgress): string {
  const files = p.files.toLocaleString();
  switch (p.phase) {
    case "starting":
      return "Starting";
    case "copying-catalog":
      return "Copying the catalog, so Lightroom can stay open";
    case "walking":
      return `Scanning folders — ${files} files in ${p.directories.toLocaleString()} folders`;
    case "reading-catalog":
      return p.total
        ? `Reading catalog — ${files} of ${p.total.toLocaleString()} files`
        : `Reading catalog — ${files} files`;
    case "sweeping":
      return "Checking for files that have been deleted";
    case "metadata":
      return "Reading capture times";
    case "done":
      return `Finished — ${files} files indexed`;
  }
}

/** `exactOptionalPropertyTypes` will not take an explicit undefined. */
function withPhase(phase: string | undefined): { phase?: string } {
  return phase === undefined ? {} : { phase };
}

function requireLibrary(ctx: AppContext, key: string): LibraryConfig {
  const library = ctx.config.libraries.find((l) => l.key === key);
  if (!library) throw new HttpError(404, `No library called "${key}".`);
  return library;
}

async function applyConfigPatch(ctx: AppContext, body: Record<string, unknown>): Promise<void> {
  const next: AppConfig = { ...ctx.config };

  if (typeof body.rule === "string") next.rule = body.rule;
  if (typeof body.minTier === "string" && (TIERS as readonly string[]).includes(body.minTier)) {
    next.minTier = body.minTier as AppConfig["minTier"];
  }
  if (typeof body.ignoreSidecars === "boolean") next.ignoreSidecars = body.ignoreSidecars;
  if (body.hashMode === "quick" || body.hashMode === "full") next.hashMode = body.hashMode;
  if (typeof body.setupComplete === "boolean") next.setupComplete = body.setupComplete;

  if (typeof body.kinds === "object" && body.kinds !== null) {
    const kinds: AppConfig["kinds"] = { ...next.kinds };
    for (const kind of CONFIGURABLE_KINDS) {
      const patch = (body.kinds as Record<string, unknown>)[kind];
      if (patch === null) {
        delete kinds[kind];
        continue;
      }
      if (typeof patch !== "object") continue;
      const mode = (patch as Record<string, unknown>).mode;
      if (mode === "default") delete kinds[kind];
      else if (mode === "ignore") kinds[kind] = { mode: "ignore" };
      else if (mode === "rule") {
        const rule = (patch as Record<string, unknown>).rule;
        if (typeof rule !== "string" || rule.trim() === "") {
          throw new HttpError(400, `${kind} is set to its own rule, but no rule was given.`);
        }
        const enabled = next.libraries.filter((l) => l.enabled).map((l) => l.key);
        const check = validateRule(rule, enabled);
        if (!check.ok) throw new HttpError(400, `${kind} rule: ${check.error ?? "invalid."}`);
        kinds[kind] = { mode: "rule", rule };
      }
    }
    next.kinds = kinds;
  }
  if (body.import !== undefined) {
    next.import = await mergeImportSettings(next.import, body.import, next.libraries);
  }
  if (Array.isArray(body.ignoreExtensions)) {
    next.ignoreExtensions = body.ignoreExtensions
      .filter((e): e is string => typeof e === "string")
      .map((e) => e.toLowerCase().replace(/^\./, ""));
  }

  if (Array.isArray(body.libraries)) {
    // Only the mutable per-library fields; identity and path are set elsewhere.
    next.libraries = next.libraries.map((library) => {
      const patch = (body.libraries as Array<Record<string, unknown>>).find(
        (l) => l.key === library.key,
      );
      if (!patch) return library;
      return {
        ...library,
        ...(typeof patch.label === "string" && patch.label.trim() !== ""
          ? { label: patch.label.trim() }
          : {}),
        ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
        ...(patch.metadata === "full" || patch.metadata === "lazy"
          ? { metadata: patch.metadata as LibraryConfig["metadata"] }
          : {}),
        ...(Array.isArray(patch.excludes)
          ? { excludes: patch.excludes.filter((e): e is string => typeof e === "string") }
          : {}),
      };
    });
  }

  const problems = validateConfig(next);
  const fatal = problems.filter((p) => p.field !== "rule" || next.rule.trim() !== "");
  if (fatal.length > 0) {
    throw new HttpError(400, fatal.map((p) => p.message).join(" "));
  }

  ctx.config = next;
  await ctx.saveConfig(next);
}

/** Returns true when the request was an API route and has been answered. */
export async function handleApi(
  ctx: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/")) return false;

  const method = req.method ?? "GET";
  const segments = url.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);
  const [head, id, action, sub] = segments;

  try {
    // ---- state and configuration ---------------------------------------
    if (head === "state" && method === "GET") {
      json(res, 200, appState(ctx));
      return true;
    }

    if (head === "config" && method === "PUT") {
      await applyConfigPatch(ctx, await readJson(req));
      json(res, 200, appState(ctx));
      return true;
    }

    if (head === "rule" && method === "POST") {
      const body = await readJson(req);
      const enabled = ctx.config.libraries.filter((l) => l.enabled).map((l) => l.key);
      json(res, 200, validateRule(String(body.rule ?? ""), enabled));
      return true;
    }

    // ---- libraries -------------------------------------------------------
    // Guarded on `!id` so it cannot swallow /api/libraries/:key/index.
    if (head === "libraries" && !id && method === "POST") {
      await addLibrary(ctx, await readJson(req));
      json(res, 200, appState(ctx));
      return true;
    }

    if (head === "libraries" && id && method === "DELETE") {
      requireLibrary(ctx, id);
      ctx.config.libraries = ctx.config.libraries.filter((l) => l.key !== id);
      ctx.db.deleteLibrary(id);
      // A rule naming a library that no longer exists would fail validation on
      // every save, so clear it back to something coherent.
      if (!validateRule(ctx.config.rule, ctx.config.libraries.map((l) => l.key)).ok) {
        ctx.config.rule = suggestRule(ctx.config.libraries);
      }
      await ctx.saveConfig(ctx.config);
      json(res, 200, appState(ctx));
      return true;
    }

    if (head === "libraries" && id && action === "key" && method === "POST") {
      requireLibrary(ctx, id);
      // A running index, scan or import has the old key in hand and would
      // write it back after the rename.
      if (ctx.jobs.active) {
        throw new HttpError(409, `Wait for "${ctx.jobs.active.label}" to finish before changing a key.`);
      }
      const body = await readJson(req);
      const to = typeof body.key === "string" ? body.key.trim() : "";

      let next: AppConfig;
      try {
        next = renameLibraryKey(ctx.db, ctx.config, id, to);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
      try {
        await ctx.saveConfig(next);
      } catch (err) {
        // The index already says the new key; put it back so the two agree.
        renameLibraryKey(ctx.db, next, to, id);
        throw err;
      }
      json(res, 200, appState(ctx));
      return true;
    }

    if (head === "libraries" && id && action === "index" && method === "POST") {
      const body = await readJson(req);
      const library = requireLibrary(ctx, id);
      const mode = body.mode === "full" ? "full" : "incremental";

      const job = ctx.jobs.start(
        "index",
        `Indexing ${library.label}`,
        (report, signal) =>
        indexLibrary(ctx.db, library, {
          mode,
          signal,
          onProgress: (p) =>
            report({
              ...withPhase(indexStage(p.phase)),
              message: p.message ?? indexMessage(p),
              done: p.done ?? p.files,
              // Zero means indeterminate, which a walk genuinely is — it
              // cannot know its total until it has finished walking.
              total: p.total ?? 0,
              bytes: p.bytes ?? 0,
              totalBytes: p.totalBytes ?? 0,
              rateUnit: p.rateUnit ?? "files",
            }),
        }),
        indexStages(library),
      );
      json(res, 202, job);
      return true;
    }

    // ---- volumes and browsing -------------------------------------------
    if (head === "volumes" && method === "GET") {
      const volumes = await listVolumes();
      // Identifying registers a card the first time it is seen, so the name it
      // is given now is the name it keeps.
      json(
        res,
        200,
        { volumes: volumes.map((v) => ({ ...v, identity: identify(ctx.db, v) })) },
      );
      return true;
    }

    if (head === "folders" && method === "POST") {
      const body = await readJson(req);
      const target = typeof body.path === "string" ? body.path.trim() : "";
      if (target === "") throw new HttpError(400, "A path is required.");

      const resolved = normPath(target);
      const stat = await fs.stat(resolved).catch(() => null);
      if (!stat?.isDirectory()) throw new HttpError(400, `${resolved} is not a folder.`);

      if (!ctx.config.savedFolders.some((f) => f.path === resolved)) {
        const label =
          typeof body.label === "string" && body.label.trim() !== ""
            ? body.label.trim()
            : resolved.replace(/\/+$/, "").split("/").pop() || resolved;
        ctx.config.savedFolders.push({ path: resolved, label });
        await ctx.saveConfig(ctx.config);
      }
      json(res, 200, appState(ctx));
      return true;
    }

    if (head === "folders" && method === "DELETE") {
      const target = url.searchParams.get("path");
      if (!target) throw new HttpError(400, "A path is required.");
      const resolved = normPath(target);

      const before = ctx.config.savedFolders.length;
      ctx.config.savedFolders = ctx.config.savedFolders.filter((f) => f.path !== resolved);
      if (ctx.config.savedFolders.length === before) throw new HttpError(404, "Not a saved folder.");

      await ctx.saveConfig(ctx.config);
      json(res, 200, appState(ctx));
      return true;
    }

    if (head === "browse" && method === "POST") {
      const body = await readJson(req);
      json(res, 200, await browse(typeof body.path === "string" ? body.path : undefined));
      return true;
    }

    if (head === "describe" && method === "POST") {
      const body = await readJson(req);
      const described = await describePath(String(body.path ?? ""));
      if (!described) throw new HttpError(400, "That path is not a readable folder.");
      json(res, 200, described);
      return true;
    }

    // ---- scans ------------------------------------------------------------
    if (head === "scans" && !id && method === "POST") {
      const body = await readJson(req);
      const root = typeof body.root === "string" ? body.root.trim() : "";
      if (root === "") throw new HttpError(400, "A card path is required.");

      const stat = await fs.stat(normPath(root)).catch(() => null);
      if (!stat?.isDirectory()) throw new HttpError(400, `${root} is not a readable folder.`);

      const label = typeof body.label === "string" ? body.label : undefined;
      const job = ctx.jobs.start("scan", `Scanning ${label ?? root}`, (report, signal) =>
        scanCard(ctx.db, ctx.config, root, {
          ...(label ? { label } : {}),
          signal,
          onProgress: (p) =>
            report({
              ...withPhase(p.stage),
              ...(p.counts === false ? { counts: false } : {}),
              message: p.message,
              done: p.done,
              total: p.total,
              bytes: p.bytes,
              totalBytes: p.totalBytes,
              rateUnit: p.rateUnit ?? "files",
            }),
        }),
        [...SCAN_STAGES],
      );
      json(res, 202, job);
      return true;
    }

    if (head === "scans" && !id && method === "GET") {
      json(res, 200, { scans: listScans(ctx.db, 25) });
      return true;
    }

    if (head === "scans" && id && !action && method === "GET") {
      const scan = getScanRow(ctx.db, Number(id));
      if (!scan) throw new HttpError(404, "No such scan.");

      let warnings: string[] = [];
      try {
        const stats = JSON.parse(scan.stats ?? "{}") as { warnings?: string[] };
        warnings = stats.warnings ?? [];
      } catch {
        // An unreadable stats blob only costs us the warnings list.
      }

      json(res, 200, { scan, warnings, ...getScanTree(ctx.db, Number(id)) });
      return true;
    }

    if (head === "scans" && id && action === "thumb" && method === "GET") {
      const scan = getScanRow(ctx.db, Number(id));
      if (!scan) throw new HttpError(404, "No such scan.");

      const raw = url.searchParams.get("file");
      const fileId = Number(raw);
      if (raw === null || raw === "" || !Number.isInteger(fileId)) {
        throw new HttpError(400, "A file id is required.");
      }

      const row = getScanFileRow(ctx.db, Number(id), fileId);
      if (!row) throw new HttpError(404, "No such file in this scan.");

      // Trailing slash stripped first: scanning a whole card gives a root of
      // "I:/", and a prefix of "I://" matches nothing on it.
      const root = normPath(scan.root).replace(/\/+$/, "");
      const dir = row.rel_dir === "" ? root : `${root}/${row.rel_dir}`;
      const absolute = normPath(`${dir}/${row.name}`);
      // The row came from our own index, but a preview handler that reads
      // whatever a path says is one bad row away from serving any file on the
      // disk. Containment is cheap; leaving it out is not.
      if (absolute !== root && !absolute.startsWith(`${root}/`)) {
        throw new HttpError(404, "No such file in this scan.");
      }

      const thumb = await readThumbnail(absolute, row.ext, row.size, row.mtime_ms);
      if (!thumb) {
        res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
        res.end("No preview");
        return true;
      }

      const etag = `"${thumb.tag}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag });
        res.end();
        return true;
      }

      res.writeHead(200, {
        "content-type": thumb.contentType,
        "content-length": thumb.bytes.length,
        // Keyed on size and mtime, so the URL changes when the file does.
        "cache-control": "private, max-age=31536000, immutable",
        etag,
        // Previews of someone's photographs should not be embeddable.
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
      });
      res.end(thumb.bytes);
      return true;
    }

    if (head === "scans" && id && action === "files" && method === "GET") {
      const scan = getScanRow(ctx.db, Number(id));
      if (!scan) throw new HttpError(404, "No such scan.");

      const dir = url.searchParams.get("dir");
      json(
        res,
        200,
        getScanFiles(ctx.db, Number(id), {
          ...(dir !== null ? { dir } : {}),
          recursive: url.searchParams.get("recursive") === "1",
          onlyBlocked: url.searchParams.get("blocked") === "1",
          limit: Math.min(Number(url.searchParams.get("limit") ?? 200) || 200, 2000),
          offset: Number(url.searchParams.get("offset") ?? 0) || 0,
        }),
      );
      return true;
    }

    // ---- importing what a scan found missing --------------------------------
    // `/plan` says what would happen and writes nothing; the bare route does
    // it. Both accept settings so the dialog can preview a change before it is
    // committed to, and both persist them, so what was previewed is what runs.
    if (head === "scans" && id && action === "import" && method === "POST") {
      const scan = getScanRow(ctx.db, Number(id));
      if (!scan) throw new HttpError(404, "No such scan.");

      const body = await readJson(req);

      // Live feedback while a template is being typed: no destination needed,
      // nothing saved, nothing written. Kept ahead of the settings merge so a
      // half-typed template never reaches the config.
      if (sub === "example") {
        json(res, 200, {
          example: exampleFor(
            ctx.db,
            Number(id),
            typeof body.folderTemplate === "string" ? body.folderTemplate : "",
            typeof body.filenameTemplate === "string" && body.filenameTemplate.trim() !== ""
              ? body.filenameTemplate
              : "{name}",
          ),
        });
        return true;
      }

      if (body.settings !== undefined) {
        const merged = await mergeImportSettings(
          ctx.config.import,
          body.settings,
          ctx.config.libraries,
        );
        const candidate: AppConfig = { ...ctx.config, import: merged };
        const bad = validateConfig(candidate).filter((p) => p.field.startsWith("import."));
        if (bad.length > 0) throw new HttpError(400, bad.map((p) => p.message).join(" "));

        ctx.config = candidate;
        await ctx.saveConfig(candidate);
      }

      if (sub === "plan") {
        json(res, 200, { plan: await planImport(ctx.db, ctx.config, Number(id)), config: ctx.config });
        return true;
      }
      if (sub !== undefined) throw new HttpError(404, `No API route for ${url.pathname}`);

      const job = ctx.jobs.start(
        "import",
        `Importing from ${scan.label ?? scan.root}`,
        (report, signal) =>
          importFromScan(ctx.db, ctx.config, Number(id), {
            signal,
            onProgress: (p) =>
              report({
                ...withPhase(p.stage),
                ...(p.within === undefined ? {} : { within: p.within }),
                message: p.message,
                done: p.done,
                total: p.total,
                bytes: p.bytes ?? 0,
                totalBytes: p.totalBytes ?? 0,
                rateUnit: p.rateUnit ?? "files",
              }),
          }),
        [...IMPORT_STAGES],
      );
      json(res, 202, job);
      return true;
    }

    if (head === "scans" && id && method === "DELETE") {
      if (!getScanRow(ctx.db, Number(id))) throw new HttpError(404, "No such scan.");
      deleteScan(ctx.db, Number(id));
      json(res, 200, { ok: true });
      return true;
    }

    if (head === "scans" && !id && method === "DELETE") {
      json(res, 200, { ok: true, removed: deleteAllScans(ctx.db) });
      return true;
    }

    // ---- jobs -------------------------------------------------------------
    if (head === "jobs" && !id && method === "GET") {
      json(res, 200, { jobs: ctx.jobs.list(), active: ctx.jobs.active });
      return true;
    }

    if (head === "jobs" && id && action === "cancel" && method === "POST") {
      json(res, 200, { cancelled: ctx.jobs.cancel(id) });
      return true;
    }

    if (head === "jobs" && id && method === "GET") {
      const job = ctx.jobs.get(id);
      if (!job) throw new HttpError(404, "No such job.");
      json(res, 200, job);
      return true;
    }

    json(res, 404, { error: `No API route for ${method} ${url.pathname}` });
    return true;
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.message });
    } else {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
}

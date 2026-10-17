# Can I Format? — working notes

Answers "is this card already imported, and if not, what exactly is missing?"
User-facing behaviour is documented on the website, https://can-i-format-site.vercel.app/docs
(source in the private `can-i-format-site` repo). This file is the map for changing it.

## Ground rules

1. **Never write to, delete from, or unmount scanned media.** Any PR that adds
   a delete/format/eject path for a card is wrong by construction.

   Import does not bend this, and reading it as an exception is the way to
   break it. Bytes only ever move *from* the card *into* a library: the card's
   files, timestamps and directories are untouched, and nothing on it is
   removed once copied. Erasing stays a deliberate act performed elsewhere,
   after a fresh scan says it is safe. `scan/import.ts` is the only module in
   the project that writes anything at all — keep it that way, and keep its
   writes pointed at the destination.
2. **Errors bias toward "not safe".** A file we cannot confirm is blocked, never
   cleared. Losing footage is the only unrecoverable failure here.
3. **No build step.** Node runs the TypeScript directly, so only *erasable*
   syntax: no `enum`, no `namespace`, no parameter properties, and `import type`
   for type-only imports. `npm run typecheck` enforces it via `erasableSyntaxOnly`.
4. **One runtime dependency** (`exifr`). SQLite and the HTTP server are built in.
   Keep it that way unless there is a strong reason.

## Layout

```
src/core/      config, rules DSL, SQLite wrapper, metadata, hashing, paths,
               the import path template
src/index/     walking a library and getting it into the index
src/scan/      reading a card, matching it, rolling results up, importing
src/server/    HTTP API, job runner, static hosting
src/web/       the UI — plain HTML/CSS/ES modules, no framework
electron/      the desktop shell — a window pointed at the same server
tools/         fixture generator, the minimal EXIF writer it uses, the icon
```

Dependencies point one way: `web → server → scan → index → core`, with
`electron → server` alongside `web`.

## The parts that carry the weight

**`core/rules.ts`** — parser and evaluator for `(a or b) and c`. `describeGap`
is the one worth understanding: given a failed rule it returns *only* the unmet
clause, which is what makes the report readable.

**`core/metadata.ts`** — `capturedAt` is a timezone-free `YYYYMMDDHHMMSS`
integer, not an epoch. EXIF timestamps carry no zone and neither does
Lightroom's `captureTime`; converting would mean inventing an offset and getting
a different answer on a laptop that travelled. `buildCameraKey` is
`model|serial` and deliberately excludes the make, because catalogs only store
the model — see the comment there before "fixing" it.

**`index/walk.ts`** — extension filtering happens on the *name*, before any
`stat`. Directories whose mtime is unchanged skip per-file `stat` entirely.

**`scan/match.ts`** — batched passes over the whole card, not per file, so each
round of I/O is one concurrent sweep. Order matters:

1. `#capturePass` against already-cached metadata — **runs unconditionally**
2. indexed lookups — no file opened, and skipped per library where step 1
   already matched
3. targeted enrichment, then `#recheckProvisional` and the capture pass again
4. `#escalate`: full metadata read of libraries still blocking files
5. hashing, against the complete set of same-size library files

Capture time plus filename is the sharpest key available — a body shoots ten
thousand frames before repeating a name — so it goes first and the crowded
lookups are never reached for anything it settles. It cannot go first on the
*first* scan of a lazily indexed folder library: nothing has opened those files,
so there is no capture time to query. That scan falls through to steps 2-4 and
pays for the metadata read once; every scan afterwards starts and stops at
step 1. A Lightroom catalog gets capture time at index time and never pays it.

Step 1 used to live inside step 3's branch. That meant a rescan — nothing left
to enrich — skipped capture matching entirely and re-blocked files it had
already cleared. There is a test for it.

**No cap decides a verdict.** "Is this file in the library?" is asked as a
targeted indexed question with a definite answer — by capture identity, by name
and size together in one WHERE clause, and finally by content hash against
*every* library file of that byte size. An earlier design pulled a capped
candidate list and reasoned over it, which meant a real import sitting past the
cap was reported missing, and the user was told the answer might be wrong. An
index that cannot say yes or no is not worth having. The only capped lookup left
picks which files are worth *opening* to read capture times, and whatever it
misses `#escalate` reads in full.

**A name-and-size match is provisional until a capture time has had its say.**
Cameras restart their filename counters, so IMG_0001 recurs every few thousand
frames; with a byte-size collision on top, that is enough to clear a file for
deletion on a coincidence. When the card file has a capture time and the library
row's is still unread, pass 2 reads that one file and `#recheckProvisional`
withdraws the match if the times disagree. One file read is cheap next to
telling someone it is safe to format a card holding the only copy.

**Throughput figures are only quoted in bytes where every counted byte is
read.** `core/rate.ts` measures over a sliding window — an average since the
start keeps predicting the past, because a folder of 40MB raws and a folder of
phone JPEGs move at completely different speeds. `JobManager` owns the meter,
so anything reporting progress gets a rate and an estimate without asking for
one. Hashing reports `rateUnit: "bytes"` because it reads what it counts;
reading capture times reports `"files"`, because it opens a raw and reads the
header — quoting its file sizes as MB/s claimed 2.5 GB/s in testing, several
times what the disk was doing. The byte totals are still shown there, as how
much of the library has been got through, which is true.

**Previews come out of the file, not out of a decoder.** `core/thumbnail.ts`
reads the JPEG the camera embedded in EXIF's second IFD for its own back
screen. That is why a raw file — which no browser can draw — still gets a
picture, without a native image dependency. The cost is the camera's own size,
around 160px, so tiles are sized near that rather than upscaling hard. Browser
-readable formats fall back to their original bytes when they carry no preview
and are small enough to be worth sending. Previews are cached under
`cache/thumbs` against path, size and mtime, so an edited file gets a new key
rather than a stale picture, and files with no preview are remembered too.

**The preview endpoint takes an id, never a path.** `GET
/api/scans/:id/thumb?file=<scanFileId>` resolves the path itself from the row,
and still checks the result is inside the scan root. A handler that reads
whatever a path says is one bad row away from serving anything on the disk.

**A kind of media can have its own rule, or none.** `config.kinds` carries
per-kind handling; `ruleFor()` resolves it, and `Matcher.#planFor()` turns it
into a rule plus *only the libraries that rule names*. That last part is not
just tidiness: without it every clip would be looked up in every photo library
it could never be in. An ignored kind settles as satisfied the way a sidecar
does, so it can never block a format.

**Camera scaffolding is not media.** `isCameraSupportDir()` skips THMBNL, SUB,
CLIPINF and friends — but only inside a camera's own directory structure, since
"sub" and "backup" are words a person might reasonably name a real folder. Get
this wrong in the other direction and real photographs silently stop being
checked.

**`scan/import.ts` copies; it never replaces.** The rules it holds to, in the
order they will bite you if removed:

- A destination that already holds a *different* file is never overwritten —
  the incoming file takes a `_2` suffix, the way Lightroom does it. Two bodies
  shooting the same day both produce IMG_0001 and they are different
  photographs.
- Bytes land in a `.cif-part` file and are renamed into place only after being
  read back and hashed. An interrupted run leaves the finished file or nothing
  — never a truncated raw for the next index to record as an imported copy.
  The read-back may be served from the page cache, so it proves the write path
  rather than the platter; that is still the difference between a verified copy
  and a hopeful one.
- **A file the destination library already holds is not copied again.** The
  scan recorded a per-library match for every card file, so a rule like
  `main and backup` fills the gap rather than duplicating the card into `main`.
  The `matches` blob has an entry for *every* library including the ones that
  found nothing, so the tier is what carries the answer — compare it against
  `minTier`, never test for the key's presence.
- **A failed copy suppresses the re-scan.** Showing a fresh green verdict after
  a copy that did not complete is precisely how footage gets lost.

**A catalog destination stops before the re-scan.** Files land in the folder
the catalog said its photos live in, but Lightroom has not been told, and a
scan run then would report every one of them still missing and undo the trust
the copy just earned. `libraryRoots()` finds that folder from `stats.roots`
recorded at index time, falling back to the deepest common ancestor of every
indexed directory — which is exact for the single-root catalogs almost
everyone has, and means the feature works without re-indexing first.

**`core/template.ts` assumes the template is hostile.** It names a real
directory on a real disk and is typed by hand. Every segment is sanitised
individually (so a separator inside a token value cannot become a folder
boundary), reserved device names and trailing dots are removed — Windows
strips those silently, which would leave the path we recorded and the path that
exists disagreeing — and `joinUnder` then *checks* the result is inside the
destination rather than reasoning that it must be.

**`electron/` is a shell and must stay one.** It boots the same `startServer`
the CLI does and points a window at it. Nothing about reading a card, matching
it or copying from it is allowed to move in here, and no second copy of a page
or an endpoint is allowed to appear — the reason the desktop build was cheap is
that there is one implementation, and the moment there are two they start
disagreeing about what a verdict means. The renderer runs with
`contextIsolation` on, `nodeIntegration` off, `sandbox` on and no preload: it
reaches the disk by asking the loopback API, exactly as the browser did.

`electron/policy.ts` holds the decisions worth being sure about — what the
window may navigate to, what may be handed to `shell.openExternal`, where to
put the window given the screens that exist now — free of Electron so they can
be tested by calling them. `test/desktop.test.ts` does.

## Invariants worth not breaking

- Indexing a folder library opens **no files**. `test/scan.test.ts` asserts this
  via a snapshot taken between indexing and scanning; if you move metadata
  reading into the index path, that test is telling you something.
- Metadata and hashes are cached against `(size, mtime)`. The `CASE WHEN` blocks
  in `index/folder.ts`'s upsert are what preserve them across a re-index — they
  look verbose but each one is load-bearing.
- Adding a library regenerates the default rule *only* if the current rule still
  equals the previous auto-suggestion. Otherwise a second library would be
  silently absent from the rule and one-copy files would read as safe.
- Sort orders in `scan/verdict.ts` break ties explicitly so reports are stable
  between runs.

## Testing

```bash
npm test          # 314 tests
npm run typecheck
npm run fixtures -- ./fixtures
```

**Tests must never touch the real installation.** Two layers, because the
first one is bypassable:

- `test/setup.ts` is loaded with `--import` from the test script and points
  `CAN_I_FORMAT_HOME` at a throwaway directory before any test module is
  evaluated, including in the child process the runner spawns per file.
- `configDir()` **throws** when `NODE_TEST_CONTEXT` is set and there is no
  override. The npm script is not a guard: a bare `node --test some.test.ts`
  skips the preload entirely, and that is precisely how a real preview cache
  got filled with fixtures. Node marks its own test processes, so the refusal
  is structural and holds however the tests are launched.

Without this, everything resolving through `core/paths.ts` lands in a real
install: `readThumbnail` writes into someone's preview cache, indexing a
catalog leaves copies in it, and one `openDb()` with no argument would be
editing a working index. `test/isolation.test.ts` covers both layers.

Restore `CAN_I_FORMAT_HOME` in an `after()` hook rather than deleting it —
deleting hands whatever runs next back to the real directory.

`test/dom.ts` is the DOM the front end is driven in. `test/ui.test.ts` and
`test/import-ui.test.ts` load the real `app.js` against a real server and click
things, because reading a UI is not the same as running one. Note that
`descendants` is depth-first parent-before-child, so find a control by
`tagName === "BUTTON"` and not by text alone — a wrapping div reads the same
and clicking it does nothing.

`tools/exif-writer.ts` synthesises real APP1/TIFF blocks, so fixtures carry
genuine EXIF rather than committed binaries. The fixtures deliberately encode
the failure modes: repeated camera filenames across two shoots, rename +
DNG conversion on import, and partial backup coverage. When changing the
matcher, check `EXPECTED` in `tools/make-fixtures.ts` still describes reality
before editing assertions to match new output.

## Gotchas

- `node:sqlite` emits an ExperimentalWarning during module-graph instantiation,
  before any user code runs — it cannot be suppressed from inside the process.
  `--disable-warning=ExperimentalWarning` in the shebang and npm scripts is the
  only thing that works.
- `node --test test/` treats the path as a module; use `"test/*.test.ts"`.
- Lightroom catalog schemas drift between versions. `index/lightroom.ts` probes
  every optional table and column before use — keep new fields optional.
- The server exposes filesystem browsing, hence the loopback bind plus `Host`
  header check in `server/server.ts`. Don't relax either.
- **`UV_THREADPOOL_SIZE` cannot be set from inside the process**, so don't put
  it back in `cli.ts` or add it to `electron/main.ts`. libuv builds the pool
  during Node's own bootstrap, ahead of a `--require` preload, never mind an
  entry module. Measured on 24 cores with `npm run probe:pool`: ~3 concurrent
  unset, ~3 assigned in the entry point, ~4 from a preload, ~7 exported into
  the environment. And raising it does not help anyway — indexing 3,000 files
  with capture times read took 210/213/209ms at four threads against
  227/226/217ms at sixteen, because `core/pool.ts` is what actually bounds
  this code's concurrency.
- **Electron emits `ready` only after the entry module finishes evaluating.**
  A top-level `await app.whenReady()` in an ESM main entry is a module waiting
  on an event that is waiting on the module: no window, no output, no error.
  `main.ts` calls `boot()` without awaiting it, and `smoke.ts` says why.
- Node's type stripping reads `.ts` out of an `app.asar` archive without help,
  so the packaged app ships the same unbuilt sources — verified by running the
  built `.exe` and watching it answer `/api/state`. Keep it that way; the
  moment packaging needs a compile step, rule 3 is gone.
- **The release asset is always `Can-I-Format-win32-x64.zip`.** The website
  (the separate, private `can-i-format-site` repo) links to
  `/releases/latest/download/` plus that name, so putting a version in it
  breaks every download link without any error anywhere. Releases are cut by
  pushing a `v*` tag; `.github/workflows/release.yml` tests before it packages.

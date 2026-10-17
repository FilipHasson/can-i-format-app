# Can I Format

**Website and docs: <https://can-i-format-site.vercel.app>**

Checks a memory card against your Lightroom catalogs, photo folders and backup
drives, and tells you whether everything on it is already imported. If it
isn't, it lists exactly which files are missing and where from, and can copy
them for you.

It never writes to, deletes from or formats a card.

## Download

Get the latest Windows build from the
[releases page](https://github.com/FilipHasson/can-i-format-app/releases/latest):
download `Can-I-Format-win32-x64.zip`, unzip it and run `Can I Format.exe`.

Then follow the [Quickstart Guide](https://can-i-format-site.vercel.app/docs/quickstart).

## Documentation

Everything about using the app is on the website:

- [Quickstart Guide](https://can-i-format-site.vercel.app/docs/quickstart)
- [Libraries](https://can-i-format-site.vercel.app/docs/libraries): folders, Lightroom catalogs, cloud drives
- [Rules](https://can-i-format-site.vercel.app/docs/rules): deciding what counts as safe
- [Checking a card](https://can-i-format-site.vercel.app/docs/checking): the report, previews and history
- [Importing missing files](https://can-i-format-site.vercel.app/docs/importing)
- [Safety and privacy](https://can-i-format-site.vercel.app/docs/safety)
- [Under the hood](https://can-i-format-site.vercel.app/docs/under-the-hood): matching, speed, where data is stored, known limits

## Development

### Requirements

Node 24 or newer. It uses Node's built-in SQLite and runs the TypeScript
sources directly, so there is no build step.

```bash
npm install
```

### Running it

```bash
npm run app                 # in its own window (Electron)
npm start                   # in your browser, at http://127.0.0.1:4111
npm start -- --port 8080    # on another port
npm start -- --no-open      # without opening a browser
```

Both use the same settings, index and scan history as an installed copy. Set
`CAN_I_FORMAT_HOME` to a folder of your own to keep a development copy apart
from a real one.

### Testing

```bash
npm test             # the whole suite, including end-to-end scans and the UI
npm run typecheck
npm run app:smoke    # boots the window against a throwaway install and screenshots it
```

Tests never touch a real installation: `test/setup.ts` points them at a
throwaway folder, and `test/isolation.test.ts` fails if that stops working.

`npm run fixtures -- ./fixtures` writes a synthetic card and two libraries to
disk, with real EXIF, for trying the app by hand.

### Project layout

```
src/core/      config, rules, SQLite, metadata, hashing, paths
src/index/     reading a library into the index
src/scan/      reading a card, matching it, building the report, importing
src/server/    the local HTTP API and job runner
src/web/       the UI: plain HTML, CSS and JavaScript, no framework
electron/      the desktop window around the same server
tools/         fixtures, test helpers, the icon, diagnostic probes
```

`CLAUDE.md` explains how the matcher works and the rules the code holds to.
Read it before changing anything in `src/scan/`.

### Ground rules

- **Never write to a card.** The app only ever reads a card; importing copies
  files off it. A change that adds a way to delete, move or format
  anything on a card is wrong.
- **When in doubt, a file is missing.** A file that can't be confirmed must
  never be reported as safe.
- **No build step.** Only TypeScript syntax Node can strip (`npm run typecheck`
  enforces it), and the packaged app runs the same unbuilt sources.
- **One runtime dependency** (`exifr`). SQLite and the HTTP server are built
  into Node.

### Packaging

```bash
npm run package     # dist/Can I Format-win32-x64/Can I Format.exe
```

Builds for the platform you run it on. Only Windows has been packaged and
tested; macOS and Linux need their own icon formats.

### Releasing

Push a version tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` runs the typecheck and tests, packages the app,
and publishes `Can-I-Format-win32-x64.zip` as a GitHub Release.

The zip has the same name on every release, so
`/releases/latest/download/Can-I-Format-win32-x64.zip` always fetches the
newest build. The website's download buttons depend on that, so don't add a
version number to the file name.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md)
before opening a pull request.

## License

Copyright © 2026 Filip Hasson.

Can I Format is free software: you can redistribute it and modify it under the
terms of the [GNU General Public License, version 3](LICENSE) (GPL-3.0-only).
It comes with no warranty.

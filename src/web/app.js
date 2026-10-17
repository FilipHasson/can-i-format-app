// @ts-check
/**
 * Can I Format? — local UI.
 *
 * Plain modules, no build step and no framework. The DOM is built with `el`
 * rather than innerHTML throughout: nearly everything rendered here is a
 * filesystem path the user did not type, and paths are exactly the sort of
 * string that turns markup into a bug.
 */

const $ = (id) => document.getElementById(id);

/** @param {string} tag @param {Record<string, any>} [props] @param {...any} children */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * An inline icon, stroked in the current text colour.
 *
 * Drawn rather than typed: an emoji trash can renders as a different picture
 * on every platform and ignores the theme, and a glyph like ✕ is a shape that
 * happens to look like a cross rather than a thing you can name. This follows
 * the button's colour and hover state without a rule of its own.
 */
function icon(paths, size = 16) {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24",
    width: String(size),
    height: String(size),
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.7",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  })) {
    svg.setAttribute(key, value);
  }
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

const TRASH_CAN = [
  "M4 7h16",
  "M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7",
  "M6.2 7l.9 12.1A2 2 0 0 0 9.1 21h5.8a2 2 0 0 0 2-1.9L17.8 7",
  "M10.2 10.8v6.4",
  "M13.8 10.8v6.4",
];

const nf = new Intl.NumberFormat();
const num = (n) => nf.format(n ?? 0);

const pad = (n) => String(n).padStart(2, "0");

/**
 * Capture times are stored as a naive YYYYMMDDHHMMSS number, deliberately
 * without a timezone — it is the wall clock the camera wrote. Formatting the
 * digits directly keeps it that way; going through Date would shift it.
 */
function capturedOn(stamp) {
  const s = String(stamp);
  if (s.length !== 14) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
}

function modifiedOn(ms) {
  if (!ms) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Capture time where there is one, file mtime where there is not. */
function dateOf(file) {
  return (file.capturedAt ? capturedOn(file.capturedAt) : null) ?? modifiedOn(file.mtimeMs);
}

/** The date cell: capture time where there is one, file mtime where there is not. */
function dateCell(file) {
  const captured = file.capturedAt ? capturedOn(file.capturedAt) : null;
  if (captured) return el("td", { class: "file-date", text: captured });

  const modified = modifiedOn(file.mtimeMs);
  return el("td", {
    class: "file-date is-fallback",
    text: modified ?? "—",
    title: modified
      ? "No capture date could be read from this file — showing when it was last modified."
      : "No date available.",
  });
}

function bytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let value = n;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function ago(ms) {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

let toastTimer;
function toast(message, bad = false) {
  const node = $("toast");
  node.textContent = message;
  node.className = bad ? "toast bad" : "toast";
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), bad ? 6000 : 3000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { "content-type": "application/json" } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
  return data;
}

// ---------------------------------------------------------------- state ----

const store = {
  /** @type {any} */ state: null,
  /** @type {any[]} */ volumes: [],
  /** @type {any[]} */ scans: [],
  /** @type {any} */ result: null,
  /** Directory currently selected in the result tree. */ selectedDir: "",
  blockedOnly: true,
  /** "rows" for the detail table, "tiles" for the preview grid. */
  layout: localStorage.getItem("cif-layout") === "tiles" ? "tiles" : "rows",
  /** Fixed disks are hidden until asked for — a card is what you came here for. */
  showDrives: localStorage.getItem("cif-show-drives") === "1",
  /** Saved folder path -> currently reachable. */
  reachable: {},
  /** The library whose key is being edited in place, if any. */
  /** @type {string | null} */ editingKey: null,
  /**
   * A re-index queued behind a Lightroom sync, and the card to scan after it.
   * Only one job runs at a time, so this is worked through by the job handler.
   * @type {null | { libraries: string[], root: string, label: string }}
   */
  afterIndex: null,
};

function show(view) {
  for (const id of ["view-setup", "view-home", "view-result"]) $(id).hidden = id !== view;
  $("nav-home").hidden = view !== "view-result";
}

async function refreshState() {
  store.state = await api("/api/state");
  renderLibraries();
  renderRule();
  renderKindRules();
  renderRuleSummary();
  renderVolumes();
  void refreshSavedFolders();
  if (store.state.config.libraries.length === 0) show("view-setup");
  else if ($("view-result").hidden) show("view-home");
}

async function refreshVolumes() {
  $("volumes").replaceChildren(el("p", { class: "empty-note", text: "Looking for cards…" }));
  try {
    const { volumes } = await api("/api/volumes");
    store.volumes = volumes;
    // Saved folders are shown here too and live in the config, so refreshing
    // this panel has to mean refreshing both halves of what it shows.
    store.state = await api("/api/state");
  } catch (err) {
    store.volumes = [];
    toast(err.message, true);
  }
  renderVolumes();
  void refreshSavedFolders();
}

async function refreshScans() {
  const { scans } = await api("/api/scans");
  store.scans = scans;
  renderRecent();
}

// -------------------------------------------------------------- rendering --

/**
 * A place that can be checked — a card that is plugged in, or a folder someone
 * browsed to once and asked to keep.
 */
function volumeCard(place) {
  const remove = place.saved
    ? el(
        "button",
        {
          class: "card-remove danger",
          type: "button",
          title: "Remove this folder from the list. Nothing on disk is touched.",
          "aria-label": `Remove ${place.label} from the list`,
          onclick: () => forgetFolder(place),
        },
        icon(TRASH_CAN, 14),
      )
    : null;

  // A drive letter is reused by whatever card is in the reader next, so the
  // card's own name leads and the letter is secondary.
  const identity = place.identity;
  const title = identity?.name ?? place.label;

  return el(
    "div",
    { class: `card${place.looksLikeCard ? " is-card" : ""}${place.saved ? " is-saved" : ""}` },
    remove,
    el(
      "div",
      { class: "card-title" },
      el("span", {
        text: title,
        title: identity && !identity.distinguishable
          ? "This card carries no serial number, so it cannot be told apart from another of the same type and size."
          : "",
      }),
      place.looksLikeCard && place.marker ? el("span", { class: "badge", text: place.marker }) : null,
      place.saved ? el("span", { class: "badge muted", text: "Folder" }) : null,
    ),
    el("div", { class: "card-path", text: place.path }),
    el("div", {
      class: "card-meta",
      text: place.missing
        ? "Not connected right now"
        : place.totalBytes
          ? `${bytes(place.totalBytes - (place.freeBytes ?? 0))} used of ${bytes(place.totalBytes)}`
          : place.saved
            ? "Added by hand"
            : place.removable
              ? "Removable"
              : "Fixed disk",
    }),
    el("button", {
      class: "primary",
      type: "button",
      text: "Check this",
      disabled: place.missing,
      // The scan is recorded under the card's name, so history says which card
      // rather than which drive letter it happened to have that day.
      onclick: () => startScan(place.path, title),
    }),
  );
}

function renderVolumes() {
  const container = $("volumes");
  const saved = (store.state?.config.savedFolders ?? []).map((f) => ({
    ...f,
    saved: true,
    looksLikeCard: false,
    missing: !store.reachable?.[f.path],
  }));
  // A saved folder that is also a detected card would otherwise appear twice.
  const detected = store.volumes.filter((v) => !saved.some((f) => f.path === v.path));

  const cards = detected.filter((v) => v.looksLikeCard);
  const drives = detected.filter((v) => !v.looksLikeCard);
  const shown = [...cards, ...saved, ...(store.showDrives ? drives : [])];
  const hidden = drives.length;

  $("volumes-show-drives").checked = store.showDrives;

  if (shown.length === 0) {
    container.replaceChildren(
      el("p", {
        class: "empty-note",
        text:
          store.volumes.length === 0
            ? "No removable volumes detected. Use “Scan another folder…” to pick a path directly."
            : hidden === 1
              ? "No cards found. One other drive is connected — tick “Show other drives” to see it."
              : `No cards found. ${num(hidden)} other drives are connected — tick “Show other drives” to see them.`,
      }),
    );
    return;
  }

  container.replaceChildren(...shown.map(volumeCard));
}

/**
 * Whether each saved folder is currently reachable, so one on a drive that is
 * out reads as "not connected" rather than failing when it is clicked.
 */
async function refreshSavedFolders() {
  const folders = store.state?.config.savedFolders ?? [];
  const reachable = {};
  await Promise.all(
    folders.map(async (folder) => {
      try {
        // describe throws when the path is not a readable folder, which is
        // exactly the question being asked.
        await api("/api/describe", { method: "POST", body: { path: folder.path } });
        reachable[folder.path] = true;
      } catch {
        reachable[folder.path] = false;
      }
    }),
  );
  store.reachable = reachable;
  renderVolumes();
}

async function forgetFolder(folder) {
  try {
    store.state = await api(`/api/folders?path=${encodeURIComponent(folder.path)}`, { method: "DELETE" });
    renderVolumes();
    toast(`Removed ${folder.label}`);
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * The key, editable in place. Not `prompt()`: the desktop window does not
 * implement it, and a dialog that never appears is a button that does nothing.
 * Enter saves, Escape or clicking away puts the key back as it was.
 */
function keyField(current) {
  let saving = false;
  const stop = () => {
    store.editingKey = null;
    renderLibraries();
  };
  const input = el("input", {
    type: "text",
    class: "library-key-input",
    value: current,
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": `New key for ${current}`,
    onkeydown: async (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        stop();
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      const next = input.value.trim();
      if (next === current || next === "") return stop();

      saving = true;
      try {
        await api(`/api/libraries/${encodeURIComponent(current)}/key`, {
          method: "POST",
          body: { key: next },
        });
        store.editingKey = null;
        await refreshState();
        toast(`Renamed to ${next}. Your rules now use the new key.`);
      } catch (err) {
        // Left open with what was typed, so the mistake can be fixed.
        toast(err.message, true);
      } finally {
        saving = false;
      }
    },
    onblur: () => {
      if (!saving && store.editingKey === current) stop();
    },
  });
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
  return input;
}

function renderLibraries() {
  const container = $("libraries");
  const libs = store.state.libraries;
  const configured = store.state.config.libraries;

  if (configured.length === 0) {
    container.replaceChildren(
      el("p", { class: "empty-note", text: "No libraries yet — add the places your imports land." }),
    );
    return;
  }

  container.replaceChildren(
    ...configured.map((library) => {
      const indexed = libs.find((l) => l.key === library.key);
      const stats = indexed
        ? `${num(indexed.files)} files · indexed ${ago(indexed.lastIndexedAt)}`
        : "not indexed yet";

      return el(
        "div",
        { class: library.enabled ? "library" : "library disabled" },
        el(
          "div",
          { class: "library-main" },
          el(
            "div",
            { class: "library-name" },
            library.label,
            store.editingKey === library.key
              ? keyField(library.key)
              : el("button", {
                  class: "library-key",
                  type: "button",
                  text: library.key,
                  title: "The name rules use for this library. Click to change it.",
                  onclick: () => {
                    store.editingKey = library.key;
                    renderLibraries();
                  },
                }),
            library.kind === "lightroom" ? el("span", { class: "badge", text: "Lightroom" }) : null,
          ),
          el("div", { class: "library-path", text: library.path }),
          el("div", { class: "library-stats", text: stats }),
        ),
        el(
          "div",
          { class: "library-actions" },
          el("button", {
            type: "button",
            text: indexed ? "Re-index" : "Index now",
            onclick: () => indexLibrary(library.key),
          }),
          el("button", {
            class: "ghost",
            type: "button",
            text: library.enabled ? "Disable" : "Enable",
            onclick: () => toggleLibrary(library.key, !library.enabled),
          }),
          el("button", {
            class: "danger",
            type: "button",
            text: "Remove",
            onclick: () => removeLibrary(library.key, library.label),
          }),
        ),
      );
    }),
  );
}

const KIND_LABELS = {
  video: { title: "Video", plural: "clips" },
  audio: { title: "Audio", plural: "recordings" },
};

/**
 * Footage usually lives somewhere other than a photo library, so a card of
 * clips would otherwise report as unsafe against libraries that were never
 * meant to hold them.
 */
function renderKindRules() {
  const holder = $("kind-rules");
  if (!holder) return;
  const config = store.state.config;

  holder.replaceChildren(
    ...Object.entries(KIND_LABELS).map(([kind, label]) => {
      const handling = config.kinds?.[kind] ?? { mode: "default" };
      const input = el("input", {
        type: "text",
        spellcheck: "false",
        autocomplete: "off",
        placeholder: "e.g. footage",
        value: handling.mode === "rule" ? handling.rule : "",
      });
      input.hidden = handling.mode !== "rule";

      const save = async (mode) => {
        const patch = mode === "rule" ? { mode, rule: input.value.trim() } : { mode };
        if (mode === "rule" && patch.rule === "") {
          input.hidden = false;
          input.focus();
          return;
        }
        try {
          const next = await api("/api/config", { method: "PUT", body: { kinds: { [kind]: patch } } });
          store.state = next;
          renderKindRules();

          // A server that predates this setting accepts the request and
          // ignores the part it does not recognise, so the save looks like it
          // worked and nothing changes. Checking that the setting came back
          // the way it went is the only way to tell the difference.
          const applied = next.config?.kinds?.[kind] ?? { mode: "default" };
          const took =
            applied.mode === patch.mode && (patch.mode !== "rule" || applied.rule === patch.rule);

          if (took) toast(`${label.title} handling saved`);
          else {
            toast(
              `${label.title} handling was not applied. The running app is older than this page — restart it and try again.`,
              true,
            );
          }
        } catch (err) {
          toast(err.message, true);
        }
      };

      const choice = (mode, text, title) =>
        el("button", {
          type: "button",
          class: handling.mode === mode ? "is-on" : "",
          text,
          title,
          "aria-pressed": handling.mode === mode,
          onclick: () => {
            if (mode === "rule" && handling.mode !== "rule") {
              input.hidden = false;
              input.focus();
              return;
            }
            save(mode);
          },
        });

      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") save("rule");
      });
      input.addEventListener("blur", () => {
        if (input.value.trim() !== "") save("rule");
      });

      return el(
        "div",
        { class: "kind-rule" },
        el("span", { class: "kind-name", text: label.title }),
        el(
          "div",
          { class: "layout-switch" },
          choice("default", "Same as photos", `Judge ${label.plural} by the rule above`),
          choice("ignore", "Ignore", `Never let ${label.plural} block a format`),
          choice("rule", "Own rule", `Judge ${label.plural} against different libraries`),
        ),
        input,
      );
    }),
  );
}

/**
 * The rule in one line, on the dashboard.
 *
 * The editor lives in a dialog now — it is a thing you set up once and then
 * want out of the way — but the rule itself decides every verdict, so it stays
 * visible where the libraries it names are listed.
 */
function renderRuleSummary() {
  const node = $("rule-summary");
  if (!node) return;
  const rule = store.state.config.rule?.trim();
  const extra = Object.entries(store.state.config.kinds ?? {}).map(([kind, handling]) =>
    handling.mode === "ignore" ? `${kind} ignored` : `${kind}: ${handling.rule}`,
  );

  node.replaceChildren(
    el("span", { class: "rule-summary-label", text: "Safe to erase when in " }),
    el("code", { text: rule === "" ? "nothing set" : rule }),
    ...(extra.length > 0 ? [el("span", { class: "rule-summary-extra", text: ` · ${extra.join(" · ")}` })] : []),
  );
}

function renderRule() {
  const input = $("rule-input");
  if (document.activeElement !== input) input.value = store.state.config.rule;
  validateRule();
}

let ruleTimer;
async function validateRule() {
  clearTimeout(ruleTimer);
  ruleTimer = setTimeout(async () => {
    const status = $("rule-status");
    const rule = $("rule-input").value.trim();
    if (rule === "") {
      status.textContent = "A rule is required — without one nothing can ever be safe.";
      status.className = "rule-status bad";
      return;
    }
    try {
      const result = await api("/api/rule", { method: "POST", body: { rule } });
      status.textContent = result.ok ? "Valid rule" : result.error;
      status.className = result.ok ? "rule-status ok" : "rule-status bad";
    } catch (err) {
      status.textContent = err.message;
      status.className = "rule-status bad";
    }
  }, 180);
}

function renderRecent() {
  const container = $("recent");
  $("recent-clear").hidden = store.scans.length === 0;

  if (store.scans.length === 0) {
    container.replaceChildren(el("p", { class: "empty-note", text: "No scans yet." }));
    return;
  }

  container.replaceChildren(
    ...store.scans.map((scan) => {
      const stats = scan.stats ? JSON.parse(scan.stats) : null;
      // Three verdicts, not two. A card with nothing on it that needs checking
      // was reading as "0 files blocked" in red — the alarming colour and a
      // count of zero, which is the one combination that means nothing at all.
      const verdict = stats
        ? stats.status === "safe"
          ? "safe to format"
          : stats.status === "empty"
            ? "nothing to check"
            : `${num(stats.blocked)} files blocked`
        : scan.status;

      return el(
        "div",
        { class: "recent" },
        el(
          "button",
          { class: "recent-open", type: "button", onclick: () => openScan(scan.id) },
          el("span", {
            // Red is reserved for a card that would lose something. An empty
            // one holds nothing to lose, so it reads the same as a safe one;
            // grey is kept for a scan that never produced a verdict.
            class: `dot ${
              !stats ? "empty" : stats.status === "unsafe" ? "blocked" : "clear"
            }`,
          }),
          el("span", { class: "recent-label", text: scan.label || scan.root }),
          el("span", { class: "recent-meta", text: `${verdict} · ${ago(scan.started_at)}` }),
        ),
        el(
          "button",
          {
            class: "recent-delete danger",
            type: "button",
            title: "Delete this scan. Nothing on the card or in your libraries is touched.",
            // The icon carries no meaning to a screen reader, so name the action.
            "aria-label": `Delete the scan of ${scan.label || scan.root}`,
            onclick: () => deleteOneScan(scan),
          },
          icon(TRASH_CAN),
        ),
      );
    }),
  );
}

// ------------------------------------------------------------ result view --

/**
 * Which scan this is, and the way out of it. The topbar button alone was too
 * easy to miss — it sat in the far corner looking like the grey note beside it,
 * so a result read as a dead end.
 */
function renderResultHead(scan) {
  $("result-head").replaceChildren(
    el("button", {
      class: "back",
      type: "button",
      text: "← Cards and libraries",
      onclick: () => show("view-home"),
    }),
    el(
      "div",
      { class: "result-title" },
      el("strong", { text: scan.label || scan.root }),
      el("span", { class: "result-when", text: ago(scan.started_at) }),
    ),
  );
}

function renderVerdict(scan, verdict, warnings) {
  const rule = scan.rule;
  const container = $("verdict");
  container.className = `verdict ${verdict.status}`;

  const headline =
    verdict.status === "safe"
      ? "Safe to format"
      : verdict.status === "empty"
        ? "Nothing to check"
        : "Not safe to format";

  const sub =
    verdict.status === "safe"
      ? `All ${num(verdict.requiredFiles)} files on this card are accounted for.`
      : verdict.status === "empty"
        ? verdict.totalFiles === 0
          ? "There is nothing on this card."
          : // Files present, none of a kind that gets checked. Usually leftover
            // camera scaffolding — but a raw format this tool does not know
            // also lands here, and that would be someone's only copy.
            `None of the ${num(verdict.totalFiles)} files here are photos, video or audio, so there is nothing to import. Worth a look below if that is a surprise — a format this tool does not recognise counts as nothing.`
        : `${num(verdict.blocked)} of ${num(verdict.requiredFiles)} files are not backed up yet (${bytes(verdict.blockedBytes)}).`;

  const children = [
    el("h2", { text: headline }),
    el("div", { class: "verdict-sub", text: sub }),
    el("div", { class: "verdict-rule", text: `Rule: ${rule}` }),
  ];

  if (verdict.gaps.length > 0) {
    children.push(
      el(
        "ul",
        { class: "gap-list" },
        ...verdict.gaps.map((gap) =>
          el(
            "li",
            {},
            el("span", { class: "gap-count", text: num(gap.count) }),
            el("span", {}, "missing from "),
            el("span", { class: "gap-req", text: gap.requirement }),
          ),
        ),
      ),
    );
  }

  if (warnings?.length) {
    children.push(
      el(
        "div",
        { class: "warnings" },
        el("strong", { text: "Worth knowing" }),
        el("ul", {}, ...warnings.map((w) => el("li", { text: w }))),
      ),
    );
  }

  children.push(
    el(
      "div",
      { class: "stat-row" },
      stat(num(verdict.totalFiles), "files on card"),
      stat(num(verdict.satisfied), "matched"),
      stat(num(verdict.blocked), "blocked"),
      stat(bytes(verdict.bytes), "total size"),
    ),
  );

  // Being told what is missing and then having to copy it by hand is where
  // this stops being useful, so the way out sits next to the problem.
  if (verdict.blocked > 0) {
    children.push(
      el(
        "div",
        { class: "verdict-actions" },
        el("button", {
          class: "primary",
          type: "button",
          text: `Import the ${num(verdict.blocked)} missing ${verdict.blocked === 1 ? "file" : "files"}…`,
          onclick: () => openImport(scan),
        }),
      ),
    );
  }

  container.replaceChildren(...children);
}

function stat(value, label) {
  return el(
    "div",
    { class: "stat" },
    el("span", { class: "stat-value", text: value }),
    el("span", { class: "stat-label", text: label }),
  );
}

function renderTree(node, depth = 0) {
  const label = node.path === "" ? "(card root)" : node.name;
  const summary = el(
    "summary",
    { class: "node" },
    el("span", { class: `dot ${node.status}` }),
    el("span", { class: "node-name", text: label }),
    el("span", {
      class: "node-counts",
      text:
        node.blocked > 0
          ? `${num(node.blocked)} blocked of ${num(node.requiredFiles)}`
          : `${num(node.requiredFiles)} matched`,
    }),
  );

  summary.addEventListener("click", () => {
    store.selectedDir = node.path;
    loadFiles();
  });

  // Open the branches that lead to problems; leave clean ones collapsed.
  const details = el("details", { open: depth < 1 || node.blocked > 0 }, summary);
  for (const child of node.children) details.append(renderTree(child, depth + 1));
  return details;
}

async function loadFiles() {
  const holder = $("files-holder");
  if (!holder) return;
  holder.replaceChildren(el("p", { class: "empty-note", text: "Loading…" }));

  const params = new URLSearchParams({
    dir: store.selectedDir,
    recursive: "1",
    limit: "400",
  });
  if (store.blockedOnly) params.set("blocked", "1");

  try {
    const { files, total } = await api(`/api/scans/${store.result.scan.id}/files?${params}`);
    holder.replaceChildren(renderFiles(files, total));
  } catch (err) {
    holder.replaceChildren(el("p", { class: "empty-note", text: err.message }));
  }
}

/**
 * Formats a browser can draw, plus the raws and videos it cannot.
 *
 * The server answers 404 for anything with no preview to give, so the element
 * is built optimistically and removes itself on error rather than the client
 * trying to predict which files have one.
 */
function thumb(file, size) {
  const box = el("div", { class: `thumb thumb-${size}` });
  const kind = el("span", { class: "thumb-kind", text: file.ext.toUpperCase() });
  box.append(kind);

  const img = el("img", {
    src: `/api/scans/${store.result.scan.id}/thumb?file=${file.id}`,
    alt: "",
    loading: "lazy",
    decoding: "async",
    onload: () => box.classList.add("has-image"),
    // No preview, or an unreadable file. The extension label stays.
    onerror: () => img.remove(),
  });
  box.append(img);
  return box;
}

/** The pills saying which libraries hold this file, shared by both layouts. */
function matchPills(file, libraryKeys) {
  return libraryKeys.map((key) => {
    const match = file.matches?.[key];
    const hit = match && match.tier !== "none" && match.tier !== "weak";

    // A catalog that imported the file and no longer has it is neither a match
    // nor a plain miss, and the difference is the whole point of saying so.
    if (match?.deleted) {
      return el("span", {
        class: "match-pill deleted",
        text: key,
        title: `Imported, then deleted — the catalog points at ${match.path}, which is not there any more.`,
      });
    }

    return el("span", {
      class: `match-pill ${hit ? "hit" : "miss"}`,
      text: key,
      title: match && match.tier !== "none" ? `${match.tier} — ${match.reason}` : "no match",
    });
  });
}

function enabledLibraryKeys() {
  return store.state.config.libraries.filter((l) => l.enabled).map((l) => l.key);
}

/** Tiles: the picture leads, and everything else is caption. */
function renderFileTiles(files) {
  const libraryKeys = enabledLibraryKeys();
  return el(
    "div",
    { class: "tile-grid" },
    ...files.map((file) =>
      el(
        "figure",
        { class: `tile ${file.satisfied ? "is-safe" : "is-blocked"}` },
        thumb(file, "large"),
        el(
          "figcaption",
          {},
          el("div", { class: "tile-name", text: file.name, title: `${file.relDir}/${file.name}` }),
          el(
            "div",
            { class: "tile-meta" },
            el("span", { text: dateOf(file) ?? "—" }),
            el("span", { text: bytes(file.size) }),
          ),
          el("div", { class: "tile-pills" }, ...matchPills(file, libraryKeys)),
          file.satisfied ? null : el("div", { class: "gap-req", text: file.gap }),
        ),
      ),
    ),
  );
}

function renderFiles(files, total) {
  if (files.length === 0) {
    return el("p", {
      class: "empty-note",
      text: store.blockedOnly
        ? "Nothing blocked here — every file in this folder is accounted for."
        : "No files here.",
    });
  }

  const body = store.layout === "tiles" ? renderFileTiles(files) : renderFileTable(files);
  if (total <= files.length) return body;

  return el(
    "div",
    {},
    body,
    el("p", {
      class: "empty-note",
      text: `Showing ${num(files.length)} of ${num(total)} — narrow down by picking a folder above.`,
    }),
  );
}

function renderFileTable(files) {

  const libraryKeys = enabledLibraryKeys();

  const rows = files.map((file) =>
    el(
      "tr",
      {},
      el(
        "td",
        { class: "file-cell" },
        thumb(file, "small"),
        el(
          "div",
          { class: "file-ident" },
          el("div", { class: "file-name", text: file.name }),
          file.relDir !== store.selectedDir
            ? el("div", { class: "file-dir", text: file.relDir })
            : null,
        ),
      ),
      dateCell(file),
      el("td", { text: bytes(file.size) }),
      el("td", {}, ...matchPills(file, libraryKeys)),
      el("td", { class: "gap-req", text: file.satisfied ? "—" : file.gap }),
    ),
  );

  const table = el(
    "table",
    { class: "file-table" },
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { text: "File" }),
        el("th", { text: "Date taken" }),
        el("th", { text: "Size" }),
        el("th", { text: "Found in" }),
        el("th", { text: "Still needs" }),
      ),
    ),
    el("tbody", {}, ...rows),
  );

  return el("div", { class: "table-scroll" }, table);
}

async function openScan(id) {
  const data = await api(`/api/scans/${id}`);
  store.result = data;
  store.selectedDir = "";
  store.blockedOnly = data.verdict.status !== "safe";

  renderResultHead(data.scan);
  renderVerdict(data.scan, data.verdict, data.warnings);

  const layoutSwitch = el(
    "div",
    { class: "layout-switch", role: "group", "aria-label": "File view" },
    ...[
      ["rows", "Rows", "Every detail, one line per file"],
      ["tiles", "Tiles", "Larger previews, fewer details"],
    ].map(([value, label, title]) =>
      el("button", {
        type: "button",
        class: store.layout === value ? "is-on" : "",
        text: label,
        title,
        "aria-pressed": store.layout === value,
        onclick: () => {
          if (store.layout === value) return;
          store.layout = value;
          localStorage.setItem("cif-layout", value);
          for (const button of layoutSwitch.children) {
            const on = button.textContent === label;
            button.classList.toggle("is-on", on);
            button.setAttribute("aria-pressed", String(on));
          }
          loadFiles();
        },
      }),
    ),
  );

  const toggle = el(
    "label",
    { class: "blocked-toggle" },
    el("input", {
      type: "checkbox",
      checked: store.blockedOnly,
      onchange: (event) => {
        store.blockedOnly = event.target.checked;
        loadFiles();
      },
    }),
    " Only show files that block a format",
  );

  $("result-body").replaceChildren(
    el(
      "section",
      { class: "panel" },
      el("div", { class: "panel-head" }, el("h2", { text: "Folders" })),
      el("div", { class: "tree" }, renderTree(data.tree)),
    ),
    el(
      "section",
      { class: "panel" },
      el(
        "div",
        { class: "panel-head" },
        el("h2", { text: "Files" }),
        el("div", { class: "panel-actions" }, toggle, layoutSwitch),
      ),
      el("div", { id: "files-holder" }),
    ),
  );

  show("view-result");
  window.scrollTo({ top: 0 });
  await loadFiles();
}

// ------------------------------------------------------------------ jobs ---

function renderJob(job) {
  const banner = $("job-banner");
  if (!job || job.status !== "running") {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  $("job-label").textContent = job.label;
  $("job-message").textContent = job.progress.message;
  $("job-detail").textContent = job.progress.detail ?? "";

  renderJobBar(job.progress);
  $("job-cancel").onclick = () => api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
}

/**
 * One bar for one action, divided into the phases the job declared up front.
 * Each step counts its own work from zero, and drawing those counts directly
 * filled and emptied the bar once per step. Here a step fills only its own
 * segment, finished phases stay full, and a phase that turned out not to be
 * needed is drawn as skipped rather than as work done.
 */
function renderJobBar(progress) {
  const bar = $("job-bar");
  const state = progress.phases ?? {
    // A job without phases is one step: the old single bar, unlabelled.
    phases: [{ key: "work", label: "" }],
    current: 0,
    fraction: progress.total > 0 ? progress.done / progress.total : null,
    skipped: [],
    overall: progress.total > 0 ? progress.done / progress.total : 0,
  };
  const labelled = state.phases.length > 1;

  bar.replaceChildren(
    ...state.phases.map((phase, i) => {
      const skipped = state.skipped.includes(phase.key);
      const status = skipped ? "skipped" : i < state.current ? "done" : i === state.current ? "current" : "ahead";
      const fill = el("div", {
        class: status === "current" && state.fraction === null ? "job-seg-fill indeterminate" : "job-seg-fill",
      });
      fill.style.width =
        status === "done" ? "100%" : status === "current" && state.fraction !== null ? `${Math.round(state.fraction * 100)}%` : "";
      return el(
        "div",
        { class: `job-seg ${status}`, title: skipped ? `${phase.label} — not needed` : phase.label },
        el("div", { class: "job-seg-track" }, fill),
        labelled ? el("span", { class: "job-seg-label", text: phase.label }) : null,
      );
    }),
  );
  bar.setAttribute("aria-valuenow", String(Math.round(state.overall * 100)));
  const current = state.phases[state.current]?.label;
  bar.setAttribute(
    "aria-valuetext",
    labelled && current ? `Step ${state.current + 1} of ${state.phases.length}: ${current}` : `${Math.round(state.overall * 100)}%`,
  );
}

function subscribe() {
  const source = new EventSource("/api/events");

  source.addEventListener("message", async (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type !== "job") return;
    const job = payload.job;
    renderJob(job);

    if (job.status === "running") return;

    if (job.status === "error") toast(job.error, true);
    else if (job.status === "cancelled") toast(`${job.label} cancelled`);

    if (job.kind === "import") {
      await Promise.all([refreshState(), refreshScans()]);
      if (job.status === "done") {
        const result = job.result ?? {};
        const copied = result.copied ?? 0;
        const failed = result.failed ?? [];

        if (failed.length > 0) {
          toast(
            `${num(copied)} copied, but ${num(failed.length)} failed — ${failed[0]?.error ?? ""}. The card is not safe yet.`,
            true,
          );
        } else if (result.identical > 0 && copied === 0) {
          toast(`Everything was already there — ${num(result.identical)} files verified`);
        } else {
          toast(`${num(copied)} files copied and checked`);
        }

        // A folder library has already been re-indexed and re-scanned by the
        // job itself, so the new verdict is ready to show.
        if (result.rescan?.scanId) await openScan(result.rescan.scanId);
        else if (result.needsSync?.length > 0) showSyncSteps(result);
      }
      return;
    }

    if (job.kind === "index") {
      await refreshState();
      if (job.status === "done") {
        toast(`${job.label} finished — ${num(job.result?.files ?? 0)} files indexed`);
      }
      // A re-index queued after a Lightroom sync has a scan waiting behind it.
      if (store.afterIndex) {
        if (job.status === "done") await runQueuedReindex();
        else store.afterIndex = null;
      }
    } else if (job.kind === "scan") {
      await refreshScans();
      if (job.status === "done" && job.result?.scanId) await openScan(job.result.scanId);
    }
  });

  source.addEventListener("error", () => {
    // EventSource retries on its own; nothing to do but let it.
  });
}

// --------------------------------------------------------------- actions ---

async function indexLibrary(key) {
  try {
    await api(`/api/libraries/${encodeURIComponent(key)}/index`, {
      method: "POST",
      body: { mode: "incremental" },
    });
  } catch (err) {
    toast(err.message, true);
  }
}

async function toggleLibrary(key, enabled) {
  try {
    await api("/api/config", { method: "PUT", body: { libraries: [{ key, enabled }] } });
    await refreshState();
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * Deleting a scan removes a report, not photographs. The wording says so
 * outright: this tool never touches media, and a prompt that leaves any doubt
 * about that is worse than no prompt.
 */
async function deleteOneScan(scan) {
  const name = scan.label || scan.root;
  if (!confirm(`Delete the scan of "${name}"?\n\nThis removes the report only — nothing on the card or in your libraries is touched, and you can scan it again.`)) {
    return;
  }
  try {
    await api(`/api/scans/${scan.id}`, { method: "DELETE" });
    // If it is the scan on screen, there is nothing left to look at.
    if (store.result?.scan?.id === scan.id) {
      store.result = null;
      show("view-home");
    }
    await refreshScans();
    toast(`Deleted the scan of ${name}`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function clearScanHistory() {
  const count = store.scans.length;
  if (count === 0) return;
  if (
    !confirm(
      `Delete all ${count} scan${count === 1 ? "" : "s"} from the history?\n\nThis removes the reports only — nothing on any card or in your libraries is touched.`,
    )
  ) {
    return;
  }
  try {
    const { removed } = await api("/api/scans", { method: "DELETE" });
    store.result = null;
    show("view-home");
    await refreshScans();
    toast(`Deleted ${num(removed)} scan${removed === 1 ? "" : "s"}`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function removeLibrary(key, label) {
  if (!confirm(`Remove "${label}"? This only forgets the library — nothing on disk is touched.`)) {
    return;
  }
  try {
    await api(`/api/libraries/${encodeURIComponent(key)}`, { method: "DELETE" });
    await refreshState();
    toast(`Removed ${label}`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function startScan(root, label) {
  try {
    await api("/api/scans", { method: "POST", body: { root, label } });
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------------------------------------------------------- picker ---

const picker = {
  /** @type {null | ((path: string) => void)} */ resolve: null,
  current: "",
  allowCatalogs: false,
};

async function openPicker({ title, allowCatalogs = false }) {
  picker.allowCatalogs = allowCatalogs;
  $("picker-title").textContent = title;
  $("picker").showModal();
  await navigatePicker("");

  return new Promise((resolve) => {
    picker.resolve = resolve;
  });
}

async function navigatePicker(path) {
  try {
    const result = await api("/api/browse", { method: "POST", body: { path } });
    picker.current = result.path;
    $("picker-input").value = result.path;
    $("picker-hint").textContent = result.path;
    $("picker-up").disabled = result.parent === null;
    $("picker-up").dataset.parent = result.parent ?? "";

    $("picker-shortcuts").replaceChildren(
      ...result.shortcuts.map((shortcut) =>
        el("button", {
          type: "button",
          text: shortcut.label,
          onclick: () => navigatePicker(shortcut.path),
        }),
      ),
    );

    $("picker-list").replaceChildren(
      ...result.entries
        .filter((entry) => entry.isDirectory || picker.allowCatalogs)
        .map((entry) =>
          el(
            "li",
            {
              class: entry.isCatalog ? "catalog" : "",
              onclick: () => {
                if (entry.isCatalog) finishPicker(entry.path);
                else navigatePicker(entry.path);
              },
            },
            entry.isCatalog ? "🗂" : "📁",
            entry.name,
          ),
        ),
    );
  } catch (err) {
    toast(err.message, true);
  }
}

function finishPicker(path) {
  const resolve = picker.resolve;
  picker.resolve = null;
  $("picker").close();
  if (resolve) resolve(path);
}

// ----------------------------------------------------------------- import ---

/**
 * Copying the missing files into a library.
 *
 * The dialog is settings on top and a live preview underneath, because the
 * question it has to answer is not "how many files" but "where exactly is each
 * one going to end up". Every edit re-plans against the server, so what is on
 * screen when the button is pressed is what happens.
 */
const importer = {
  scan: null,
  plan: null,
  /** Folder destinations chosen through the picker, before they are saved. */
  pending: {},
  timer: null,
};

const GROUP_LABELS = { photos: "Photos", video: "Video", audio: "Audio" };

async function openImport(scan) {
  importer.scan = scan;
  importer.plan = null;
  importer.pending = {};

  const config = store.state.config.import ?? {};
  $("import-title").textContent = `Import from ${scan.label || scan.root}`;
  $("import-folder").value = config.folderTemplate ?? "";

  const renaming = (config.filenameTemplate ?? "{name}") !== "{name}";
  $("import-rename").checked = renaming;
  $("import-filename").hidden = !renaming;
  $("import-filename").value = renaming ? config.filenameTemplate : "";

  $("import-preset").replaceChildren(
    ...(store.state.folderPresets ?? []).map((preset) =>
      el("option", { value: preset.template, text: preset.label }),
    ),
    el("option", { value: "__custom", text: "Something else…" }),
  );
  $("import-preset").value = (store.state.folderPresets ?? []).some(
    (p) => p.template === $("import-folder").value,
  )
    ? $("import-folder").value
    : "__custom";

  $("import-tokens").replaceChildren(
    ...(store.state.importTokens ?? []).map((token) =>
      el("li", {}, el("code", { text: `{${token.token}}` }), ` ${token.describe}`),
    ),
  );

  // Clickable, because a template field with no visible vocabulary is a field
  // people leave alone. Appending rather than inserting at the caret keeps this
  // predictable — the example underneath shows the result either way.
  $("import-chips").replaceChildren(
    ...(store.state.importTokens ?? []).map((token) =>
      el("button", {
        type: "button",
        class: "chip",
        text: `{${token.token}}`,
        title: token.describe,
        onclick: () => {
          const field = $("import-rename").checked && !$("import-filename").hidden
            ? $("import-filename")
            : $("import-folder");
          field.value += `{${token.token}}`;
          field.focus();
          void refreshExample();
          void replan();
        },
      }),
    ),
  );

  renderImportGroups();
  $("import").showModal();
  await Promise.all([refreshExample(), replan()]);
}

/**
 * Shows what the template does to a real file from this card.
 *
 * Separate from the plan because it has to work before a destination is
 * chosen — that is the moment someone is actually typing a template — and
 * because it should answer on every keystroke rather than after a round trip
 * that walks the whole card.
 */
let exampleTimer;
async function refreshExample() {
  clearTimeout(exampleTimer);
  exampleTimer = setTimeout(async () => {
    if (!importer.scan) return;
    const node = $("import-example");

    try {
      const { example } = await api(`/api/scans/${importer.scan.id}/import/example`, {
        method: "POST",
        body: {
          folderTemplate: $("import-folder").value,
          filenameTemplate: importSettings().filenameTemplate,
        },
      });

      if (!example) {
        node.className = "import-example";
        node.textContent = "";
        return;
      }
      if (example.problems.length > 0) {
        node.className = "import-example bad";
        node.textContent = example.problems.join(" ");
        return;
      }

      node.className = "import-example";
      node.replaceChildren(
        el("span", { class: "muted", text: `${example.source}  →  ` }),
        el("code", { text: example.target }),
        example.datedByFile
          ? el("span", { class: "muted", text: "  (dated by the file, not a capture time)" })
          : null,
      );
    } catch {
      // The plan below says anything that actually matters; a missing example
      // should not put an error where a preview goes.
      node.textContent = "";
    }
  }, 120);
}

/** One row per kind of media, each with somewhere to go. */
function renderImportGroups() {
  const libraries = store.state.libraries ?? [];
  const config = store.state.config.import ?? {};

  $("import-groups").replaceChildren(
    ...(store.state.importGroups ?? []).map((group) => {
      const planned = importer.plan?.groups?.find((g) => g.group === group);
      const chosen = importer.pending[group] ?? config.destinations?.[group] ?? { mode: "skip" };

      const select = el("select", {
        onchange: (event) => {
          const value = event.target.value;
          if (value === "__browse") {
            void chooseImportFolder(group);
            return;
          }
          importer.pending[group] =
            value === "__skip" ? { mode: "skip" } : { mode: "library", libraryKey: value };
          void replan();
        },
      });

      select.append(
        el("option", { value: "__skip", text: "Leave on the card" }),
        ...libraries.map((library) =>
          el("option", {
            value: library.key,
            text: `${library.label}${library.kind === "lightroom" ? " (catalog)" : ""}`,
          }),
        ),
        el("option", { value: "__browse", text: "Choose a folder…" }),
      );

      select.value =
        chosen.mode === "library"
          ? chosen.libraryKey
          : chosen.mode === "folder"
            ? "__browse"
            : "__skip";

      const count =
        planned === undefined
          ? ""
          : planned.files === 0 && planned.alreadyHeld === 0
            ? "none on this card"
            : `${num(planned.files)} ${planned.files === 1 ? "file" : "files"}${
                planned.bytes > 0 ? ` · ${bytes(planned.bytes)}` : ""
              }${planned.alreadyHeld > 0 ? ` · ${num(planned.alreadyHeld)} already filed` : ""}`;

      const where =
        chosen.mode === "folder"
          ? chosen.path
          : planned?.destination
            ? planned.destination.base
            : "";

      return el(
        "div",
        { class: "import-group" },
        el(
          "div",
          { class: "import-group-head" },
          el("span", { class: "import-group-name", text: GROUP_LABELS[group] ?? group }),
          el("span", { class: "import-group-count", text: count }),
        ),
        select,
        where ? el("code", { class: "import-where", text: where }) : null,
      );
    }),
  );
}

async function chooseImportFolder(group) {
  const path = await openPicker({ title: `Where should ${GROUP_LABELS[group] ?? group} go?` });
  // Re-showing is needed either way: opening the picker closed this dialog.
  $("import").showModal();
  if (!path) {
    renderImportGroups();
    return;
  }
  importer.pending[group] = { mode: "folder", path };
  await replan();
}

/** The settings as the dialog currently has them, for the server to judge. */
function importSettings() {
  const renaming = $("import-rename").checked;
  const filename = $("import-filename").value.trim();
  return {
    folderTemplate: $("import-folder").value,
    filenameTemplate: renaming && filename !== "" ? filename : "{name}",
    destinations: importer.pending,
  };
}

let replanning = false;
async function replan() {
  clearTimeout(importer.timer);
  importer.timer = setTimeout(async () => {
    if (!importer.scan || replanning) return;
    replanning = true;

    $("import-go").disabled = true;
    try {
      const result = await api(`/api/scans/${importer.scan.id}/import/plan`, {
        method: "POST",
        body: { settings: importSettings() },
      });
      importer.plan = result.plan;
      // The server saved what it was given, so the dialog and the config agree
      // from here on and nothing is left staged in `pending`.
      store.state.config = result.config;
      importer.pending = {};
      renderImportGroups();
      renderImportPreview(result.plan);
    } catch (err) {
      importer.plan = null;
      renderImportProblem(err.message);
    } finally {
      replanning = false;
    }
  }, 150);
}

function renderImportProblem(message) {
  $("import-preview").replaceChildren(el("p", { class: "import-bad", text: message }));
  $("import-summary").textContent = "";
  $("import-go").disabled = true;
}

function renderImportPreview(plan) {
  const holder = $("import-preview");
  const children = [];

  if (plan.problems.length > 0) {
    children.push(
      el(
        "div",
        { class: "import-bad" },
        ...plan.problems.map((p) => el("p", { text: p })),
      ),
    );
  }

  if (plan.examples.length > 0) {
    children.push(
      el("h4", { text: plan.files > plan.examples.length ? "Where they land, for the first few" : "Where they land" }),
      el(
        "ul",
        { class: "import-examples" },
        ...plan.examples.map((example) =>
          el(
            "li",
            {},
            el("code", { class: "from", text: example.source }),
            el("span", { class: "arrow", text: "→" }),
            el("code", { class: "to", text: example.target }),
          ),
        ),
      ),
    );
  }

  if (plan.needsSync.length > 0) {
    children.push(
      el("p", { class: "import-note" },
        `${plan.needsSync.map((s) => s.label).join(", ")} ${plan.needsSync.length === 1 ? "is a catalog" : "are catalogs"}, so ` +
          "Lightroom has to be told about the new files before the card can be checked again. " +
          "You will get the exact steps when the copy finishes.",
      ),
    );
  }

  if (plan.warnings.length > 0) {
    children.push(
      el("div", { class: "import-warnings" }, ...plan.warnings.map((w) => el("p", { text: w }))),
    );
  }

  const skippedShown = plan.skipped.slice(0, 6);
  if (plan.skipped.length > 0) {
    children.push(
      el("details", { class: "import-skipped" },
        el("summary", { text: `${num(plan.skipped.length)} not copied` }),
        el("ul", {},
          ...skippedShown.map((s) => el("li", { text: `${s.name} — ${s.reason}` })),
          plan.skipped.length > skippedShown.length
            ? el("li", { class: "muted", text: `…and ${num(plan.skipped.length - skippedShown.length)} more` })
            : null,
        ),
      ),
    );
  }

  holder.replaceChildren(...children.filter(Boolean));

  const ok = plan.problems.length === 0 && plan.files > 0;
  $("import-go").disabled = !ok;
  $("import-go").textContent = ok ? `Copy ${num(plan.files)} ${plan.files === 1 ? "file" : "files"}` : "Copy";
  $("import-summary").textContent = ok ? `${num(plan.files)} files · ${bytes(plan.bytes)}` : "";
}

async function startImport() {
  if (!importer.scan || !importer.plan) return;
  const plan = importer.plan;

  $("import").close();
  try {
    await api(`/api/scans/${importer.scan.id}/import`, {
      method: "POST",
      body: { settings: importSettings() },
    });
    toast(`Copying ${num(plan.files)} files — the card is not touched`);
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * What to do once the copy is done and a catalog is involved.
 *
 * The files exist; the catalog does not know. Saying so plainly, with the
 * folder to point Lightroom at, is the difference between this working and the
 * user concluding the import silently failed.
 */
function showSyncSteps(outcome) {
  $("sync-body").replaceChildren(
    el("p", {
      text: `${num(outcome.copied)} files were copied and checked. Lightroom does not know about them yet.`,
    }),
    ...outcome.needsSync.map((entry) =>
      el(
        "div",
        { class: "sync-entry" },
        el("strong", { text: entry.label }),
        el("ol", {},
          el("li", {}, "In Lightroom, find this folder in the Folders panel:"),
          ...entry.folders.map((folder) => el("li", {}, el("code", { text: folder }))),
          el("li", {}, "Right-click it and choose ", el("strong", { text: "Synchronize Folder…" })),
          el("li", {}, "Let it import the new photographs."),
        ),
      ),
    ),
    el("p", { class: "import-note" },
      "Then check the card again — until it comes back clean, do not format it.",
    ),
  );

  $("sync-rescan").onclick = () => {
    $("sync").close();
    // Re-index the catalogs first — Lightroom has just written to them, and a
    // scan against the old index would report the files still missing. One job
    // runs at a time, so this is a queue the job handler works through before
    // the scan it is really after.
    store.afterIndex = {
      libraries: outcome.needsSync.map((entry) => entry.key),
      root: outcome.plan.root,
      label: outcome.plan.label,
    };
    void runQueuedReindex();
  };

  $("sync").showModal();
}

/** Works through the queued re-index, then scans. Driven by job completions. */
async function runQueuedReindex() {
  const queued = store.afterIndex;
  if (!queued) return;

  const next = queued.libraries.shift();
  if (next !== undefined) {
    try {
      await api(`/api/libraries/${next}/index`, { method: "POST", body: {} });
    } catch (err) {
      store.afterIndex = null;
      toast(err.message, true);
    }
    return;
  }

  store.afterIndex = null;
  await startScan(queued.root, queued.label);
}

// ------------------------------------------------------------------ wiring -

async function addLibraryFlow() {
  const path = await openPicker({
    title: "Choose a library folder or Lightroom catalog",
    allowCatalogs: true,
  });
  if (!path) return;

  try {
    await api("/api/libraries", { method: "POST", body: { path } });
    await refreshState();
    show("view-home");
    toast("Library added — index it to start matching");
  } catch (err) {
    toast(err.message, true);
  }
}

async function scanOtherFlow() {
  const path = await openPicker({ title: "Choose a card or folder to check" });
  if (!path) return;

  // Keep it on the dashboard: somewhere worth checking once is worth checking
  // again, and finding it through the picker every time is how that stops
  // happening.
  try {
    store.state = await api("/api/folders", { method: "POST", body: { path } });
    renderVolumes();
    void refreshSavedFolders();
  } catch (err) {
    toast(err.message, true);
  }

  await startScan(path, undefined);
}

$("setup-add").addEventListener("click", addLibraryFlow);
$("library-add").addEventListener("click", addLibraryFlow);
$("scan-other").addEventListener("click", scanOtherFlow);
$("volumes-refresh").addEventListener("click", refreshVolumes);
$("nav-home").addEventListener("click", () => show("view-home"));
$("rules-open").addEventListener("click", () => $("rules").showModal());
$("volumes-show-drives").addEventListener("change", (event) => {
  store.showDrives = event.target.checked;
  localStorage.setItem("cif-show-drives", store.showDrives ? "1" : "0");
  renderVolumes();
});
$("recent-clear").addEventListener("click", clearScanHistory);

$("rule-input").addEventListener("input", validateRule);
$("rule-save").addEventListener("click", async () => {
  try {
    await api("/api/config", { method: "PUT", body: { rule: $("rule-input").value.trim() } });
    await refreshState();
    toast("Rule saved");
  } catch (err) {
    toast(err.message, true);
  }
});

$("import-go").addEventListener("click", startImport);
$("import-folder").addEventListener("input", () => {
  const presets = store.state.folderPresets ?? [];
  const match = presets.some((p) => p.template === $("import-folder").value);
  $("import-preset").value = match ? $("import-folder").value : "__custom";
  void refreshExample();
  void replan();
});
$("import-preset").addEventListener("change", (event) => {
  if (event.target.value === "__custom") {
    $("import-folder").focus();
    return;
  }
  $("import-folder").value = event.target.value;
  void refreshExample();
  void replan();
});
$("import-rename").addEventListener("change", (event) => {
  $("import-filename").hidden = !event.target.checked;
  if (event.target.checked) {
    if ($("import-filename").value.trim() === "") $("import-filename").value = "{YYYY}{MM}{DD}-{name}";
    $("import-filename").focus();
  }
  void refreshExample();
  void replan();
});
$("import-filename").addEventListener("input", () => {
  void refreshExample();
  void replan();
});

$("picker-up").addEventListener("click", (event) =>
  navigatePicker(event.currentTarget.dataset.parent || ""),
);
$("picker-go").addEventListener("click", () => navigatePicker($("picker-input").value.trim()));
$("picker-choose").addEventListener("click", () => finishPicker(picker.current));
$("picker").addEventListener("close", () => {
  // Covers the Escape key and the header close button, which bypass finishPicker.
  if (picker.resolve) {
    picker.resolve("");
    picker.resolve = null;
  }
});

subscribe();
await refreshState();
await Promise.all([refreshVolumes(), refreshScans()]);

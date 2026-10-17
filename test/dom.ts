/**
 * The smallest DOM `src/web/app.js` will run in.
 *
 * Two bugs in a row got past code review because reading a UI is not the same
 * as running one: a banner whose `hidden` attribute did nothing because a CSS
 * rule outranked it, and a settings control that looked broken but was not. So
 * the front end is driven for real — the actual `app.js` against the actual
 * server — and this is the page it runs in.
 *
 * Deliberately not a DOM implementation. It covers what the app uses and
 * nothing else; anything it does not have, the app should not be reaching for.
 */

export class FakeNode {
  tagName: string;
  id = "";
  childNodes: unknown[] = [];
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  className = "";
  style: Record<string, string> = {};
  hidden = false;
  value = "";
  checked = false;
  disabled = false;
  classList: {
    add: (c: string) => void;
    remove: (c: string) => void;
    toggle: (c: string, on?: boolean) => void;
    contains: (c: string) => boolean;
  };

  constructor(tag: string) {
    this.tagName = String(tag).toUpperCase();
    const classes = () => this.className.split(" ").filter(Boolean);
    this.classList = {
      add: (c) => {
        if (!classes().includes(c)) this.className = [...classes(), c].join(" ");
      },
      remove: (c) => {
        this.className = classes().filter((x) => x !== c).join(" ");
      },
      toggle: (c, on) => (on ? this.classList.add(c) : this.classList.remove(c)),
      contains: (c) => classes().includes(c),
    };
  }

  /** Reading it walks the children, and setting it replaces them — as a DOM does. */
  get textContent(): string {
    return this.childNodes
      .map((c) =>
        c instanceof FakeNode ? c.textContent : String((c as { nodeValue?: string }).nodeValue ?? ""),
      )
      .join("");
  }
  set textContent(value: string) {
    this.childNodes = [{ nodeValue: String(value) }];
  }

  get children(): FakeNode[] {
    return this.childNodes.filter((c): c is FakeNode => c instanceof FakeNode);
  }

  /** Every descendant, for finding a control without knowing the shape above it. */
  get descendants(): FakeNode[] {
    return this.children.flatMap((child) => [child, ...child.descendants]);
  }

  setAttribute(key: string, value: string): void {
    this.attributes[key] = String(value);
    if (key === "value") this.value = String(value);
  }
  getAttribute(key: string): string | null {
    return this.attributes[key] ?? null;
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  append(...kids: unknown[]): void {
    for (const kid of kids) this.childNodes.push(kid);
  }
  replaceChildren(...kids: unknown[]): void {
    this.childNodes = kids.filter(Boolean);
  }
  click(): void {
    this.fire("click");
  }
  /** Drives a listener the way a real interaction would. */
  fire(type: string, extra: Record<string, unknown> = {}): void {
    for (const fn of this.listeners[type] ?? []) {
      fn({ target: this, currentTarget: this, preventDefault() {}, ...extra });
    }
  }
  focus(): void {}
  select(): void {}
  showModal(): void {
    this.attributes.open = "";
  }
  close(): void {
    delete this.attributes.open;
  }
  get open(): boolean {
    return "open" in this.attributes;
  }
}

export interface InstalledDom {
  byId: Map<string, FakeNode>;
  /** `getElementById`, creating on demand the way the real page has them already. */
  $: (id: string) => FakeNode;
}

/**
 * Puts the globals `app.js` expects onto `globalThis`.
 *
 * `fetch` is left to the caller: what the app should see from `/api/volumes`
 * depends on the test, and the machine's real drives are no basis for an
 * assertion.
 */
export function installDom(): InstalledDom {
  const byId = new Map<string, FakeNode>();
  const get = (id: string): FakeNode => {
    let node = byId.get(id);
    if (!node) {
      node = new FakeNode("div");
      node.id = id;
      byId.set(id, node);
    }
    return node;
  };

  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    createTextNode: (t: unknown) => ({ nodeValue: String(t) }),
    getElementById: get,
    addEventListener() {},
  };
  g.Node = FakeNode;
  g.window = { scrollTo() {}, addEventListener() {} };
  g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  g.confirm = () => true;
  g.prompt = () => null;
  g.EventSource = class {
    addEventListener() {}
    close() {}
  };

  return { byId, $: get };
}

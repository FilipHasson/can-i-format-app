/**
 * Boolean rules over library keys, e.g. `(main or backupB) and offsite`.
 *
 * A card file is safe to delete when the rule evaluates true against the set of
 * libraries it was found in. Keeping this as an expression (rather than, say, a
 * list of "required" and "any-of" groups) is what makes nested requirements
 * like "in either working catalog AND on the archive drive" expressible.
 */

export type RuleNode =
  | { type: "lib"; key: string }
  | { type: "and"; children: RuleNode[] }
  | { type: "or"; children: RuleNode[] }
  | { type: "not"; operand: RuleNode };

export class RuleSyntaxError extends Error {
  position: number;
  constructor(message: string, position: number) {
    super(message);
    this.name = "RuleSyntaxError";
    this.position = position;
  }
}

type Token =
  | { kind: "ident"; value: string; pos: number }
  | { kind: "and" | "or" | "not" | "("| ")" | "eof"; pos: number };

const IDENT_START = /[A-Za-z0-9_]/;
const IDENT_REST = /[A-Za-z0-9_-]/;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const c = input[i] as string;

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      tokens.push({ kind: c, pos: i });
      i++;
      continue;
    }
    if (c === "&") {
      const two = input.startsWith("&&", i);
      tokens.push({ kind: "and", pos: i });
      i += two ? 2 : 1;
      continue;
    }
    if (c === "|") {
      const two = input.startsWith("||", i);
      tokens.push({ kind: "or", pos: i });
      i += two ? 2 : 1;
      continue;
    }
    if (c === "!") {
      tokens.push({ kind: "not", pos: i });
      i++;
      continue;
    }
    if (IDENT_START.test(c)) {
      const start = i;
      while (i < input.length && IDENT_REST.test(input[i] as string)) i++;
      const word = input.slice(start, i);
      const lower = word.toLowerCase();
      if (lower === "and") tokens.push({ kind: "and", pos: start });
      else if (lower === "or") tokens.push({ kind: "or", pos: start });
      else if (lower === "not") tokens.push({ kind: "not", pos: start });
      else tokens.push({ kind: "ident", value: word, pos: start });
      continue;
    }

    throw new RuleSyntaxError(`Unexpected character ${JSON.stringify(c)}`, i);
  }

  tokens.push({ kind: "eof", pos: input.length });
  return tokens;
}

export function parseRule(input: string): RuleNode {
  const tokens = tokenize(input);
  let pos = 0;

  const peek = (): Token => tokens[pos] as Token;
  const next = (): Token => tokens[pos++] as Token;

  function parseOr(): RuleNode {
    const children = [parseAnd()];
    while (peek().kind === "or") {
      next();
      children.push(parseAnd());
    }
    return children.length === 1 ? (children[0] as RuleNode) : { type: "or", children };
  }

  function parseAnd(): RuleNode {
    const children = [parseUnary()];
    while (peek().kind === "and") {
      next();
      children.push(parseUnary());
    }
    return children.length === 1 ? (children[0] as RuleNode) : { type: "and", children };
  }

  function parseUnary(): RuleNode {
    if (peek().kind === "not") {
      next();
      return { type: "not", operand: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary(): RuleNode {
    const tok = next();
    if (tok.kind === "ident") return { type: "lib", key: tok.value };
    if (tok.kind === "(") {
      const inner = parseOr();
      const close = next();
      if (close.kind !== ")") {
        throw new RuleSyntaxError("Expected a closing parenthesis", close.pos);
      }
      return inner;
    }
    if (tok.kind === "eof") {
      throw new RuleSyntaxError("Rule ended unexpectedly — expected a library name", tok.pos);
    }
    throw new RuleSyntaxError(`Expected a library name, got "${tok.kind}"`, tok.pos);
  }

  if (peek().kind === "eof") {
    throw new RuleSyntaxError("Rule is empty", 0);
  }

  const ast = parseOr();
  const trailing = peek();
  if (trailing.kind !== "eof") {
    throw new RuleSyntaxError(`Unexpected "${trailing.kind}" after the end of the rule`, trailing.pos);
  }
  return ast;
}

export function evaluateRule(node: RuleNode, matched: ReadonlySet<string>): boolean {
  switch (node.type) {
    case "lib":
      return matched.has(node.key);
    case "and":
      return node.children.every((c) => evaluateRule(c, matched));
    case "or":
      return node.children.some((c) => evaluateRule(c, matched));
    case "not":
      return !evaluateRule(node.operand, matched);
  }
}

/** Every library key the rule mentions, in first-appearance order. */
export function ruleKeys(node: RuleNode, out: string[] = []): string[] {
  switch (node.type) {
    case "lib":
      if (!out.includes(node.key)) out.push(node.key);
      break;
    case "and":
    case "or":
      for (const c of node.children) ruleKeys(c, out);
      break;
    case "not":
      ruleKeys(node.operand, out);
      break;
  }
  return out;
}

/** Canonical text form, with parentheses only where precedence needs them. */
export function formatRule(node: RuleNode, parentPrecedence = 0): string {
  //          or = 1, and = 2, not = 3
  switch (node.type) {
    case "lib":
      return node.key;
    case "not":
      return `not ${formatRule(node.operand, 3)}`;
    case "and": {
      const text = node.children.map((c) => formatRule(c, 2)).join(" and ");
      return parentPrecedence > 2 ? `(${text})` : text;
    }
    case "or": {
      const text = node.children.map((c) => formatRule(c, 1)).join(" or ");
      return parentPrecedence > 1 ? `(${text})` : text;
    }
  }
}

export interface RuleExplanation {
  text: string;
  satisfied: boolean;
  type: RuleNode["type"];
  children?: RuleExplanation[];
}

/** Per-node satisfaction, so the UI can highlight which clause failed. */
export function explainRule(node: RuleNode, matched: ReadonlySet<string>): RuleExplanation {
  const satisfied = evaluateRule(node, matched);
  const base = { text: formatRule(node), satisfied, type: node.type };

  switch (node.type) {
    case "lib":
      return base;
    case "not":
      return { ...base, children: [explainRule(node.operand, matched)] };
    case "and":
    case "or":
      return { ...base, children: node.children.map((c) => explainRule(c, matched)) };
  }
}

/**
 * The smallest description of what is still missing, for a rule that failed.
 *
 * For `(main or backup) and offsite` where the file is in `main` only, this
 * returns `offsite` rather than restating the whole rule — that is the sentence
 * the user actually needs before deciding to reformat.
 */
export function describeGap(node: RuleNode, matched: ReadonlySet<string>): string {
  if (evaluateRule(node, matched)) return "";

  switch (node.type) {
    case "lib":
      return node.key;
    case "not":
      return `not ${formatRule(node.operand, 3)}`;
    case "and": {
      const failing = node.children.filter((c) => !evaluateRule(c, matched));
      return failing.map((c) => describeGapWrapped(c, matched)).join(" and ");
    }
    case "or":
      // Every branch failed, so the whole alternation is the requirement.
      // Parenthesising is `describeGapWrapped`'s job, not ours.
      return formatRule(node, 0);
  }
}

function describeGapWrapped(node: RuleNode, matched: ReadonlySet<string>): string {
  const gap = describeGap(node, matched);
  return node.type === "or" ? `(${gap})` : gap;
}

export interface RuleValidation {
  ok: boolean;
  error?: string;
  position?: number;
  unknownKeys?: string[];
  ast?: RuleNode;
}

/**
 * A rule with one library key swapped for another, written as the user wrote
 * it — spacing, parentheses and `&&` left alone.
 *
 * Done on tokens rather than text, because keys share prefixes: renaming
 * `backup` must not touch `backup-2`, and a find-and-replace would. A rule
 * that does not parse is returned unchanged rather than half-rewritten.
 */
export function renameInRule(input: string, from: string, to: string): string {
  let tokens: Token[];
  try {
    tokens = tokenize(input);
  } catch (err) {
    if (err instanceof RuleSyntaxError) return input;
    throw err;
  }

  let out = "";
  let at = 0;
  for (const token of tokens) {
    if (token.kind !== "ident" || token.value !== from) continue;
    out += input.slice(at, token.pos) + to;
    at = token.pos + from.length;
  }
  return out + input.slice(at);
}

/** Parse plus a check that every referenced library actually exists. */
export function validateRule(input: string, knownKeys: readonly string[]): RuleValidation {
  let ast: RuleNode;
  try {
    ast = parseRule(input);
  } catch (err) {
    if (err instanceof RuleSyntaxError) {
      return { ok: false, error: err.message, position: err.position };
    }
    throw err;
  }

  const known = new Set(knownKeys);
  const unknown = ruleKeys(ast).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Rule refers to ${unknown.length === 1 ? "an unknown library" : "unknown libraries"}: ${unknown.join(", ")}`,
      unknownKeys: unknown,
      ast,
    };
  }

  return { ok: true, ast };
}

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  describeGap,
  evaluateRule,
  formatRule,
  parseRule,
  renameInRule,
  ruleKeys,
  RuleSyntaxError,
  validateRule,
} from "../src/core/rules.ts";
import { keyProblem } from "../src/core/config.ts";

const matched = (...keys: string[]) => new Set(keys);

describe("rule parsing", () => {
  test("parses the nested form the tool exists to express", () => {
    const ast = parseRule("(catalogA or catalogB) and backup");
    assert.equal(formatRule(ast), "(catalogA or catalogB) and backup");
    assert.deepEqual(ruleKeys(ast), ["catalogA", "catalogB", "backup"]);
  });

  test("and binds tighter than or", () => {
    // `a or b and c` must mean `a or (b and c)`, not `(a or b) and c`.
    const ast = parseRule("a or b and c");
    assert.equal(formatRule(ast), "a or b and c");
    assert.equal(evaluateRule(ast, matched("a")), true);
    assert.equal(evaluateRule(ast, matched("b")), false);
    assert.equal(evaluateRule(ast, matched("b", "c")), true);
  });

  test("accepts symbolic operators and mixed case keywords", () => {
    const ast = parseRule("(a || b) && !c");
    assert.equal(evaluateRule(ast, matched("a")), true);
    assert.equal(evaluateRule(ast, matched("a", "c")), false);
    assert.equal(evaluateRule(parseRule("a AND b"), matched("a", "b")), true);
  });

  test("flattens repeated operators rather than nesting pairs", () => {
    const ast = parseRule("a and b and c");
    assert.equal(ast.type, "and");
    assert.equal(ast.type === "and" ? ast.children.length : 0, 3);
  });

  test("reports position on malformed input", () => {
    assert.throws(() => parseRule("a and"), RuleSyntaxError);
    assert.throws(() => parseRule("(a or b"), RuleSyntaxError);
    assert.throws(() => parseRule(""), RuleSyntaxError);
    assert.throws(() => parseRule("a b"), RuleSyntaxError);

    try {
      parseRule("a and @");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof RuleSyntaxError);
      assert.equal(err.position, 6);
    }
  });
});

describe("rule evaluation", () => {
  const rule = parseRule("(catalogA or catalogB) and backup");

  test("either catalog satisfies the alternation", () => {
    assert.equal(evaluateRule(rule, matched("catalogA", "backup")), true);
    assert.equal(evaluateRule(rule, matched("catalogB", "backup")), true);
  });

  test("backup is not optional", () => {
    assert.equal(evaluateRule(rule, matched("catalogA")), false);
    assert.equal(evaluateRule(rule, matched("catalogA", "catalogB")), false);
  });

  test("neither catalog is not enough", () => {
    assert.equal(evaluateRule(rule, matched("backup")), false);
  });
});

describe("gap description", () => {
  const rule = parseRule("(catalogA or catalogB) and backup");

  test("names only the clause that is actually unmet", () => {
    // The whole point: don't restate the rule, say what is missing.
    assert.equal(describeGap(rule, matched("catalogA")), "backup");
    assert.equal(describeGap(rule, matched("backup")), "(catalogA or catalogB)");
  });

  test("reports both halves when nothing matched", () => {
    assert.equal(describeGap(rule, matched()), "(catalogA or catalogB) and backup");
  });

  test("is empty when the rule is satisfied", () => {
    assert.equal(describeGap(rule, matched("catalogB", "backup")), "");
  });

  test("handles a flat conjunction", () => {
    const flat = parseRule("main and backup and offsite");
    assert.equal(describeGap(flat, matched("main")), "backup and offsite");
    assert.equal(describeGap(flat, matched("main", "backup")), "offsite");
  });
});

describe("validation against configured libraries", () => {
  test("accepts a rule using known keys", () => {
    const result = validateRule("main and backup", ["main", "backup"]);
    assert.equal(result.ok, true);
  });

  test("rejects references to libraries that do not exist", () => {
    const result = validateRule("main and typo", ["main", "backup"]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.unknownKeys, ["typo"]);
  });

  test("surfaces syntax errors without throwing", () => {
    const result = validateRule("main and", ["main"]);
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });
});

describe("renaming a key inside a rule", () => {
  test("every mention is renamed", () => {
    assert.equal(renameInRule("(main or catalog) and backup", "backup", "offsite"), "(main or catalog) and offsite");
    assert.equal(renameInRule("backup or (main and backup)", "backup", "nas"), "nas or (main and nas)");
  });

  test("a key that merely starts the same is left alone", () => {
    // A find-and-replace would turn backup-2 into offsite-2.
    assert.equal(renameInRule("backup and backup-2", "backup", "offsite"), "offsite and backup-2");
    assert.equal(renameInRule("main-catalog and main", "main", "home"), "main-catalog and home");
  });

  test("the rule is otherwise written as it was", () => {
    assert.equal(renameInRule("  main&&( backup ||nas )", "backup", "b2"), "  main&&( b2 ||nas )");
  });

  test("the words of the rule itself are not keys", () => {
    assert.equal(renameInRule("main and not backup", "and", "x"), "main and not backup");
  });

  test("a rule that does not parse comes back untouched", () => {
    assert.equal(renameInRule("main and $backup", "main", "home"), "main and $backup");
  });
});

describe("a key chosen by hand", () => {
  test("is accepted in the shape keys are made", () => {
    assert.equal(keyProblem("offsite", ["main"]), null);
    assert.equal(keyProblem("backup-2", ["main"]), null);
    assert.equal(keyProblem("nas_drive", ["main"]), null);
  });

  test("is refused when it could not stand as a word in a rule", () => {
    for (const bad of ["", "Backup", "2nd", "-main", "off site", "a(b", "x".repeat(41)]) {
      assert.ok(keyProblem(bad, []), `${JSON.stringify(bad)} should be refused`);
    }
  });

  test("is refused when it is one of the rule's own words", () => {
    for (const word of ["and", "or", "not"]) assert.ok(keyProblem(word, []));
  });

  test("is refused when another library already has it", () => {
    assert.match(keyProblem("backup", ["main", "backup"]) ?? "", /already/);
  });
});

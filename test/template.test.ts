import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  FOLDER_PRESETS,
  disambiguate,
  expandFilename,
  expandTemplate,
  joinUnder,
  safeSegment,
  suggestToken,
  unknownTokens,
  type TemplateFacts,
} from "../src/core/template.ts";

/**
 * The template decides where someone's originals live.
 *
 * Two things are being pinned down here. The first is that the layout people
 * actually use comes out right. The second, and the reason most of these exist,
 * is that a template typed into a text box cannot be talked into writing
 * outside the folder it was given.
 */

const BASE: TemplateFacts = {
  capturedAt: 20240501091005,
  mtimeMs: Date.UTC(2019, 0, 2, 3, 4, 5),
  name: "A9303932.ARW",
  ext: "arw",
  kind: "raw",
  group: "photos",
  camera: "ILCE-7RM5",
  card: "CFexpress 512GB",
  cardDir: "DCIM/10160619",
};

const facts = (over: Partial<TemplateFacts> = {}): TemplateFacts => ({ ...BASE, ...over });

describe("the layouts people file by", () => {
  test("Lightroom's default", () => {
    assert.equal(expandTemplate("{YYYY}/{YYYY}-{MM}-{DD}", facts()).path, "2024/2024-05-01");
  });

  test("year / month / day", () => {
    assert.equal(expandTemplate("{YYYY}/{MM}/{DD}", facts()).path, "2024/05/01");
  });

  test("date and camera together", () => {
    assert.equal(
      expandTemplate("{YYYY}/{YYYY}-{MM}-{DD} {camera}", facts()).path,
      "2024/2024-05-01 ILCE-7RM5",
    );
  });

  test("month-day-year, which is a layout people really have", () => {
    assert.equal(expandTemplate("{YYYY}/{MM}-{DD}-{YYYY}", facts()).path, "2024/05-01-2024");
  });

  test("without leading zeros, which is another", () => {
    // The distinction is not cosmetic: a library filed as 2024/5-1-2024 gets a
    // duplicate sibling folder the moment something writes 2024/05-01-2024.
    assert.equal(expandTemplate("{YYYY}/{M}-{D}-{YYYY}", facts()).path, "2024/5-1-2024");
  });

  test("and the unpadded ones stay two digits past the ninth", () => {
    const december = facts({ capturedAt: 20241207093000 });
    assert.equal(expandTemplate("{M}-{D}", december).path, "12-7");
    assert.equal(expandTemplate("{MM}-{DD}", december).path, "12-07");
  });

  test("an empty template means one flat folder", () => {
    assert.equal(expandTemplate("", facts()).path, "");
  });

  test("every preset produces something usable", () => {
    for (const preset of FOLDER_PRESETS) {
      assert.deepEqual(unknownTokens(preset.template), [], `${preset.template} has a bad token`);
      const { path } = expandTemplate(preset.template, facts());
      assert.ok(joinUnder("/library", path), `${preset.template} escaped its destination`);
    }
  });

  test("spaces and hyphens survive — they are most of what a date looks like", () => {
    assert.equal(safeSegment("2024-05-01 ILCE-7RM5"), "2024-05-01 ILCE-7RM5");
  });
});

describe("dates", () => {
  test("come from the capture time when there is one", () => {
    const { path, datedByFile } = expandTemplate("{YYYY}-{MM}-{DD} {HH}{mm}{ss}", facts());
    assert.equal(path, "2024-05-01 091005");
    assert.equal(datedByFile, false);
  });

  test("fall back to the file's own date, and say so", () => {
    const { path, datedByFile } = expandTemplate("{YYYY}", facts({ capturedAt: null }));
    // Local time, deliberately: the mtime is standing in for "when this was
    // shot" and the person filing it thinks in their own clock.
    assert.equal(path, String(new Date(BASE.mtimeMs).getFullYear()));
    assert.equal(datedByFile, true, "the caller has to be able to warn about this");
  });

  test("a capture time of zero is not a date", () => {
    assert.equal(expandTemplate("{YYYY}", facts({ capturedAt: 0 })).datedByFile, true);
  });

  test("two-digit years come off the four-digit one", () => {
    assert.equal(expandTemplate("{YY}", facts()).path, "24");
  });

  test("the unpadded pair work off a file's own date too", () => {
    // Early January in the fixture, so both parts are single digits whichever
    // side of midnight the machine's zone puts it — which is the case that
    // tells padded and unpadded apart. Asserting the literal date here would
    // be asserting the tester's timezone.
    const { path } = expandTemplate("{M}-{D}", facts({ capturedAt: null }));
    const d = new Date(BASE.mtimeMs);
    assert.equal(path, `${d.getMonth() + 1}-${d.getDate()}`);
    assert.doesNotMatch(path, /(^|-)0\d/, "no leading zeros");
  });
});

describe("a segment that would break", () => {
  test("loses the characters Windows refuses", () => {
    assert.equal(safeSegment('a<b>c:d"e|f?g*h'), "abcdefgh");
  });

  test("loses trailing dots and spaces, which Windows silently strips anyway", () => {
    // Left in, the path we record and the path that exists disagree, and the
    // next scan cannot find the file it just wrote.
    assert.equal(safeSegment("Sunday shoot. "), "Sunday shoot");
  });

  test("becomes nothing when it is a reserved device name", () => {
    assert.equal(safeSegment("CON"), "");
    assert.equal(safeSegment("lpt1.txt"), "");
    assert.equal(safeSegment("console"), "console", "only the exact names are reserved");
  });

  test("collapses the gaps an absent token leaves", () => {
    assert.equal(expandTemplate("{YYYY}-{MM}-{DD} {camera}", facts({ camera: null })).path, "2024-05-01");
  });

  test("drops out entirely rather than making an empty folder", () => {
    assert.equal(expandTemplate("{camera}/{YYYY}", facts({ camera: null })).path, "2024");
  });
});

describe("a template that tries to get out", () => {
  test("cannot climb with ..", () => {
    assert.equal(expandTemplate("../../{YYYY}", facts()).path, "2024");
  });

  test("cannot climb through a token's value either", () => {
    const { path } = expandTemplate("{camera}/{YYYY}", facts({ camera: "../../../Windows" }));
    assert.equal(path, "Windows/2024");
  });

  test("cannot name an absolute path", () => {
    // The drive colon is stripped, so what survives is an ordinary relative
    // path that lands under the destination like any other.
    const { path } = expandTemplate("{camera}", facts({ camera: "C:/Windows/System32" }));
    assert.equal(path, "C/Windows/System32");
    assert.ok(joinUnder("/library", path)?.includes("/library/"));
  });

  test("cannot smuggle a separator through a token", () => {
    // The value is expanded first and split afterwards, so a slash inside a
    // camera name would become a folder boundary if segments were not
    // sanitised individually.
    const { path } = expandTemplate("{camera}", facts({ camera: "a/../../b" }));
    assert.equal(path, "a/b");
  });
});

describe("joinUnder", () => {
  const base = process.platform === "win32" ? "C:/library" : "/library";

  test("joins a relative path onto the base", () => {
    assert.equal(joinUnder(base, "2024/05"), `${base}/2024/05`);
  });

  test("an empty relative path is the base itself", () => {
    assert.equal(joinUnder(base, ""), base);
  });

  test("refuses a path that climbs out", () => {
    assert.equal(joinUnder(base, "../elsewhere"), null);
  });

  test("refuses a sibling whose name merely starts the same way", () => {
    // "C:/library-backup" starts with "C:/library" as a string but is not
    // inside it. Comparing on the separator is what makes that safe.
    assert.equal(joinUnder(base, "../library-backup/x"), null);
  });

  test("tolerates a trailing slash on the base", () => {
    assert.equal(joinUnder(`${base}/`, "2024"), `${base}/2024`);
  });
});

describe("file names", () => {
  test("keep the camera's name by default", () => {
    assert.equal(expandFilename("{name}", facts()), "A9303932.ARW");
  });

  test("keep the original extension, exactly as the camera wrote it", () => {
    // Not the folded `ext` the matcher uses: a photographer looking for
    // A9303932.ARW should find it under that name, not .arw.
    assert.equal(expandFilename("{YYYY}{MM}{DD}-{name}", facts()), "20240501-A9303932.ARW");
  });

  test("a file with no extension keeps having none", () => {
    assert.equal(expandFilename("{name}", facts({ name: "READ_ME", ext: "" })), "READ_ME");
  });

  test("fall back to the original when the template sanitises to nothing", () => {
    assert.equal(expandFilename("{camera}", facts({ camera: null })), "A9303932.ARW");
  });
});

describe("unknownTokens", () => {
  test("says nothing about a template that is fine", () => {
    assert.deepEqual(unknownTokens("{YYYY}/{YYYY}-{MM}-{DD}"), []);
  });

  test("names what it does not recognise, so the message can be specific", () => {
    assert.deepEqual(unknownTokens("{YYYY}/{yyyy}/{month}"), ["yyyy", "month"]);
  });
});

describe("suggestToken", () => {
  test("catches a case slip, which is the mistake people actually make", () => {
    assert.equal(suggestToken("yyyy"), "YYYY");
    assert.equal(suggestToken("dd"), "DD");
    assert.equal(suggestToken("Camera"), "camera");
  });

  test("has nothing to say about a word that is not a token at all", () => {
    assert.equal(suggestToken("month"), null);
  });

  test("says nothing about a token that is already valid", () => {
    assert.equal(suggestToken("MM"), null, "{MM} is a month");
    assert.equal(suggestToken("mm"), null, "{mm} is a minute — both are real");
  });

  test("refuses to guess between a month and a minute", () => {
    // {Mm} matches both case-insensitively. Suggesting either and having it
    // taken on trust would file a year of work by the wrong number, and look
    // entirely plausible doing it.
    assert.equal(suggestToken("Mm"), null);
    assert.equal(suggestToken("mM"), null);
  });
});

describe("disambiguate", () => {
  test("leaves the first one alone", () => {
    assert.equal(disambiguate("IMG_0001.CR3", 1), "IMG_0001.CR3");
  });

  test("goes before the extension", () => {
    assert.equal(disambiguate("IMG_0001.CR3", 2), "IMG_0001_2.CR3");
  });

  test("copes with a name that has no extension", () => {
    assert.equal(disambiguate("IMG_0001", 3), "IMG_0001_3");
  });
});

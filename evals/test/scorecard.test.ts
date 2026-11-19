import { describe, expect, it } from "vitest";
import { cutDetail, type CutDetail } from "../src/cutDetail.ts";
import type { PacingSummary } from "../src/metrics.ts";
import type { Score } from "../src/score.ts";
import { card, factors, ledgerPct, mistakes, overallOf, ratio, scorecardMarkdown, FACTORS } from "../src/scorecard.ts";

const pace = (o: { dead: number; joins: number; restarts?: number }): PacingSummary => ({
  words: 100, joins: o.joins, gaps: { inside: 0, atJoins: 0, long: 0, excessSeconds: o.dead }, medianJoinGapSeconds: null,
  repeats: { total: 0, singleWords: 0, phrases: 0, atJoins: 0 }, restarts: o.restarts ?? 0, silences: 0,
});

/** A scored pass on a recording whose editor left 10 s of dead air, 2 restarts and 50 cuts. The cut plays 20 minutes. */
function score(o: { missing?: number; clipped?: number; dead?: number; joins?: number; restarts?: number; spaces?: number[]; shared?: number; reference?: boolean; moments?: string[] } = {}): Score {
  const reference = o.reference ?? true;
  const cut = { words: { tp: 0, fp: 0, fn: 0, precision: 0.9, recall: 0.8, f1: 0.85, inScope: 100 }, requiredLines: { required: 50, missing: o.missing ?? 0 } };
  const matched = (o.spaces ?? [0, 50, 100, 250]).map(errorMs => ({ errorMs }));
  return {
    applied: { edges: { total: 80, clippedOnSound: o.clipped ?? 2 } },
    review: { edges: { total: 20, clippedOnSound: 0 } },
    pacing: {
      source: pace({ dead: 1000, joins: 0, restarts: 120 }),
      applied: pace({ dead: o.dead ?? 10, joins: o.joins ?? 50, restarts: o.restarts ?? 2 }),
      ...(reference && { reference: pace({ dead: 10, joins: 50, restarts: 2 }), sharedJoins: { applied: { matched, eligible: 40, shared: o.shared ?? 30, medianAbsErrorMs: 75 } } }),
    },
    reference: reference ? { operatingPoints: { applied: { cut }, recommended: { cut }, proposed: { cut } } } : null,
    left: { kept: { m: [{ start: 0, end: 1200 }] }, removed: {}, staged: [] },
    ...(o.moments && { moments: o.moments.map((outcome, i) => ({ id: `m${i}`, outcome })) }),
    headline: { needsYourCall: 2, tokens: 3_000_000, activeMinutes: 6 },
  } as unknown as Score;
}

const detail = (o: Partial<{ editor: number; scarlet: number; editorMatched: number; scarletMatched: number; wrong: number[]; left: number[]; short: number }> = {}): CutDetail => ({
  decisions: { editor: o.editor ?? 20, scarlet: o.scarlet ?? 20, editorMatched: o.editorMatched ?? 20, scarletMatched: o.scarletMatched ?? 20 },
  wronglyCut: (o.wrong ?? []).map(words => ({ start: 0, end: 1, words, text: "" })), leftIn: (o.left ?? []).map(words => ({ start: 0, end: 1, words, text: "" })),
  pauses: { total: 100, editorTrimmed: 40, scarletTrimmed: 30, bothTrimmed: 20 },
  takes: { decided: 10, same: 8, other: 1, both: 1, neither: 0 },
  pieces: { total: 50, short: o.short ?? 0, editorTotal: 50, editorShort: 0 },
});

describe("ratio", () => {
  it("is the smaller amount over the larger, whichever side is over", () => {
    expect(ratio(10, 10)).toBe(100);
    expect(ratio(20, 10)).toBe(50);
    expect(ratio(5, 10)).toBe(50);
    expect(ratio(0, 0)).toBe(100);
  });
});

describe("factors", () => {
  it("reads each factor on the scale of the editor's own cut", () => {
    const f = factors(score(), detail());
    expect(f.cutDecisions.pct).toBe(100);
    expect(f.takeChoice.pct).toBe(80);
    expect(f.linesKept.pct).toBe(100);
    expect(f.sameCuts.pct).toBe(75);
    expect(f.wholeWords).toMatchObject({ pct: 98, detail: "2 of 100 cut edges land inside a sounding word" });
    // The editor left 60 pauses alone and Scarlet trimmed 10 of them; of the 40 the editor trimmed, Scarlet trimmed 20.
    expect(f.pausesLeft.pct).toBeCloseTo(83.3, 1);
    expect(f.pausesTrimmed.pct).toBe(50);
    expect(f.deadAir.pct).toBe(100);
    expect(f.cutCount.pct).toBe(100);
    expect(f.spaceAtCut.pct).toBe(75);
    expect(f.nothingLeftIn.pct).toBe(100);
    expect(f.noStutter.pct).toBe(100);
    expect(f.knownMoments.pct).toBeNull();
  });

  it("scores dead air against what the editor left, not against the recording's", () => {
    // Three times the editor's 10 s is a third, though both are a sliver of the recording's 1000 s.
    expect(factors(score({ dead: 30 }), detail()).deadAir.pct).toBeCloseTo(33.3, 1);
    expect(factors(score({ dead: 5 }), detail()).deadAir.pct).toBe(50);
  });

  it("counts a removal once however long it is", () => {
    // Scarlet made 15 of the editor's 20 removals and 5 of its own 20 were not the editor's.
    const f = factors(score(), detail({ editorMatched: 15, scarletMatched: 15 }));
    expect(f.cutDecisions.pct).toBe(75);
    expect(f.cutDecisions.detail).toContain("by words, which flatters: 85%");
  });

  it("marks down too many cuts and too few alike, and each restart over the editor's", () => {
    expect(factors(score({ joins: 100 }), detail()).cutCount.pct).toBe(50);
    expect(factors(score({ joins: 25 }), detail()).cutCount.pct).toBe(50);
    expect(factors(score({ restarts: 5 }), detail()).nothingLeftIn.pct).toBe(50);
    expect(factors(score({ restarts: 1 }), detail()).nothingLeftIn.pct).toBe(100);
  });

  it("has no figure for what needs the case's words or the published video when they aren't there", () => {
    const noWords = factors(score());
    expect(noWords.cutDecisions.pct).toBeNull();
    expect(noWords.pausesTrimmed.pct).toBeNull();
    expect(noWords.linesKept.pct).toBe(100);
    const noVideo = factors(score({ reference: false }));
    expect(noVideo.deadAir.pct).toBeNull();
    expect(noVideo.wholeWords.pct).toBe(98);
  });
});

describe("mistakes", () => {
  it("counts runs of two words or more, clipped words and stutter cuts, for every ten minutes the cut plays", () => {
    const m = mistakes(score({ clipped: 4 }), detail({ wrong: [1, 2, 6], left: [1, 1, 3], short: 1 }));
    expect(m).toMatchObject({ wronglyCut: 2, leftIn: 1, clippedWords: 4, stutters: 1, total: 8, per10Min: 4 });
  });
});

describe("cutDetail", () => {
  // "so the the plan works" at one word a second, 0.2 s between words, then a pause of 1.2 s before "now go".
  const words = ["so", "the", "the", "plan", "works", "now", "go"].map((text, i) => ({ text, start: i + (i >= 5 ? 1 : 0), end: i + 0.8 + (i >= 5 ? 1 : 0) }));
  const base = [{ start: 0, end: 8 }];

  it("reads removals as decisions and names the runs one cut plays and the other doesn't", () => {
    // The editor cut the first "the"; Scarlet cut that and "works" too.
    const d = cutDetail(words, base, [{ start: 0, end: 1 }, { start: 2, end: 4 }, { start: 5, end: 8 }], [{ start: 0, end: 1 }, { start: 2, end: 8 }]);
    expect(d.decisions).toEqual({ editor: 1, scarlet: 2, editorMatched: 1, scarletMatched: 1 });
    expect(d.wronglyCut.map(x => x.text)).toEqual(["works"]);
    expect(d.leftIn).toEqual([]);
  });

  it("counts a pause one cut trimmed and the other left", () => {
    // Both play "works" and "now"; the editor closed the 1.2 s between them and Scarlet left it.
    const d = cutDetail(words, base, base, [{ start: 0, end: 4.9 }, { start: 5.9, end: 8 }]);
    expect(d.pauses).toEqual({ total: 1, editorTrimmed: 1, scarletTrimmed: 0, bothTrimmed: 0 });
  });

  it("counts a piece under a second between two cuts as a stutter", () => {
    const d = cutDetail(words, base, [{ start: 0, end: 2 }, { start: 3, end: 3.8 }, { start: 5, end: 8 }], base);
    expect(d.pieces).toMatchObject({ total: 3, short: 1, editorTotal: 1, editorShort: 0 });
  });
});

describe("card", () => {
  it("averages trials within a recording, then recordings, so a recording with more trials counts once", () => {
    const c = card("main", [
      { caseId: "a", score: score({ missing: 5 }) }, { caseId: "a", score: score({ missing: 10 }) }, { caseId: "a", score: score({ missing: 15 }) },
      { caseId: "b", score: score({ missing: 30 }) },
    ]);
    expect(c.byCase.a!.linesKept).toMatchObject({ mean: 80, min: 70, max: 90, n: 3 });
    expect(c.factors.linesKept).toMatchObject({ mean: 60, min: 40, max: 90, n: 4 });
    expect(c.trials).toBe(4);
    expect(c.facts.tokens!.mean).toBe(3_000_000);
    expect(c.mistakesPer10Min).toBeNull();
  });

  it("compares two sides only on the factors both have", () => {
    const withMoments = card("change", [{ caseId: "a", score: score({ moments: ["wrong"] }), detail: detail() }]);
    const without = card("main", [{ caseId: "a", score: score(), detail: detail() }]);
    const common = FACTORS.map(f => f.id).filter(id => id !== "knownMoments");
    expect(overallOf(withMoments.factors, common)).toBe(overallOf(without.factors, common));
    expect(withMoments.overall).toBeLessThan(without.overall!);
    expect(scorecardMarkdown([without, withMoments])).toContain("the mean of the 12 factors every side has");
  });
});

describe("scorecardMarkdown", () => {
  it("says a difference is within the spread when the two sides' trials overlap", () => {
    const side = (label: string, missing: number[]) => card(label, missing.map(m => ({ caseId: "a", score: score({ missing: m }) })));
    const main = side("main", [15, 10]);
    expect(scorecardMarkdown([main, side("change", [11, 7])])).toContain("| Lines kept | 75% (70–80) | 82% (78–86) | +7 (within the spread) |");
    expect(scorecardMarkdown([main, side("change", [5, 4])])).toContain("| Lines kept | 75% (70–80) | 91% (90–92) | +16 |");
  });

  it("lists the mistakes a viewer would notice, and warns when there is too little to read much into it", () => {
    const md = scorecardMarkdown([card("main", [{ caseId: "a", score: score(), detail: detail({ wrong: [3], left: [2, 4] }) }])]);
    expect(md).toContain("| **In every 10 minutes of the cut** | 2.5 |");
    expect(md).toContain("| Left in, and the editor cut it | 2 |");
    expect(md).toContain("Fewer than 4 passes a side");
    expect(md).toContain("With fewer than three");
  });
});

describe("ledgerPct", () => {
  it("is the share of free checks that pass: a check that needs a model isn't counted", () => {
    expect(ledgerPct([{ verdict: "pass" }, { verdict: "pass" }, { verdict: "fail" }, { verdict: "model" }, { verdict: "unchecked" }, { verdict: "error" }]))
      .toEqual({ pct: 50, pass: 2, checked: 4 });
    expect(ledgerPct([{ verdict: "model" }]).pct).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { PacingSummary } from "../src/metrics.ts";
import type { Score } from "../src/score.ts";
import { card, closeness, factors, ledgerPct, overallOf, scorecardMarkdown } from "../src/scorecard.ts";

const pace = (o: { dead: number; joins: number; restarts?: number; repeats?: number }): PacingSummary => ({
  words: 100, joins: o.joins, gaps: { inside: 0, atJoins: 0, long: 0, excessSeconds: o.dead }, medianJoinGapSeconds: null,
  repeats: { total: o.repeats ?? 0, singleWords: 0, phrases: 0, atJoins: 0 }, restarts: o.restarts ?? 0, silences: 0,
});

/** A scored pass on a recording with 100 s of dead air and 12 restarts, whose editor left 10 s, 2 restarts and 50 cuts. */
function score(o: { f1?: number; missing?: number; clipped?: number; dead?: number; joins?: number; restarts?: number; spaces?: number[]; reference?: boolean; moments?: string[] } = {}): Score {
  const reference = o.reference ?? true;
  const cut = { words: { tp: 0, fp: 0, fn: 0, precision: 0.9, recall: 0.8, f1: o.f1 ?? 0.85, inScope: 100 }, requiredLines: { required: 50, missing: o.missing ?? 0 } };
  const matched = (o.spaces ?? [0, 50, 100, 250]).map(errorMs => ({ errorMs }));
  return {
    applied: { edges: { total: 80, clippedOnSound: o.clipped ?? 2 } },
    review: { edges: { total: 20, clippedOnSound: 0 } },
    pacing: {
      source: pace({ dead: 100, joins: 0, restarts: 12 }),
      applied: pace({ dead: o.dead ?? 10, joins: o.joins ?? 50, restarts: o.restarts ?? 2 }),
      ...(reference && { reference: pace({ dead: 10, joins: 50, restarts: 2 }), sharedJoins: { applied: { matched, medianAbsErrorMs: 75 } } }),
    },
    reference: reference ? { operatingPoints: { applied: { cut }, recommended: { cut }, proposed: { cut } } } : null,
    ...(o.moments && { moments: o.moments.map((outcome, i) => ({ id: `m${i}`, outcome })) }),
    headline: { needsYourCall: 2, tokens: 3_000_000, activeMinutes: 6 },
  } as unknown as Score;
}

describe("closeness", () => {
  it("is 100 at the editor's figure and 0 as far from it as the untouched recording, either side", () => {
    expect(closeness(100, 10, 10)).toBe(100);
    expect(closeness(100, 55, 10)).toBe(50);
    expect(closeness(100, 100, 10)).toBe(0);
    // A pass that leaves no dead air where the editor left 10 s is off too, by that much.
    expect(closeness(100, 0, 10)).toBeCloseTo(88.9, 1);
    expect(closeness(100, 400, 10)).toBe(0);
  });
});

describe("factors", () => {
  it("reads each factor as a percentage of the editor's own cut", () => {
    const f = factors(score());
    expect(f.cutAccuracy.pct).toBe(85);
    expect(f.linesKept.pct).toBe(100);
    expect(f.wholeWords).toMatchObject({ pct: 98, detail: "2 of 100 cut edges land inside a sounding word" });
    expect(f.deadAir.pct).toBe(100);
    expect(f.cutCount.pct).toBe(100);
    // Three of the four cuts both made leave a pause within 0.1 s of the editor's.
    expect(f.spaceAtCut.pct).toBe(75);
    expect(f.nothingLeftIn.pct).toBe(100);
    expect(f.knownMoments.pct).toBeNull();
  });

  it("marks down a pass that cuts twice as often as the editor, and one that cuts half as often, alike", () => {
    expect(factors(score({ joins: 100 })).cutCount.pct).toBe(0);
    expect(factors(score({ joins: 75 })).cutCount.pct).toBe(50);
    expect(factors(score({ joins: 25 })).cutCount.pct).toBe(50);
  });

  it("counts only the restarts the editor's cut doesn't play", () => {
    // The editor's cut plays 2; 7 left is 5 more, of the 10 the editor took out.
    expect(factors(score({ restarts: 7 })).nothingLeftIn.pct).toBe(50);
    expect(factors(score({ restarts: 1 })).nothingLeftIn.pct).toBe(100);
  });

  it("counts a lost line, and a spot left to the editor as handled", () => {
    expect(factors(score({ missing: 5 })).linesKept.pct).toBe(90);
    expect(factors(score({ moments: ["right", "asked", "wrong", "wrong"] })).knownMoments.pct).toBe(50);
  });

  it("has no figure where there is no published video, and still counts cut-off words", () => {
    const f = factors(score({ reference: false }));
    expect(f.cutAccuracy.pct).toBeNull();
    expect(f.deadAir.pct).toBeNull();
    expect(f.cutCount.pct).toBeNull();
    expect(f.wholeWords.pct).toBe(98);
  });
});

describe("card", () => {
  it("averages trials within a recording, then recordings, so a recording with more trials counts once", () => {
    const c = card("main", [
      { caseId: "a", score: score({ f1: 0.9 }) }, { caseId: "a", score: score({ f1: 0.8 }) }, { caseId: "a", score: score({ f1: 0.7 }) },
      { caseId: "b", score: score({ f1: 0.4 }) },
    ]);
    expect(c.byCase.a!.cutAccuracy).toMatchObject({ mean: 80, min: 70, max: 90, n: 3 });
    expect(c.factors.cutAccuracy).toMatchObject({ mean: 60, min: 40, max: 90, n: 4 });
    expect(c.trials).toBe(4);
    expect(c.facts.tokens!.mean).toBe(3_000_000);
  });

  it("compares two sides only on the factors both have", () => {
    const withMoments = card("change", [{ caseId: "a", score: score({ moments: ["wrong"] }) }]);
    const without = card("main", [{ caseId: "a", score: score() }]);
    const common = (["cutAccuracy", "linesKept", "wholeWords", "deadAir", "cutCount", "spaceAtCut", "nothingLeftIn"] as const);
    expect(overallOf(withMoments.factors, common)).toBe(overallOf(without.factors, common));
    expect(withMoments.overall).toBeLessThan(without.overall!);
    const md = scorecardMarkdown([without, withMoments]);
    expect(md).toContain("the mean of the 7 factors every side has");
    expect(md).toMatch(/\| \*\*Overall\*\* \| \*\*94%\*\* \| \*\*94%\*\* \|/);
  });
});

describe("scorecardMarkdown", () => {
  it("says a difference is within the spread when the two sides' trials overlap", () => {
    const main = card("main", [{ caseId: "a", score: score({ f1: 0.7 }) }, { caseId: "a", score: score({ f1: 0.8 }) }]);
    const overlapping = card("change", [{ caseId: "a", score: score({ f1: 0.78 }) }, { caseId: "a", score: score({ f1: 0.86 }) }]);
    const apart = card("change", [{ caseId: "a", score: score({ f1: 0.9 }) }, { caseId: "a", score: score({ f1: 0.92 }) }]);
    expect(scorecardMarkdown([main, overlapping])).toContain("| Cut accuracy | 75% (70–80) | 82% (78–86) | +7 (within the spread) |");
    expect(scorecardMarkdown([main, apart])).toContain("| Cut accuracy | 75% (70–80) | 91% (90–92) | +16 |");
  });

  it("warns when there are too few passes or recordings to read much into it", () => {
    const md = scorecardMarkdown([card("main", [{ caseId: "a", score: score() }])]);
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

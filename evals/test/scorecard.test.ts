import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cutDetail, unmatchedInReference, type CutDetail } from "../src/cutDetail.ts";
import type { PacingSummary } from "../src/metrics.ts";
import { RUBRIC, type Score } from "../src/score.ts";
import {
  card, compareFigure, configSlug, EDITORIAL_IDS, eligibleTrials, factors as scoreFactors, FACTORS, ledgerPct, loadSide,
  mistakes as scoreMistakes, overallOf, rateScore, ratio, readTrial, scorecardMarkdown, standardError, WATCHABILITY_IDS,
} from "../src/scorecard.ts";

const pace = (o: { dead: number; joins: number; restarts?: number }): PacingSummary => ({
  words: 100, joins: o.joins, gaps: { inside: 0, atJoins: 0, long: 0, excessSeconds: o.dead }, medianJoinGapSeconds: null,
  repeats: { total: 0, singleWords: 0, phrases: 0, atJoins: 0 }, restarts: o.restarts ?? 0, silences: 0,
});

/** A scored pass on a recording whose editor left 10 s of dead air, 2 restarts and 50 cuts. The cut plays 20 minutes. */
function score(o: { missing?: number; clipped?: number; dead?: number; joins?: number; restarts?: number; spaces?: number[]; shared?: number; reference?: boolean; moments?: string[] } = {}): Score {
  const reference = o.reference ?? true;
  const cut = { words: { tp: 0, fp: 0, fn: 0, precision: 0.9, recall: 0.8, f1: 0.85, inScope: 100 }, requiredLines: { required: 50, missing: o.missing ?? 0 } };
  const matched = (o.spaces ?? [0, 50, 100, 250]).map(errorMs => ({ errorMs }));
  const view = { seconds: 1200, edges: { total: 100, clippedOnSound: o.clipped ?? 2 }, cut: reference ? cut : undefined,
    pacing: pace({ dead: o.dead ?? 10, joins: o.joins ?? 50, restarts: o.restarts ?? 2 }),
    sharedJoins: reference ? { matched, eligible: 40, shared: o.shared ?? 30, medianAbsErrorMs: 75 } : undefined,
    moments: o.moments?.map(outcome => ({ outcome })) };
  return {
    playable: { automatic: view, recommended: view },
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
    headline: { needsYourCall: 2, tokens: 3_000_000, activeMinutes: 6, finishMinutes: 8, costUsd: 0.034 },
  } as unknown as Score;
}

/** `left` are runs left in that the editor cut for another take of them; `content` are runs the editor dropped outright. */
const detail = (o: Partial<{ editor: number; scarlet: number; editorMatched: number; scarletMatched: number; wrong: number[]; left: number[]; content: number[]; short: number }> = {}): CutDetail => ({
  decisions: { editor: o.editor ?? 20, scarlet: o.scarlet ?? 20, editorMatched: o.editorMatched ?? 20, scarletMatched: o.scarletMatched ?? 20 },
  wronglyCut: (o.wrong ?? []).map(words => ({ start: 0, end: 1, words, text: "" })),
  leftIn: [...(o.left ?? []).map(words => ({ start: 0, end: 1, words, text: "", retake: true })), ...(o.content ?? []).map(words => ({ start: 0, end: 1, words, text: "", retake: false }))],
  pauses: { total: 100, editorTrimmed: 40, scarletTrimmed: 30, bothTrimmed: 20 },
  takes: { decided: 10, same: 8, other: 1, both: 1, neither: 0 },
  pieces: { total: 50, short: o.short ?? 0, editorTotal: 50, editorShort: 0 },
  unscored: 0,
});

function withDetail(input: Score, detail?: CutDetail): Score {
  return { ...input, playable: { automatic: input.playable.automatic, recommended: { ...input.playable.recommended, detail } } };
}
const factors = (input: Score, detail?: CutDetail) => scoreFactors(withDetail(input, detail));
const mistakes = (input: Score, detail: CutDetail) => scoreMistakes(withDetail(input, detail));

describe("ratio", () => {
  it("is the smaller amount over the larger, whichever side is over", () => {
    expect(ratio(10, 10)).toBe(100);
    expect(ratio(20, 10)).toBe(50);
    expect(ratio(5, 10)).toBe(50);
    expect(ratio(0, 0)).toBe(100);
  });
});

describe("rateScore", () => {
  it("scores 100 at zero defects, 50 at the half-life rate per 10 min, and 25 at twice the half-life", () => {
    expect(rateScore(0, 1200, 4)).toBe(100);
    expect(rateScore(8, 1200, 4)).toBe(50);
    expect(rateScore(16, 1200, 4)).toBe(25);
    expect(rateScore(2, 0, 4)).toBeNull();
  });
});

describe("factors", () => {
  it("reads Watchability by defect rate per 10 min and Editorial match on the editor's scale", () => {
    const f = factors(score(), detail());
    // Mid-word joins are counted under the card, not scored.
    expect(f).not.toHaveProperty("wholeWords");
    expect(f.noWrongCuts.pct).toBe(100);
    expect(f.noMissedRetakes.pct).toBe(100);
    expect(f.noStutter.pct).toBe(100);
    expect(f.cutDecisions.pct).toBe(100);
    expect(f.takeChoice.pct).toBe(80);
    expect(f.linesKept.pct).toBe(100);
    expect(f.sameCuts.pct).toBe(75);
    // The editor left 60 pauses alone and Scarlet trimmed 10 of them; of the 40 the editor trimmed, Scarlet trimmed 20.
    expect(f.pausesLeft.pct).toBeCloseTo(83.3, 1);
    expect(f.pausesTrimmed.pct).toBe(50);
    expect(f.deadAir.pct).toBe(100);
    expect(f.cutCount.pct).toBe(100);
    expect(f.spaceAtCut.pct).toBe(75);
    expect(f.nothingLeftIn.pct).toBe(100);
    expect(f.knownMoments.pct).toBeNull();
  });

  it("penalizes wrong cuts, retakes left in, and stutters steeply by rate per 10 min", () => {
    // On a 20 min cut: 6 wrong cuts = 3/10m (50%), 6 retakes left in = 3/10m (50%), 4 stutters = 2/10m (50%).
    // Short 2-5w leftIn runs and long content the editor dropped outright do not penalize noMissedRetakes.
    const f = factors(
      score({ clipped: 8 }),
      detail({ wrong: [1, 2, 2, 3, 4, 5, 6], left: [2, 3, 5, 6, 6, 7, 8, 9, 12], content: [20, 40], short: 4 }),
    );
    expect(f.noWrongCuts.pct).toBe(50);
    expect(f.noMissedRetakes.pct).toBe(50);
    expect(f.noStutter.pct).toBe(50);
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
    expect(noWords.noWrongCuts.pct).toBeNull();
    expect(noWords.noMissedRetakes.pct).toBeNull();
    expect(noWords.pausesTrimmed.pct).toBeNull();
    expect(noWords.linesKept.pct).toBe(100);
    const noVideo = factors(score({ reference: false }));
    expect(noVideo.deadAir.pct).toBeNull();
    expect(noVideo.noStutter.pct).toBeNull();
  });
});

describe("mistakes", () => {
  it("counts hard craft bugs separately from content the editor dropped and short 2–5 word tightenings left in", () => {
    const m = mistakes(score({ clipped: 4 }), detail({ wrong: [1, 2, 6], left: [1, 2, 5, 6, 12], content: [7], short: 1 }));
    // Craft mistakes: 2 retakes left in (>=6w) + 1 stutter = 3 in 20 min (1.5 / 10 min). 2 wrong cuts and 4 clipped are counted apart.
    // Taste: 1 content run, and 2 short tightenings (words 2 and 5) in 20 min (1 / 10 min). Total leftIn = 5.
    expect(m).toMatchObject({
      wronglyCut: 2, longMissed: 2, contentLeftIn: 1, clippedWords: 4, stutters: 1, total: 3, per10Min: 1.5,
      styleLeftIn: 2, stylePer10Min: 1, leftIn: 5,
    });
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

  it("marks the same words played from another saying as another take, not a line lost or left in", () => {
    // “it is a very good model. it is a very good model, for the price”: the editor plays the first saying, Scarlet the second.
    const said = "it is a very good model it is a very good model for the price".split(" ").map((text, i) => ({ text, start: i, end: i + 0.8 }));
    const all = [{ start: 0, end: 16 }];
    const d = cutDetail(said, all, [{ start: 6, end: 16 }], [{ start: 0, end: 6 }, { start: 12, end: 16 }]);
    expect(d.wronglyCut).toMatchObject([{ text: "it is a very good model", otherTake: true }]);
    expect(d.leftIn).toMatchObject([{ text: "it is a very good model", otherTake: true }]);
    expect(mistakes(score(), { ...detail(), wronglyCut: d.wronglyCut, leftIn: d.leftIn })).toMatchObject({ wronglyCut: 0, longMissed: 0, styleLeftIn: 0, otherTake: 2 });
  });

  it("still counts a line nobody says again, and a saying left in beside the editor's", () => {
    // Scarlet cuts “legal work nineteen percent”, said once; and plays both sayings of “we can compare them”.
    const said = "it dominated legal work nineteen percent then we can compare them we can compare them".split(" ").map((text, i) => ({ text, start: i, end: i + 0.8 }));
    const all = [{ start: 0, end: 15 }];
    const d = cutDetail(said, all, [{ start: 0, end: 2 }, { start: 6, end: 15 }], [{ start: 0, end: 11 }]);
    expect(d.wronglyCut).toEqual([expect.objectContaining({ text: "legal work nineteen percent" })]);
    expect(d.wronglyCut[0]!.otherTake).toBeUndefined();
    expect(d.leftIn).toEqual([expect.objectContaining({ text: "we can compare them" })]);
    expect(d.leftIn[0]!.otherTake).toBeUndefined();
  });

  it("finds a word doubled at one of Scarlet's joins, and half a sentence left before one, unless the editor joins the same words", () => {
    const said = (text: string) => text.split(" ").map((t, i) => ({ text: t, start: i, end: i + 0.8 }));
    // “a model. with prompting, without guidance”: Scarlet joins “with” to “without”.
    const doubledWords = said("a model. With prompting, without specific guidance on time.");
    const all = [{ start: 0, end: 9 }];
    const doubled = cutDetail(doubledWords, all, [{ start: 0, end: 3 }, { start: 4, end: 9 }], all);
    expect(doubled.joins!.doubled.map(j => j.text)).toEqual(["a model. With ‖ without specific guidance on"]);
    expect(cutDetail(doubledWords, all, [{ start: 0, end: 3 }, { start: 4, end: 9 }], [{ start: 0, end: 3 }, { start: 4, end: 9 }]).joins!.doubled).toEqual([]);
    // “It just isn't ‖ It's not easy at all.”: Scarlet keeps three words of a sentence, then the next one starts.
    const halfWords = said("That is easy. It just isn't so. It's not easy at all.");
    const half = cutDetail(halfWords, [{ start: 0, end: 12 }], [{ start: 0, end: 6 }, { start: 7, end: 12 }], [{ start: 0, end: 12 }]);
    expect(half.joins!.halfSentence.map(j => j.text)).toEqual(["easy. It just isn't ‖ It's not easy at"]);
  });

  it("counts a piece under a second between two cuts as a stutter", () => {
    const d = cutDetail(words, base, [{ start: 0, end: 2 }, { start: 3, end: 3.8 }, { start: 5, end: 8 }], base);
    expect(d.pieces).toMatchObject({ total: 3, short: 1, editorTotal: 1, editorShort: 0 });
  });

  // A take the editor dropped for a later one, then a passage the editor cut outright, at one word a second.
  const said = (text: string, from = 0) => text.split(" ").map((t, i) => ({ text: t, start: from + i, end: from + i + 0.8 }));
  const take = [...said("I want to show you the new model", 0), ...said("I want to show you the new model today", 10),
    ...said("thanks to our sponsor for this video who makes great things", 30), ...said("and that is it", 50)];
  const all = [{ start: 0, end: 60 }];

  it("calls a long run left in a retake when the editor kept another delivery of it nearby, and content otherwise", () => {
    const editor = [{ start: 10, end: 19 }, { start: 50, end: 54 }];
    const d = cutDetail(take, all, all, editor);
    expect(d.leftIn.map(x => [x.text.split(" ")[0], x.words, x.retake])).toEqual([["I", 8, true], ["thanks", 11, false]]);
  });

  it("calls it a swap of takes, not a retake, when Scarlet kept the first delivery and cut the editor's", () => {
    const editor = [{ start: 10, end: 19 }, { start: 50, end: 54 }];
    const scarlet = [{ start: 0, end: 9 }, { start: 30, end: 60 }];
    const d = cutDetail(take, all, scarlet, editor);
    const first = d.leftIn.find(x => x.text.startsWith("I want"))!;
    expect([first.retake, first.otherTake]).toEqual([false, true]);
  });

  it("leaves a retake Scarlet asked the editor about for their call, not a silent miss", () => {
    const stammer = said("but really it is quite but really it is quite but really it is quite comparable", 0);
    const d = cutDetail(stammer, all, all, [{ start: 12, end: 16 }], { asked: [{ start: 2, end: 4 }] });
    expect(d.leftIn.map(x => [x.retake, x.asked])).toEqual([[true, true]]);
    const m = mistakes(score(), { ...detail(), leftIn: d.leftIn });
    expect(m).toMatchObject({ longMissed: 0, askedRetakes: 1 });
    expect(factors(score(), { ...detail(), leftIn: d.leftIn }).noMissedRetakes.pct).toBe(100);
  });

  it("calls a line restarted over and over a retake though the editor's kept delivery is short", () => {
    const stammer = said("but really it is quite but really it is quite but really it is quite comparable", 0);
    const d = cutDetail(stammer, all, all, [{ start: 12, end: 16 }]);
    expect(d.leftIn.map(x => [x.words, x.retake])).toEqual([[12, true]]);
  });

  it("leaves unscored the words the published video plays where its matcher found no recording", () => {
    const editor = [{ start: 10, end: 19 }, { start: 50, end: 54 }];
    // The published video plays the sponsor read, but the matcher tied it to no recording.
    const unscored = unmatchedInReference(take, editor, [["Thanks", "to", "our", "sponsor", "for", "this", "video"]]);
    expect(unscored).toEqual([{ start: 30, end: 36.8 }]);
    const d = cutDetail(take, all, all, editor, { unscored });
    expect(d.unscored).toBe(7);
    expect(d.leftIn.map(x => x.text)).toEqual(["I want to show you the new model", "who makes great things"]);
    // A passage under five words, or one the editor's cut keeps, is scored as before.
    expect(unmatchedInReference(take, editor, [["thanks", "to", "our", "sponsor"]])).toEqual([]);
    expect(unmatchedInReference(take, editor, [["show", "you", "the", "new", "model", "today"]])).toEqual([]);
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
    expect(c.facts.finishMinutes!.mean).toBe(8);
    expect(c.facts.cents!.mean).toBe(3.4);
    expect(c.mistakesPer10Min).toBeNull();
    expect(c.stylePer10Min).toBeNull();
  });

  it("combines Watchability and Editorial match as a geometric mean and compares two sides only on common factors", () => {
    const withMoments = card("change", [{ caseId: "a", score: withDetail(score({ moments: ["wrong"] }), detail()) }]);
    const without = card("main", [{ caseId: "a", score: withDetail(score(), detail()) }]);
    const common = FACTORS.map(f => f.id).filter(id => id !== "knownMoments");
    expect(without.watchability).toBe(overallOf(without.factors, WATCHABILITY_IDS));
    expect(without.editorial).toBe(overallOf(without.factors, EDITORIAL_IDS));
    expect(without.overall).toBe(Math.round(Math.sqrt(without.watchability! * without.editorial!) * 10) / 10);
    expect(overallOf(withMoments.factors, common)).toBe(overallOf(without.factors, common));
    expect(withMoments.overall).toBeLessThan(without.overall!);
    expect(scorecardMarkdown([without, withMoments])).toContain("geometric mean of Watchability (2) and Editorial match (11)");
  });
});

describe("standardError", () => {
  const st = (values: number[]) => {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return { mean, min: Math.min(...values), max: Math.max(...values), n: values.length,
      ...(values.length > 1 && { variance: values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1) }) };
  };

  it("pools how much passes of one recording disagree, and shrinks with more passes and more recordings", () => {
    // Two recordings, passes 2 apart on each: variance 2, so one recording of 2 passes has SE 1; two have SE 1/√2.
    expect(standardError([st([10, 12])])).toBeCloseTo(1, 6);
    expect(standardError([st([10, 12]), st([50, 52])])).toBeCloseTo(Math.SQRT1_2, 6);
    // A recording with one pass borrows the spread the others measured.
    expect(standardError([st([10]), st([50, 52])])).toBeCloseTo(Math.sqrt(2 / 1 + 2 / 2) / 2, 6);
    expect(standardError([st([10]), st([50])])).toBeNull();
  });

  it("calls a change real only when it is more than its ±, and says on how many recordings it went that way", () => {
    const a = { x: st([60, 62]), y: st([70, 72]), z: st([80, 82]) };
    const up = { x: st([70, 72]), y: st([80, 82]), z: st([84, 86]) };
    expect(compareFigure(a, up, 8)).toMatchObject({ real: true, text: "**+8** (±1.6, better) · up on 3 of 3 recordings" });
    const near = { x: st([61, 63]), y: st([69, 71]), z: st([81, 83]) };
    expect(compareFigure(a, near, 0.3)).toMatchObject({ real: false, text: "+0.3 (±1.6, could be luck) · up on 2 of 3 recordings" });
    // Fewer is better for counts.
    expect(compareFigure(a, up, 8, true).text).toContain("worse");
  });
});

describe("scorecardMarkdown", () => {
  it("puts a ± on every figure and marks a change inside it as luck", () => {
    const side = (label: string, missing: number[]) => card(label, missing.map(m => ({ caseId: "a", score: score({ missing: m }) })));
    const main = side("main", [15, 10]);
    // Passes of 70% and 80% on the one recording: SE 5, so ±10. Compared, both sides' passes give the spread.
    expect(scorecardMarkdown([main, side("change", [11, 7])])).toContain("| Lines kept | 75% ±10 | 82% ±8 | +7 (±12.8, could be luck) |");
    expect(scorecardMarkdown([main, side("change", [5, 4])])).toContain("| Lines kept | 75% ±10 | 91% ±2 | **+16** (±10.2, better) |");
  });

  it("splits hard craft mistakes from short editorial tightenings and warns on small sample sizes", () => {
    const md = scorecardMarkdown([card("main", [{ caseId: "a", score: withDetail(score(), detail({ wrong: [3], left: [2, 4, 8] })) }])]);
    // Craft mistakes: 1 retake left in (8w) + 0 stutters = 1 in 20 min -> 0.5/10 min; the wrong cut and 2 clipped are counted apart.
    // Short tightenings: 2 (words 2, 4) in 20 min -> 1/10 min.
    expect(md).toContain("| **Watchability** |");
    expect(md).toContain("| **Editorial match** |");
    expect(md).toContain("| **Craft mistakes per 10 finished min** | 0.5 |");
    expect(md).toContain("| *Checked by ear next:* words a cut lands inside | 2 |");
    expect(md).toContain("| Retake left in | 1 |");
    expect(md).toContain("| Content the editor cut, left in | 0 |");
    expect(md).toContain("| Short tightenings left in (per 10 min) | 1 |");
    expect(md).toContain("| Short tightenings left in | 2 |");
    expect(md).toContain("No ± where a side has one pass on each recording");
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

describe("scorecard guards and eligibility", () => {
  const mkEval = (o: { taskId: string; caseId?: string; config?: { agent?: string; model?: string; effort?: string }; state?: string; rubric?: string; gradingSha256?: string }) => ({
    schema: 1, kind: "task", generatedAt: "2026-11-19T00:00:00Z",
    taskId: o.taskId, projectId: "prj_1", caseId: o.caseId ?? "ep1",
    config: o.config ?? { agent: "gemini", model: "gemini-4-neon", effort: "medium" },
    instruction: "cut", gradingSha256: o.gradingSha256 ?? "sha-a",
    score: {
      ...withDetail(score(), detail()),
      rubric: o.rubric ?? RUBRIC,
      trace: { state: o.state ?? "done" },
    },
  });

  const withTmpRun = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "scarlet-scorecard-test-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it("reads only manifest-eligible completed trials and ignores errored or failed rows", () => withTmpRun(dir => {
    const cfg = "gemini:gemini-4-neon:medium";
    const okPath = join(dir, "ep1", configSlug(cfg), "trial-1", "evaluation.json");
    const errPath = join(dir, "ep1", configSlug(cfg), "trial-2", "evaluation.json");
    mkdirSync(join(dir, "ep1", configSlug(cfg), "trial-1"), { recursive: true });
    mkdirSync(join(dir, "ep1", configSlug(cfg), "trial-2"), { recursive: true });
    writeFileSync(okPath, JSON.stringify(mkEval({ taskId: "tsk_ok" })));
    writeFileSync(errPath, JSON.stringify(mkEval({ taskId: "tsk_bad" })));
    writeFileSync(join(dir, "trials.json"), JSON.stringify([
      { caseId: "ep1", config: cfg, trial: 1, state: "done", taskId: "tsk_ok", headline: { activeMinutes: 6 } },
      { caseId: "ep1", config: cfg, trial: 2, state: "done", taskId: "tsk_bad", headline: { activeMinutes: 6 }, error: "transcript mismatch" },
      { caseId: "ep1", config: cfg, trial: 3, state: "failed", taskId: "tsk_fail" },
    ]));
    expect(eligibleTrials(dir)).toHaveLength(1);
    const loaded = loadSide("gemini", dir);
    expect(loaded.card.trials).toBe(1);
    expect(loaded.card.gradingByCase).toEqual({ ep1: "sha-a" });
  }));

  it("accepts colon-containing model names and serviceTier suffixes in manifest config checks", () => withTmpRun(dir => {
    const cfg = "ollama:qwen3:8b:medium:priority";
    const file = join(dir, "evaluation.json");
    writeFileSync(file, JSON.stringify(mkEval({ taskId: "tsk_1", config: { agent: "ollama", model: "qwen3:8b", effort: "medium" } })));
    expect(readTrial(file, { caseId: "ep1", config: cfg, trial: 1, state: "done", taskId: "tsk_1", headline: {} }).taskId).toBe("tsk_1");
    expect(() => readTrial(file, { caseId: "ep1", config: "ollama:qwen3:8b:high", trial: 1, state: "done", taskId: "tsk_1", headline: {} })).toThrow(/manifest/);
  }));

  it("rejects stale rubrics, non-done trials, missing trials.json dirs, and multi-config dirs", () => withTmpRun(dir => {
    const stale = join(dir, "stale.json");
    writeFileSync(stale, JSON.stringify(mkEval({ taskId: "tsk_old", rubric: "old-v1" })));
    expect(() => readTrial(stale)).toThrow(/regrade/);

    const unfinished = join(dir, "running.json");
    writeFileSync(unfinished, JSON.stringify(mkEval({ taskId: "tsk_run", state: "running" })));
    expect(() => readTrial(unfinished)).toThrow(/regrade/);

    expect(() => loadSide("empty", dir)).toThrow(/trials\.json/);
    expect(() => loadSide("missing", join(dir, "does-not-exist"))).toThrow(/No such file or folder/);

    for (const [cfg, tid] of [["codex:m:medium", "tsk_c"], ["gemini:g:medium", "tsk_g"]] as const) {
      const p = join(dir, "ep1", configSlug(cfg), "trial-1");
      mkdirSync(p, { recursive: true });
      const [agent, model, effort] = cfg.split(":");
      writeFileSync(join(p, "evaluation.json"), JSON.stringify(mkEval({ taskId: tid, config: { agent, model, effort } })));
    }
    writeFileSync(join(dir, "trials.json"), JSON.stringify([
      { caseId: "ep1", config: "codex:m:medium", trial: 1, state: "done", taskId: "tsk_c", headline: {} },
      { caseId: "ep1", config: "gemini:g:medium", trial: 1, state: "done", taskId: "tsk_g", headline: {} },
    ]));
    expect(() => loadSide("mixed", dir)).toThrow(/one configuration per side/);
    expect(loadSide("codex", join(dir, "ep1", configSlug("codex:m:medium"))).card.trials).toBe(1);
  }));

  it("rejects comparing mismatched points, recordings, or frozen grading hashes and withholds incomplete overall", () => {
    const s = withDetail(score(), detail());
    const a = card("a", [{ caseId: "ep1", gradingSha256: "sha-1", score: s }], "recommended");
    const bAuto = card("b", [{ caseId: "ep1", gradingSha256: "sha-1", score: s }], "automatic");
    const bCase = card("b", [{ caseId: "ep2", gradingSha256: "sha-1", score: s }], "recommended");
    const bHash = card("b", [{ caseId: "ep1", gradingSha256: "sha-2", score: s }], "recommended");

    expect(() => scorecardMarkdown([a, bAuto])).toThrow(/operating point/);
    expect(() => scorecardMarkdown([a, bCase])).toThrow(/recordings/);
    expect(() => scorecardMarkdown([a, bHash])).toThrow(/different frozen inputs/);
    expect(() => card("mixed", [
      { caseId: "ep1", gradingSha256: "sha-1", score: s },
      { caseId: "ep1", gradingSha256: "sha-2", score: s },
    ])).toThrow(/different frozen inputs/);

    // Without published reference detail, Watchability lacks 3 of 4 factors, so Overall is withheld.
    const noRef = card("no-ref", [{ caseId: "ep1", score: score({ reference: false }) }]);
    expect(noRef.overall).toBeNull();
    expect(scorecardMarkdown([noRef])).toContain("| **Overall** | – |");
  });
});

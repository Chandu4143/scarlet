/**
 * The dialogue scorecard: one scored run, or several, boiled down to a percentage for each thing a dialogue cut has
 * to get right, and one overall figure. Every figure is read from what run.ts already measured against the editor's
 * published video (evaluation.json), so a scorecard costs nothing to make: only the passes it reads cost tokens.
 *
 *   tsx evals/src/scorecard.ts <run dir | evaluation.json> [<another>] [--labels main,change] [--ledger] [--json]
 *
 * Each path is one side of a comparison: every evaluation.json under it is a trial. A side's figure for a recording is
 * the mean of its trials, and its figure overall is the mean over recordings, so a long video counts once.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { cli, isMain, list, main } from "./args.ts";
import type { Evaluation } from "./evaluate.ts";
import { loadCase } from "./case.ts";
import { addCutDetails, cutDetail, LONG_MISSED_WORDS, NOTICED_WORDS, STUTTER_SECONDS, type CutDetail } from "./cutDetail.ts";
import { merge } from "./intervals.ts";
import { loadBoard, loadLedger, runChecks, type Verdict } from "./ledger.ts";
import type { PacingSummary, Word } from "./metrics.ts";
import { readJson } from "./paths.ts";
import type { Score } from "./score.ts";

const USAGE = `Usage:
  tsx evals/src/scorecard.ts <run dir | evaluation.json> [<another> ...] [--labels a,b] [--ledger] [--json]

Each path is one side: all the scored trials under it. Two sides are compared factor by factor.
--ledger also runs the free ledger checks on this checkout and adds their pass rate (about a minute, no model tokens).`;

export type FactorGroup = "watchability" | "editorial";

export type FactorId = "wholeWords" | "noWrongCuts" | "noLongMisses" | "noStutter"
  | "cutDecisions" | "takeChoice" | "linesKept" | "sameCuts" | "pausesLeft" | "pausesTrimmed" | "deadAir"
  | "cutCount" | "spaceAtCut" | "nothingLeftIn" | "knownMoments";

export interface Factor {
  id: FactorId;
  group: FactorGroup;
  label: string;
  /** What 100% means, in a sentence the editor can read. */
  means: string;
}

/**
 * Defect rates per 10 minutes of kept cut at which each Watchability factor drops to 50% (`100 * 0.5^(rate / halfLife)`).
 * Scoring craft defects by rate instead of dividing by hundreds of cut edges keeps 15 clipped words from reading as 95%.
 */
export const RATE_HALF_LIFE = {
  wholeWords: 4,
  noWrongCuts: 3,
  noLongMisses: 3,
  noStutter: 2,
} as const;

/**
 * Every factor is 0–100 and higher is better. Watchability factors penalize viewer-audible craft bugs by rate per
 * 10 minutes of cut; Editorial match factors measure alignment on the scale of the editor's own cut, never of the
 * raw recording (two passes that left three times the editor's dead air scored 98% against the recording, 2026-11-18).
 */
export const FACTORS: readonly Factor[] = [
  { id: "wholeWords", group: "watchability", label: "No mid-word cuts", means: `no join cuts into a sounding word (50% at ${RATE_HALF_LIFE.wholeWords}/10 min)` },
  { id: "noWrongCuts", group: "watchability", label: "No wrong cuts", means: `no run of ${NOTICED_WORDS}+ words cut that the editor kept (50% at ${RATE_HALF_LIFE.noWrongCuts}/10 min)` },
  { id: "noLongMisses", group: "watchability", label: "No long misses", means: `no run of ${LONG_MISSED_WORDS}+ words left in that the editor cut (50% at ${RATE_HALF_LIFE.noLongMisses}/10 min)` },
  { id: "noStutter", group: "watchability", label: "No stutter cuts", means: `no piece under ${STUTTER_SECONDS} s between two cuts (50% at ${RATE_HALF_LIFE.noStutter}/10 min)` },
  { id: "cutDecisions", group: "editorial", label: "Cut decisions", means: "every removal the editor made, Scarlet made, and no others; a removal counts once, long or short" },
  { id: "takeChoice", group: "editorial", label: "Take choice", means: "where a line was said twice, Scarlet kept the take the editor kept, and only that one" },
  { id: "linesKept", group: "editorial", label: "Lines kept", means: "every sentence the editor kept is still in" },
  { id: "sameCuts", group: "editorial", label: "Same cuts", means: "every cut of the editor's that can be told apart, Scarlet made between the same two words" },
  { id: "pausesLeft", group: "editorial", label: "Pauses left alone", means: "every pause the editor left as it was said, Scarlet left too" },
  { id: "pausesTrimmed", group: "editorial", label: "Pauses trimmed", means: "every pause the editor shortened, Scarlet shortened too" },
  { id: "deadAir", group: "editorial", label: "Dead air", means: "as much dead air left as the editor left" },
  { id: "cutCount", group: "editorial", label: "Cut count", means: "as many cuts as the editor made" },
  { id: "spaceAtCut", group: "editorial", label: "Space at a cut", means: "at cuts both made, the pause is within 0.1 s of the editor's" },
  { id: "nothingLeftIn", group: "editorial", label: "No restarts left in", means: "no more restarts or doubled words play than in the editor's cut" },
  { id: "knownMoments", group: "editorial", label: "Known mistakes", means: "every spot that went wrong before comes out right, or is asked about" },
];

export const WATCHABILITY_IDS: readonly FactorId[] = FACTORS.filter(f => f.group === "watchability").map(f => f.id);
export const EDITORIAL_IDS: readonly FactorId[] = FACTORS.filter(f => f.group === "editorial").map(f => f.id);

export interface FactorValue { pct: number | null; detail: string }
export type Factors = Record<FactorId, FactorValue>;

/** A pause at a cut within this of the editor's is the same pause: three frames. */
export const SAME_SPACE_MS = 100;

const clamp = (v: number) => Math.max(0, Math.min(100, v));
const r1 = (v: number) => Math.round(v * 10) / 10;
const none = (detail: string): FactorValue => ({ pct: null, detail });
const pctOf = (n: number, d: number) => r1(100 * n / d);
const keptSecondsOf = (score: Score) => Object.values(score.left?.kept ?? {}).flat().reduce((a, r) => a + r.end - r.start, 0);

/** How close two amounts are, as the smaller over the larger: 100 when equal, 50 when one is twice the other, either way round. */
export function ratio(candidate: number, reference: number): number {
  const hi = Math.max(candidate, reference);
  return hi <= 0 ? 100 : clamp(100 * Math.min(candidate, reference) / hi);
}

/**
 * Rate-based craft score: 100 at zero defects, 50 at `halfLifePer10Min` defects per 10 minutes of kept cut,
 * decaying smoothly toward 0 as defects pile up. Returns null when kept duration is zero.
 */
export function rateScore(count: number, keptSeconds: number, halfLifePer10Min: number): number | null {
  if (keptSeconds <= 0 || halfLifePer10Min <= 0) return null;
  const per10 = Math.max(0, count) / (keptSeconds / 600);
  return r1(clamp(100 * Math.pow(0.5, per10 / halfLifePer10Min)));
}

/**
 * The factors of one scored run, read at what the editor gets by accepting Scarlet's own picks on every staged cut.
 * `detail` is the cut read decision by decision against the published video (cutDetail.ts); without the case's words
 * the factors that need it have no figure.
 */
export function factors(score: Score, detail?: CutDetail): Factors {
  const point = score.reference?.operatingPoints.recommended.cut ?? score.reference?.operatingPoints.applied.cut;
  const p = score.pacing, ref = p.reference, left: PacingSummary = p.recommended ?? p.final ?? p.applied;
  const noReference = none("no published video for this recording");
  const noDetail = ref ? none("the case's words aren't here to read the cut by") : noReference;
  const seconds = keptSecondsOf(score);
  const per10 = (n: number) => seconds > 0 ? r1(n / (seconds / 600)) : null;

  const edges = score.applied.edges.total + (score.review?.edges.total ?? 0);
  const clipped = score.applied.edges.clippedOnSound + (score.review?.edges.clippedOnSound ?? 0);
  const wholeWords: FactorValue = !edges ? none("no cuts")
    : seconds > 0
      ? { pct: rateScore(clipped, seconds, RATE_HALF_LIFE.wholeWords), detail: `${clipped} of ${edges} cut edges land inside a sounding word (${per10(clipped)}/10 min)` }
      : { pct: pctOf(edges - clipped, edges), detail: `${clipped} of ${edges} cut edges land inside a sounding word` };

  const wrongRuns = detail ? detail.wronglyCut.filter(x => x.words >= NOTICED_WORDS).length : null;
  const noWrongCuts: FactorValue = !detail ? noDetail
    : seconds <= 0 ? none("kept duration not recorded")
      : { pct: rateScore(wrongRuns!, seconds, RATE_HALF_LIFE.noWrongCuts), detail: `${wrongRuns} runs of ${NOTICED_WORDS}+ words cut that the editor kept (${per10(wrongRuns!)}/10 min)` };

  const longMissRuns = detail ? detail.leftIn.filter(x => x.words >= LONG_MISSED_WORDS).length : null;
  const noLongMisses: FactorValue = !detail ? noDetail
    : seconds <= 0 ? none("kept duration not recorded")
      : { pct: rateScore(longMissRuns!, seconds, RATE_HALF_LIFE.noLongMisses), detail: `${longMissRuns} runs of ${LONG_MISSED_WORDS}+ words left in that the editor cut (${per10(longMissRuns!)}/10 min)` };

  const pc = detail?.pieces;
  const noStutter: FactorValue = !pc ? noDetail : !pc.total ? none("no cuts")
    : seconds > 0
      ? { pct: rateScore(pc.short, seconds, RATE_HALF_LIFE.noStutter), detail: `${pc.short} of ${pc.total} pieces play for under ${STUTTER_SECONDS} s (${per10(pc.short)}/10 min; editor's cut: ${pc.editorShort} of ${pc.editorTotal})` }
      : { pct: pctOf(pc.total - pc.short, pc.total), detail: `${pc.short} of ${pc.total} pieces play for under ${STUTTER_SECONDS} s (the editor's cut: ${pc.editorShort} of ${pc.editorTotal})` };

  const words = point?.words;
  const d = detail?.decisions;
  let cutDecisions = noDetail;
  if (d && d.editor + d.scarlet > 0) {
    const precision = d.scarlet ? d.scarletMatched / d.scarlet : 0, recall = d.editor ? d.editorMatched / d.editor : 0;
    cutDecisions = {
      pct: r1(precision + recall ? 100 * 2 * precision * recall / (precision + recall) : 0),
      detail: `Scarlet made ${d.editorMatched} of the editor's ${d.editor} removals; ${d.scarletMatched} of Scarlet's ${d.scarlet} the editor made too` +
        (words?.f1 != null ? ` (by words, which flatters: ${Math.round(100 * words.f1)}%)` : ""),
    };
  }

  const t = detail?.takes;
  const takeChoice: FactorValue = !detail ? noDetail : !t!.decided ? none("no line said twice that the editor kept one take of")
    : { pct: pctOf(t!.same, t!.decided), detail: `${t!.same} of ${t!.decided} the same take; ${t!.both} with both left in, ${t!.other} the other take, ${t!.neither} with neither` };

  const lines = point?.requiredLines;
  const linesKept: FactorValue = !lines?.required ? noReference
    : { pct: pctOf(lines.required - lines.missing, lines.required), detail: `${lines.missing} of ${lines.required} lines the editor kept are cut` };

  const shared = p.sharedJoins?.applied;
  const sameCuts: FactorValue = !shared?.eligible ? noReference
    : { pct: pctOf(shared.shared, shared.eligible), detail: `${shared.shared} of the editor's ${shared.eligible} cuts that can be told apart` };

  const ps = detail?.pauses;
  const editorLeft = ps ? ps.total - ps.editorTrimmed : 0, overTrimmed = ps ? ps.scarletTrimmed - ps.bothTrimmed : 0;
  const pausesLeft: FactorValue = !ps ? noDetail : !editorLeft ? none("the editor left no pause as it was said")
    : { pct: pctOf(editorLeft - overTrimmed, editorLeft), detail: `Scarlet trimmed ${overTrimmed} of the ${editorLeft} pauses the editor left alone` };
  const pausesTrimmed: FactorValue = !ps ? noDetail : !ps.editorTrimmed ? none("the editor trimmed no pause")
    : { pct: pctOf(ps.bothTrimmed, ps.editorTrimmed), detail: `Scarlet trimmed ${ps.bothTrimmed} of the ${ps.editorTrimmed} pauses the editor trimmed` };

  const deadAir: FactorValue = !ref ? noReference : {
    pct: r1(ratio(left.gaps.excessSeconds, ref.gaps.excessSeconds)),
    detail: `${left.gaps.excessSeconds} s left, the editor left ${ref.gaps.excessSeconds} s`,
  };

  const cutCount: FactorValue = !ref?.joins ? noReference
    : { pct: r1(ratio(left.joins, ref.joins)), detail: `${left.joins} cuts, the editor made ${ref.joins}` };

  const within = shared?.matched.filter(m => Math.abs(m.errorMs) <= SAME_SPACE_MS).length ?? 0;
  const spaceAtCut: FactorValue = !shared?.matched.length ? none(ref ? "no cut in the same place as one of the editor's" : noReference.detail)
    : { pct: pctOf(within, shared.matched.length), detail: `${within} of ${shared.matched.length} cuts both made, median ${shared.medianAbsErrorMs} ms off` };

  const restartCount = (s: PacingSummary) => s.restarts + s.repeats.total;
  const allowed = ref ? restartCount(ref) : 0;
  // One more than the editor's cut plays counts against the editor's own figure, not the recording's.
  const nothingLeftIn: FactorValue = {
    pct: r1(clamp(100 * (allowed + 1) / (Math.max(restartCount(left), allowed) + 1))),
    detail: `${restartCount(left)} restarts and doubled words play${ref ? `, the editor's cut plays ${allowed}` : ""}`,
  };

  const moments = score.moments ?? [];
  const ok = moments.filter(m => m.outcome !== "wrong").length;
  const knownMoments: FactorValue = !moments.length ? none("no known spots in this recording")
    : { pct: pctOf(ok, moments.length), detail: `${ok} of ${moments.length} right or asked` };

  return {
    wholeWords, noWrongCuts, noLongMisses, noStutter,
    cutDecisions, takeChoice, linesKept, sameCuts, pausesLeft, pausesTrimmed, deadAir, cutCount, spaceAtCut, nothingLeftIn, knownMoments,
  };
}

/**
 * Hard viewer-audible mistakes counted across the cut and per 10 minutes, plus short 2–5 word editorial
 * tightenings left in (reported separately so taste diffs don't inflate bug counts).
 */
export interface Mistakes {
  wronglyCut: number;
  longMissed: number;
  clippedWords: number;
  stutters: number;
  /** Objective craft bugs: wronglyCut + longMissed + clippedWords + stutters. */
  total: number;
  per10Min: number | null;
  /** Short runs (NOTICED_WORDS .. LONG_MISSED_WORDS - 1) Scarlet left in that the editor trimmed. */
  styleLeftIn: number;
  stylePer10Min: number | null;
  /** All left-in runs of NOTICED_WORDS+ words (longMissed + styleLeftIn). */
  leftIn: number;
}

/**
 * Hard bugs are: a run of 2+ words Scarlet cut that the editor kept, a long passage (6+ words) Scarlet left in that
 * the editor cut, a sounding word a join cuts into, and a stutter piece under 1 s. Short 2–5 word phrases the editor
 * trimmed ("kind of", "And so") are tracked separately as editorial tightenings, and single-word edge drift is ignored.
 */
export function mistakes(score: Score, detail: CutDetail): Mistakes {
  const wronglyCut = detail.wronglyCut.filter(x => x.words >= NOTICED_WORDS).length;
  const longMissed = detail.leftIn.filter(x => x.words >= LONG_MISSED_WORDS).length;
  const styleLeftIn = detail.leftIn.filter(x => x.words >= NOTICED_WORDS && x.words < LONG_MISSED_WORDS).length;
  const clippedWords = score.applied.edges.clippedOnSound + (score.review?.edges.clippedOnSound ?? 0);
  const stutters = detail.pieces.short;
  const total = wronglyCut + longMissed + clippedWords + stutters;
  const seconds = keptSecondsOf(score);
  return {
    wronglyCut,
    longMissed,
    clippedWords,
    stutters,
    total,
    per10Min: seconds > 0 ? r1(total / (seconds / 600)) : null,
    styleLeftIn,
    stylePer10Min: seconds > 0 ? r1(styleLeftIn / (seconds / 600)) : null,
    leftIn: longMissed + styleLeftIn,
  };
}

export interface Stat { mean: number; min: number; max: number; n: number }
export interface Card {
  label: string;
  trials: number;
  cases: string[];
  factors: Record<FactorId, Stat | null>;
  /** Mean of the rate-based Watchability (craft) factors this side has. */
  watchability: number | null;
  /** Mean of the Editorial match factors this side has. */
  editorial: number | null;
  /** Geometric mean of Watchability and Editorial match (compare two sides on `overallOf` over common factors). */
  overall: number | null;
  /** Hard craft mistakes in every ten minutes of the cut: lower is better. */
  mistakesPer10Min: Stat | null;
  /** Short 2–5 word editorial tightenings left in per ten minutes: reported separately from hard bugs. */
  stylePer10Min: Stat | null;
  mistakeCounts: Record<"wronglyCut" | "longMissed" | "clippedWords" | "stutters" | "styleLeftIn" | "leftIn", Stat | null>;
  byCase: Record<string, Record<FactorId, Stat | null>>;
  /** Not scored: for the editor's eye. */
  facts: { asks: Stat | null; tokens: Stat | null; minutes: Stat | null; finishMinutes: Stat | null; cents: Stat | null };
}
export interface Trial { caseId?: string; score: Score; detail?: CutDetail }

const stat = (values: number[]): Stat | null => values.length
  ? { mean: r1(values.reduce((a, b) => a + b, 0) / values.length), min: Math.min(...values), max: Math.max(...values), n: values.length } : null;
const numbers = (values: Array<number | null | undefined>) => values.filter((v): v is number => typeof v === "number");
/** Recordings count equally; the spread is over every trial. */
const acrossCases = (perCase: Array<Stat | null>): Stat | null => {
  const have = perCase.filter((s): s is Stat => !!s);
  return have.length ? { mean: r1(have.reduce((a, s) => a + s.mean, 0) / have.length), min: Math.min(...have.map(s => s.min)),
    max: Math.max(...have.map(s => s.max)), n: have.reduce((a, s) => a + s.n, 0) } : null;
};

/** One side's card from its scored trials. A trial with no reference still counts toward the factors that need none. */
export function card(label: string, trials: readonly Trial[]): Card {
  const groups = new Map<string, Trial[]>();
  for (const t of trials) groups.set(t.caseId ?? "(no case)", [...(groups.get(t.caseId ?? "(no case)") ?? []), t]);
  const byCase: Card["byCase"] = {};
  const mistakesByCase: Array<Record<keyof Mistakes, Stat | null>> = [];
  for (const [id, ts] of groups) {
    const fs = ts.map(t => factors(t.score, t.detail));
    byCase[id] = Object.fromEntries(FACTORS.map(f => [f.id, stat(numbers(fs.map(x => x[f.id].pct)))])) as Record<FactorId, Stat | null>;
    const ms = ts.flatMap(t => t.detail ? [mistakes(t.score, t.detail)] : []);
    mistakesByCase.push(Object.fromEntries((["wronglyCut", "longMissed", "clippedWords", "stutters", "total", "per10Min", "styleLeftIn", "stylePer10Min", "leftIn"] as const)
      .map(k => [k, stat(numbers(ms.map(m => m[k])))])) as Record<keyof Mistakes, Stat | null>);
  }
  const all = Object.fromEntries(FACTORS.map(f => [f.id, acrossCases(Object.values(byCase).map(c => c[f.id]))])) as Record<FactorId, Stat | null>;
  const headline = (k: string) => stat(numbers(trials.map(t => t.score.headline[k])));
  // What reached the editor to decide or check: calls, and applied edits the pass flagged.
  const asks = () => stat(numbers(trials.map(t => {
    const calls = t.score.headline.needsYourCall, flags = t.score.headline.flaggedForYou;
    return calls == null && flags == null ? null : (calls ?? 0) + (flags ?? 0);
  })));
  const count = (k: keyof Mistakes) => acrossCases(mistakesByCase.map(m => m[k]));
  const watchability = meanOf(all, WATCHABILITY_IDS);
  const editorial = meanOf(all, EDITORIAL_IDS);
  return {
    label,
    trials: trials.length,
    cases: [...groups.keys()],
    factors: all,
    watchability,
    editorial,
    overall: overallOf(all, FACTORS.map(f => f.id)),
    byCase,
    mistakesPer10Min: count("per10Min"),
    stylePer10Min: count("stylePer10Min"),
    mistakeCounts: {
      wronglyCut: count("wronglyCut"),
      longMissed: count("longMissed"),
      clippedWords: count("clippedWords"),
      stutters: count("stutters"),
      styleLeftIn: count("styleLeftIn"),
      leftIn: count("leftIn"),
    },
    facts: { asks: asks(), tokens: headline("tokens"), minutes: headline("activeMinutes"), finishMinutes: headline("finishMinutes"),
      // In cents, so the one-decimal mean keeps a cheap pass's cost.
      cents: stat(numbers(trials.map(t => t.score.headline.costUsd)).map(v => v * 100)) },
  };
}

const WATCHABILITY_SET = new Set<FactorId>(WATCHABILITY_IDS);

function meanOf(of: Record<FactorId, Stat | null>, ids: readonly FactorId[]): number | null {
  const have = ids.filter(id => of[id]);
  return have.length ? r1(have.reduce((a, id) => a + of[id]!.mean, 0) / have.length) : null;
}

/**
 * Combined score over the named factors: when both Watchability and Editorial match factors are present, returns
 * their geometric mean `sqrt(watchability * editorial)` so severe craft defects cannot hide behind high editorial
 * averages. When only one group is present, returns that group's mean.
 */
export function overallOf(of: Record<FactorId, Stat | null>, ids: readonly FactorId[]): number | null {
  const w = meanOf(of, ids.filter(id => WATCHABILITY_SET.has(id)));
  const e = meanOf(of, ids.filter(id => !WATCHABILITY_SET.has(id)));
  if (w !== null && e !== null) return r1(Math.sqrt(w * e));
  return w ?? e;
}

/** The share of the ledger's free checks that pass: the mistakes already reported that the code still gets right. */
export function ledgerPct(results: ReadonlyArray<{ verdict: Verdict }>): { pct: number | null; pass: number; checked: number } {
  const checked = results.filter(r => r.verdict === "pass" || r.verdict === "fail" || r.verdict === "error");
  const pass = checked.filter(r => r.verdict === "pass").length;
  return { pct: checked.length ? r1(100 * pass / checked.length) : null, pass, checked: checked.length };
}

const show = (s: Stat | null) => !s ? "–" : s.n > 1 && s.max - s.min >= 0.1 ? `${s.mean}% (${s.min}–${s.max})` : `${s.mean}%`;

/** The cards as a table. With two sides a column says which way each factor moved, and whether the sides' trials overlap. `details` spells out one trial's figures. */
export function scorecardMarkdown(cards: readonly Card[], ledger?: { label: string; pct: number | null; pass: number; checked: number }, details?: Factors): string {
  const [a, b] = cards, two = cards.length === 2;
  const common = FACTORS.map(f => f.id).filter(id => cards.every(c => c.factors[id]));
  const commonWatch = common.filter(id => WATCHABILITY_SET.has(id));
  const commonEdit = common.filter(id => !WATCHABILITY_SET.has(id));
  const lines = ["# Dialogue scorecard", "",
    cards.map(c => `**${c.label}**: ${c.trials} pass${c.trials === 1 ? "" : "es"} on ${c.cases.join(", ")}`).join(" · "), "",
    `| Factor | ${cards.map(c => c.label).join(" | ")} |${two ? " Change |" : ""} 100% means |`,
    `|---|${cards.map(() => "---").join("|")}|${two ? "---|" : ""}---|`];
  const moved = (x: Stat | null, y: Stat | null) => {
    if (!x || !y) return "–";
    const d = r1(y.mean - x.mean), sign = d > 0 ? "+" : "";
    // Trials of one side disagree with each other; a difference inside that disagreement is not a result.
    const apart = y.min > x.max || y.max < x.min;
    return Math.abs(d) < 0.05 ? "same" : `${sign}${d}${apart ? "" : " (within the spread)"}`;
  };
  const summaryRow = (label: string, pick: (c: Card) => number | null, means: string) => {
    const cell = (c: Card) => pick(c) === null ? "–" : `**${pick(c)}%**`;
    const delta = two
      ? ` ${pick(a!) !== null && pick(b!) !== null ? `**${r1(pick(b!)! - pick(a!)!) > 0 ? "+" : ""}${r1(pick(b!)! - pick(a!)!)}**` : "–"} |`
      : "";
    lines.push(`| **${label}** | ${cards.map(cell).join(" | ")} |${delta} ${means} |`);
  };
  const overallDesc = commonWatch.length && commonEdit.length
    ? `geometric mean of Watchability (${commonWatch.length}) and Editorial match (${commonEdit.length})`
    : `the mean of the ${common.length} factors every side has`;
  summaryRow("Overall", c => overallOf(c.factors, common), overallDesc);
  if (commonWatch.length) {
    summaryRow("Watchability", c => overallOf(c.factors, commonWatch), `craft quality across ${commonWatch.length} rate-based bug factors`);
  }
  for (const f of FACTORS.filter(f => f.group === "watchability")) {
    lines.push(`| ${f.label} | ${cards.map(c => show(c.factors[f.id])).join(" | ")} |${two ? ` ${moved(a!.factors[f.id], b!.factors[f.id])} |` : ""} ${f.means} |`);
  }
  if (commonEdit.length) {
    summaryRow("Editorial match", c => overallOf(c.factors, commonEdit), `alignment with the editor across ${commonEdit.length} decision and pacing factors`);
  }
  for (const f of FACTORS.filter(f => f.group === "editorial")) {
    lines.push(`| ${f.label} | ${cards.map(c => show(c.factors[f.id])).join(" | ")} |${two ? ` ${moved(a!.factors[f.id], b!.factors[f.id])} |` : ""} ${f.means} |`);
  }
  if (cards.some(c => c.mistakesPer10Min)) {
    const n = (s: Stat | null) => !s ? "–" : s.n > 1 && s.max - s.min >= 0.1 ? `${s.mean} (${s.min}–${s.max})` : `${s.mean}`;
    // Fewer is better here, so the same spread rule reads the other way round.
    const fewer = (x: Stat | null, y: Stat | null) => {
      if (!x || !y) return "–";
      const d = r1(y.mean - x.mean), apart = y.min > x.max || y.max < x.min;
      return Math.abs(d) < 0.05 ? "same" : `${d > 0 ? "+" : ""}${d}${apart ? "" : " (within the spread)"}`;
    };
    const row = (label: string, pick: (c: Card) => Stat | null, means: string) =>
      `| ${label} | ${cards.map(c => n(pick(c))).join(" | ")} |${two ? ` ${fewer(pick(a!), pick(b!))} |` : ""} ${means} |`;
    lines.push("", "Counted, not scored as a percentage. Fewer is better.", "",
      `| Mistakes you'd notice | ${cards.map(c => c.label).join(" | ")} |${two ? " Change |" : ""} What is counted |`, `|---|${cards.map(() => "---").join("|")}|${two ? "---|" : ""}---|`,
      row("**Hard mistakes per 10 min**", c => c.mistakesPer10Min, "the four objective craft bugs below, added up"),
      row("Cut, and the editor kept it", c => c.mistakeCounts.wronglyCut, `runs of ${NOTICED_WORDS} words or more, in the whole video`),
      row("Long passage left in", c => c.mistakeCounts.longMissed, `runs of ${LONG_MISSED_WORDS} words or more the editor cut, in the whole video`),
      row("Words a cut lands inside", c => c.mistakeCounts.clippedWords, "in the whole video"),
      row("Stutter cuts", c => c.mistakeCounts.stutters, `pieces under ${STUTTER_SECONDS} s between two cuts`),
      row("Short tightenings left in (per 10 min)", c => c.stylePer10Min, `${NOTICED_WORDS}–${LONG_MISSED_WORDS - 1} word runs the editor trimmed (taste/tightness, separate from hard mistakes)`),
      row("Short tightenings left in", c => c.mistakeCounts.styleLeftIn, `runs of ${NOTICED_WORDS}–${LONG_MISSED_WORDS - 1} words, in the whole video`));
  }
  if (ledger) lines.push(`| Past mistakes | ${cards.map((_, i) => i === cards.length - 1 ? (ledger.pct === null ? "–" : `${ledger.pct}%`) : "").join(" | ")} |${two ? " |" : ""} every reported mistake with a free check still passes (${ledger.pass} of ${ledger.checked}, ${ledger.label}) |`);
  const fact = (s: Stat | null, digits = 1, scale = 1) => s ? (s.mean / scale).toFixed(digits) : "–";
  lines.push("", "Not scored: " + cards.map(c => `${c.label}: ${fact(c.facts.asks)} calls and flags for the editor, ` +
    `${fact(c.facts.finishMinutes)} min to finish (${fact(c.facts.minutes)} active), ${fact(c.facts.tokens, 2, 1e6)}M tokens, ` +
    `${c.facts.cents ? `$${fact(c.facts.cents, 2, 100)}` : "no estimated cost"} a pass`).join(" · ") + ".");
  if (cards.some(c => c.trials < 4)) lines.push("", "Fewer than 4 passes a side: two passes of the same code differ by a few points, so read small differences as noise.");
  if (cards.some(c => c.cases.length < 3)) lines.push("", `Recordings: ${[...new Set(cards.flatMap(c => c.cases))].join(", ")}. With fewer than three, the figures describe these videos more than the cutting.`);
  if (cards.some(c => c.cases.length > 1)) {
    for (const c of cards) {
      lines.push("", `## ${c.label}, by recording`, "", `| Recording | ${FACTORS.map(f => f.label).join(" | ")} |`, `|---|${FACTORS.map(() => "---").join("|")}|`);
      for (const [id, fs] of Object.entries(c.byCase)) lines.push(`| ${id} | ${FACTORS.map(f => show(fs[f.id])).join(" | ")} |`);
    }
  }
  if (details) lines.push("", "## What each figure is made of", "", ...FACTORS.map(f => `- **${f.label}:** ${details[f.id].detail}.`));
  return lines.join("\n") + "\n";
}

/** Every evaluation.json at or under a path: a run folder holds one per trial. */
export function findEvaluations(path: string): string[] {
  const at = resolve(path);
  if (!existsSync(at)) throw new Error(`No such file or folder: ${path}`);
  if (statSync(at).isFile()) return [at];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const child = join(dir, name);
      if (statSync(child).isDirectory()) walk(child);
      else if (name === "evaluation.json") out.push(child);
    }
  };
  walk(at);
  return out;
}

/**
 * A scored trial with its cut read against the published video. That needs the case's words and what the published
 * video kept, and what the task left of each recording: a trial scored before those were saved, or whose case isn't in
 * this eval data, has the figures that need neither.
 */
export function readTrial(file: string, cases = new Map<string, ReturnType<typeof loadCase> | undefined>()): Trial {
  const ev = readJson<Evaluation>(file);
  if (!ev.caseId || !ev.score.left) return ev;
  if (!cases.has(ev.caseId)) {
    let loaded: ReturnType<typeof loadCase> | undefined;
    try { loaded = loadCase(ev.caseId); } catch { loaded = undefined; }
    cases.set(ev.caseId, loaded);
  }
  const loaded = cases.get(ev.caseId), published = loaded?.file.reference?.published?.kept;
  if (!loaded || !published) return ev;
  const parts = loaded.file.dialogueMedia.flatMap(mediaId => {
    const words = loaded.evidence.get(mediaId)?.words as Word[] | undefined, editor = published[mediaId];
    const kept = ev.score.left.kept[mediaId] ?? [], removed = ev.score.left.removed[mediaId] ?? [];
    // What the source version played of the recording is what the task kept of it and what it took out.
    return words && editor ? [cutDetail(words, merge([...kept, ...removed]), kept, editor)] : [];
  });
  return parts.length ? { ...ev, detail: addCutDetails(parts) } : ev;
}

/** The scored trials under a path, with the detail of each factor for a single trial. */
export function loadSide(label: string, path: string): { card: Card; details?: Factors } {
  const files = findEvaluations(path);
  if (!files.length) throw new Error(`No evaluation.json under ${path}: score the run first (run.ts --evaluate-task, or a run with --yes).`);
  const cases = new Map<string, ReturnType<typeof loadCase> | undefined>();
  const trials = files.map(f => readTrial(f, cases));
  return { card: card(label, trials), ...(trials.length === 1 && { details: factors(trials[0]!.score, trials[0]!.detail) }) };
}

async function scorecardCli(argv = process.argv.slice(2)) {
  const { values, positionals } = cli({ labels: { type: "string" }, ledger: { type: "boolean" }, json: { type: "boolean" } }, USAGE, argv);
  if (!positionals.length) throw new Error(USAGE);
  const labels = list(values.labels);
  const sides = positionals.map((p, i) => loadSide(labels[i] ?? (positionals.length === 1 ? "This run" : p.replace(/\/+$/, "").split("/").at(-1)!), p));
  let ledger: Parameters<typeof scorecardMarkdown>[1];
  if (values.ledger) {
    const { results } = await runChecks(loadLedger().entries, line => console.error(line));
    ledger = { label: "this checkout", ...ledgerPct(results) };
  } else {
    const last = loadBoard().at(-1);
    if (last) ledger = { label: `recorded ${last.at.slice(0, 10)}${last.label ? `, ${last.label}` : ""}`, ...ledgerPct(Object.values(last.results)) };
  }
  if (values.json) { console.log(JSON.stringify({ cards: sides.map(s => s.card), ledger }, null, 2)); return; }
  console.log(scorecardMarkdown(sides.map(s => s.card), ledger, sides.length === 1 ? sides[0]!.details : undefined));
}

if (isMain(import.meta.url)) void main(() => scorecardCli());

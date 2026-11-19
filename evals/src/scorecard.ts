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
import { addCutDetails, cutDetail, NOTICED_WORDS, STUTTER_SECONDS, type CutDetail } from "./cutDetail.ts";
import { merge } from "./intervals.ts";
import { loadBoard, loadLedger, runChecks, type Verdict } from "./ledger.ts";
import type { PacingSummary, Word } from "./metrics.ts";
import { readJson } from "./paths.ts";
import type { Score } from "./score.ts";

const USAGE = `Usage:
  tsx evals/src/scorecard.ts <run dir | evaluation.json> [<another> ...] [--labels a,b] [--ledger] [--json]

Each path is one side: all the scored trials under it. Two sides are compared factor by factor.
--ledger also runs the free ledger checks on this checkout and adds their pass rate (about a minute, no model tokens).`;

export type FactorId = "cutDecisions" | "takeChoice" | "linesKept" | "sameCuts" | "wholeWords" | "pausesLeft" | "pausesTrimmed" | "deadAir"
  | "cutCount" | "spaceAtCut" | "nothingLeftIn" | "noStutter" | "knownMoments";

export interface Factor {
  id: FactorId;
  label: string;
  /** What 100% means, in a sentence the editor can read. */
  means: string;
}

/**
 * Every factor is 0–100 and higher is better. Each is on the scale of the editor's own cut, never of the raw recording:
 * most of what comes out of a recording is easy, so a figure counted over all of it reads high whatever the pass did
 * with the hard calls (two passes that left three times the editor's dead air scored 98% for it that way, 2026-11-18).
 */
export const FACTORS: readonly Factor[] = [
  { id: "cutDecisions", label: "Cut decisions", means: "every removal the editor made, Scarlet made, and no others; a removal counts once, long or short" },
  { id: "takeChoice", label: "Take choice", means: "where a line was said twice, Scarlet kept the take the editor kept, and only that one" },
  { id: "linesKept", label: "Lines kept", means: "every sentence the editor kept is still in" },
  { id: "sameCuts", label: "Same cuts", means: "every cut of the editor's that can be told apart, Scarlet made between the same two words" },
  { id: "wholeWords", label: "No mid-word cuts", means: "no join cuts into a word that is sounding" },
  { id: "pausesLeft", label: "Pauses left alone", means: "every pause the editor left as it was said, Scarlet left too" },
  { id: "pausesTrimmed", label: "Pauses trimmed", means: "every pause the editor shortened, Scarlet shortened too" },
  { id: "deadAir", label: "Dead air", means: "as much dead air left as the editor left" },
  { id: "cutCount", label: "Cut count", means: "as many cuts as the editor made" },
  { id: "spaceAtCut", label: "Space at a cut", means: "at cuts both made, the pause is within 0.1 s of the editor's" },
  { id: "nothingLeftIn", label: "No restarts left in", means: "no more restarts or doubled words play than in the editor's cut" },
  { id: "noStutter", label: "No stutter cuts", means: "no piece between two cuts plays for under a second" },
  { id: "knownMoments", label: "Known mistakes", means: "every spot that went wrong before comes out right, or is asked about" },
];

export interface FactorValue { pct: number | null; detail: string }
export type Factors = Record<FactorId, FactorValue>;

/** A pause at a cut within this of the editor's is the same pause: three frames. */
export const SAME_SPACE_MS = 100;

const clamp = (v: number) => Math.max(0, Math.min(100, v));
const r1 = (v: number) => Math.round(v * 10) / 10;
const none = (detail: string): FactorValue => ({ pct: null, detail });
const pctOf = (n: number, d: number) => r1(100 * n / d);

/** How close two amounts are, as the smaller over the larger: 100 when equal, 50 when one is twice the other, either way round. */
export function ratio(candidate: number, reference: number): number {
  const hi = Math.max(candidate, reference);
  return hi <= 0 ? 100 : clamp(100 * Math.min(candidate, reference) / hi);
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

  const edges = score.applied.edges.total + (score.review?.edges.total ?? 0);
  const clipped = score.applied.edges.clippedOnSound + (score.review?.edges.clippedOnSound ?? 0);
  const wholeWords: FactorValue = !edges ? none("no cuts")
    : { pct: pctOf(edges - clipped, edges), detail: `${clipped} of ${edges} cut edges land inside a sounding word` };

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

  const mistakes = (s: PacingSummary) => s.restarts + s.repeats.total;
  const allowed = ref ? mistakes(ref) : 0;
  // One more than the editor's cut plays counts against the editor's own figure, not the recording's.
  const nothingLeftIn: FactorValue = {
    pct: r1(clamp(100 * (allowed + 1) / (Math.max(mistakes(left), allowed) + 1))),
    detail: `${mistakes(left)} restarts and doubled words play${ref ? `, the editor's cut plays ${allowed}` : ""}`,
  };

  const pc = detail?.pieces;
  const noStutter: FactorValue = !pc ? noDetail : !pc.total ? none("no cuts")
    : { pct: pctOf(pc.total - pc.short, pc.total), detail: `${pc.short} of ${pc.total} pieces play for under ${STUTTER_SECONDS} s (the editor's cut: ${pc.editorShort} of ${pc.editorTotal})` };

  const moments = score.moments ?? [];
  const ok = moments.filter(m => m.outcome !== "wrong").length;
  const knownMoments: FactorValue = !moments.length ? none("no known spots in this recording")
    : { pct: pctOf(ok, moments.length), detail: `${ok} of ${moments.length} right or asked` };

  return { cutDecisions, takeChoice, linesKept, sameCuts, wholeWords, pausesLeft, pausesTrimmed, deadAir, cutCount, spaceAtCut, nothingLeftIn, noStutter, knownMoments };
}

/** What a viewer would notice in a cut, counted, and for every ten minutes the cut plays. */
export interface Mistakes { wronglyCut: number; leftIn: number; clippedWords: number; stutters: number; total: number; per10Min: number | null }

/**
 * A run of words Scarlet cut that the editor kept, one it left in that the editor cut, a word a join cuts into, a piece
 * too short to play. A disagreement of a single word isn't counted: the published video's words are matched to the
 * recording's by two transcripts, which differ by a word at the edge of a piece often enough to drown the real ones.
 */
export function mistakes(score: Score, detail: CutDetail): Mistakes {
  const noticed = (xs: readonly { words: number }[]) => xs.filter(x => x.words >= NOTICED_WORDS).length;
  const counts = { wronglyCut: noticed(detail.wronglyCut), leftIn: noticed(detail.leftIn),
    clippedWords: score.applied.edges.clippedOnSound + (score.review?.edges.clippedOnSound ?? 0), stutters: detail.pieces.short };
  const total = counts.wronglyCut + counts.leftIn + counts.clippedWords + counts.stutters;
  const seconds = Object.values(score.left?.kept ?? {}).flat().reduce((a, r) => a + r.end - r.start, 0);
  return { ...counts, total, per10Min: seconds > 0 ? r1(total / (seconds / 600)) : null };
}

export interface Stat { mean: number; min: number; max: number; n: number }
export interface Card {
  label: string;
  trials: number;
  cases: string[];
  factors: Record<FactorId, Stat | null>;
  /** The mean of the factors this side has a figure for. Compare two sides on `overallOf` instead. */
  overall: number | null;
  /** Mistakes a viewer would notice in every ten minutes of the cut: lower is better. */
  mistakesPer10Min: Stat | null;
  mistakeCounts: Record<"wronglyCut" | "leftIn" | "clippedWords" | "stutters", Stat | null>;
  byCase: Record<string, Record<FactorId, Stat | null>>;
  /** Not scored: for the editor's eye. */
  facts: { asks: Stat | null; tokens: Stat | null; minutes: Stat | null };
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
    mistakesByCase.push(Object.fromEntries((["wronglyCut", "leftIn", "clippedWords", "stutters", "total", "per10Min"] as const)
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
  return { label, trials: trials.length, cases: [...groups.keys()], factors: all, overall: overallOf(all, FACTORS.map(f => f.id)), byCase,
    mistakesPer10Min: count("per10Min"),
    mistakeCounts: { wronglyCut: count("wronglyCut"), leftIn: count("leftIn"), clippedWords: count("clippedWords"), stutters: count("stutters") },
    facts: { asks: asks(), tokens: headline("tokens"), minutes: headline("activeMinutes") } };
}

/** The mean of the named factors, or null when one of them has no figure: an overall over different factors can't be compared. */
export function overallOf(of: Record<FactorId, Stat | null>, ids: readonly FactorId[]): number | null {
  const have = ids.filter(id => of[id]);
  return have.length ? r1(have.reduce((a, id) => a + of[id]!.mean, 0) / have.length) : null;
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
  const overall = (c: Card) => overallOf(c.factors, common);
  const overallCell = (c: Card) => overall(c) === null ? "–" : `**${overall(c)}%**`;
  lines.push(`| **Overall** | ${cards.map(overallCell).join(" | ")} |${two ? ` ${overall(a!) !== null && overall(b!) !== null ? `**${r1(overall(b!)! - overall(a!)!) > 0 ? "+" : ""}${r1(overall(b!)! - overall(a!)!)}**` : "–"} |` : ""} the mean of the ${common.length} factors every side has |`);
  for (const f of FACTORS) {
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
      row("**In every 10 minutes of the cut**", c => c.mistakesPer10Min, "the four below, added up"),
      row("Cut, and the editor kept it", c => c.mistakeCounts.wronglyCut, `runs of ${NOTICED_WORDS} words or more, in the whole video`),
      row("Left in, and the editor cut it", c => c.mistakeCounts.leftIn, `runs of ${NOTICED_WORDS} words or more, in the whole video`),
      row("Words a cut lands inside", c => c.mistakeCounts.clippedWords, "in the whole video"),
      row("Stutter cuts", c => c.mistakeCounts.stutters, `pieces under ${STUTTER_SECONDS} s between two cuts`));
  }
  if (ledger) lines.push(`| Past mistakes | ${cards.map((_, i) => i === cards.length - 1 ? (ledger.pct === null ? "–" : `${ledger.pct}%`) : "").join(" | ")} |${two ? " |" : ""} every reported mistake with a free check still passes (${ledger.pass} of ${ledger.checked}, ${ledger.label}) |`);
  const fact = (s: Stat | null, digits = 1, scale = 1) => s ? (s.mean / scale).toFixed(digits) : "–";
  lines.push("", "Not scored: " + cards.map(c => `${c.label}: ${fact(c.facts.asks)} calls and flags for the editor, ${fact(c.facts.minutes)} min, ${fact(c.facts.tokens, 2, 1e6)}M tokens a pass`).join(" · ") + ".");
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

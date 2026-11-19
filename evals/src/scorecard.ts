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
import { loadBoard, loadLedger, runChecks, type Verdict } from "./ledger.ts";
import type { PacingSummary } from "./metrics.ts";
import { readJson } from "./paths.ts";
import type { Score } from "./score.ts";

const USAGE = `Usage:
  tsx evals/src/scorecard.ts <run dir | evaluation.json> [<another> ...] [--labels a,b] [--ledger] [--json]

Each path is one side: all the scored trials under it. Two sides are compared factor by factor.
--ledger also runs the free ledger checks on this checkout and adds their pass rate (about a minute, no model tokens).`;

export type FactorId = "cutAccuracy" | "linesKept" | "wholeWords" | "deadAir" | "cutCount" | "spaceAtCut" | "nothingLeftIn" | "knownMoments";

export interface Factor {
  id: FactorId;
  label: string;
  /** What 100% means, in a sentence the editor can read. */
  means: string;
}

/** Every factor is 0–100 and higher is better. All but `wholeWords` and `knownMoments` need the published video. */
export const FACTORS: readonly Factor[] = [
  { id: "cutAccuracy", label: "Cut accuracy", means: "Scarlet removed the words the editor removed, and no others" },
  { id: "linesKept", label: "Lines kept", means: "every sentence the editor kept is still in" },
  { id: "wholeWords", label: "No mid-word cuts", means: "no join cuts into a word that is sounding" },
  { id: "deadAir", label: "Dead air", means: "as much dead air left as the editor left, no more and no less" },
  { id: "cutCount", label: "Cut count", means: "as many cuts as the editor made" },
  { id: "spaceAtCut", label: "Space at a cut", means: "at cuts both made, the pause is within 0.1 s of the editor's" },
  { id: "nothingLeftIn", label: "No restarts left in", means: "no more restarts or doubled words play than in the editor's cut" },
  { id: "knownMoments", label: "Known mistakes", means: "every spot that went wrong before comes out right, or is asked about" },
];

export interface FactorValue { pct: number | null; detail: string }
export type Factors = Record<FactorId, FactorValue>;

/** A pause at a cut within this of the editor's is the same pause: three frames. */
export const SAME_SPACE_MS = 100;

const clamp = (v: number) => Math.max(0, Math.min(100, v));
const r1 = (v: number) => Math.round(v * 10) / 10;
const none = (detail: string): FactorValue => ({ pct: null, detail });

/**
 * How close `candidate` is to `reference` on the scale of what the editor changed from `source`: 100 at the editor's
 * own figure, 0 when the candidate is as far from it as the untouched recording, on either side. Too tight counts as
 * much as too loose: a pass that trims every short pause is as far from the editor as one that trims none.
 */
export function closeness(source: number, candidate: number, reference: number): number {
  const room = Math.abs(source - reference);
  return clamp(100 * (1 - Math.abs(candidate - reference) / Math.max(room, 1e-9)));
}

/** The factors of one scored run. Read at what the editor gets by accepting Scarlet's own picks on every staged cut. */
export function factors(score: Score): Factors {
  const point = score.reference?.operatingPoints.recommended.cut ?? score.reference?.operatingPoints.applied.cut;
  const p = score.pacing, ref = p.reference, left: PacingSummary = p.recommended ?? p.final ?? p.applied;
  const noReference = none("no published video for this recording");

  const words = point?.words;
  const cutAccuracy: FactorValue = words?.f1 == null ? noReference : {
    pct: r1(100 * words.f1),
    detail: `${Math.round(100 * (words.precision ?? 0))}% of the words Scarlet cut, the editor cut too; ${Math.round(100 * (words.recall ?? 0))}% of the editor's cut words, Scarlet cut`,
  };

  const lines = point?.requiredLines;
  const linesKept: FactorValue = !lines?.required ? noReference
    : { pct: r1(100 * (1 - lines.missing / lines.required)), detail: `${lines.missing} of ${lines.required} lines the editor kept are cut` };

  const edges = score.applied.edges.total + (score.review?.edges.total ?? 0);
  const clipped = score.applied.edges.clippedOnSound + (score.review?.edges.clippedOnSound ?? 0);
  const wholeWords: FactorValue = !edges ? none("no cuts")
    : { pct: r1(100 * (1 - clipped / edges)), detail: `${clipped} of ${edges} cut edges land inside a sounding word` };

  const deadAir: FactorValue = !ref ? noReference : {
    pct: r1(closeness(p.source.gaps.excessSeconds, left.gaps.excessSeconds, ref.gaps.excessSeconds)),
    detail: `${left.gaps.excessSeconds} s left, the editor left ${ref.gaps.excessSeconds} s of the recording's ${p.source.gaps.excessSeconds} s`,
  };

  const cutCount: FactorValue = !ref?.joins ? noReference
    : { pct: r1(clamp(100 * (1 - Math.abs(left.joins - ref.joins) / ref.joins))), detail: `${left.joins} cuts, the editor made ${ref.joins}` };

  const shared = p.sharedJoins?.applied;
  const within = shared?.matched.filter(m => Math.abs(m.errorMs) <= SAME_SPACE_MS).length ?? 0;
  const spaceAtCut: FactorValue = !shared?.matched.length ? none(ref ? "no cut in the same place as one of the editor's" : noReference.detail)
    : { pct: r1(100 * within / shared.matched.length), detail: `${within} of ${shared.matched.length} cuts both made, median ${shared.medianAbsErrorMs} ms off` };

  const mistakes = (s: PacingSummary) => s.restarts + s.repeats.total;
  const allowed = ref ? mistakes(ref) : 0, extra = Math.max(0, mistakes(left) - allowed);
  const room = Math.max(1, mistakes(p.source) - allowed);
  const nothingLeftIn: FactorValue = {
    pct: r1(clamp(100 * (1 - extra / room))),
    detail: `${mistakes(left)} restarts and doubled words play${ref ? `, the editor's cut plays ${allowed}` : ""}; the recording has ${mistakes(p.source)}`,
  };

  const moments = score.moments ?? [];
  const ok = moments.filter(m => m.outcome !== "wrong").length;
  const knownMoments: FactorValue = !moments.length ? none("no known spots in this recording")
    : { pct: r1(100 * ok / moments.length), detail: `${ok} of ${moments.length} right or asked` };

  return { cutAccuracy, linesKept, wholeWords, deadAir, cutCount, spaceAtCut, nothingLeftIn, knownMoments };
}

export interface Stat { mean: number; min: number; max: number; n: number }
export interface Card {
  label: string;
  trials: number;
  cases: string[];
  factors: Record<FactorId, Stat | null>;
  /** The mean of the factors this side has a figure for. Compare two sides on `overallOf` instead. */
  overall: number | null;
  byCase: Record<string, Record<FactorId, Stat | null>>;
  /** Not scored: for the editor's eye. */
  facts: { asks: Stat | null; tokens: Stat | null; minutes: Stat | null };
}

const stat = (values: number[]): Stat | null => values.length
  ? { mean: r1(values.reduce((a, b) => a + b, 0) / values.length), min: Math.min(...values), max: Math.max(...values), n: values.length } : null;
const numbers = (values: Array<number | null | undefined>) => values.filter((v): v is number => typeof v === "number");

/** One side's card from its scored trials. A trial with no reference still counts toward the factors that need none. */
export function card(label: string, trials: ReadonlyArray<{ caseId?: string; score: Score }>): Card {
  const groups = new Map<string, Factors[]>();
  for (const t of trials) groups.set(t.caseId ?? "(no case)", [...(groups.get(t.caseId ?? "(no case)") ?? []), factors(t.score)]);
  const byCase: Card["byCase"] = {};
  for (const [id, fs] of groups) {
    byCase[id] = Object.fromEntries(FACTORS.map(f => [f.id, stat(numbers(fs.map(x => x[f.id].pct)))])) as Record<FactorId, Stat | null>;
  }
  const all = Object.fromEntries(FACTORS.map(f => {
    const perCase = Object.values(byCase).map(c => c[f.id]).filter((s): s is Stat => !!s);
    // Recordings count equally; the spread is over every trial.
    return [f.id, perCase.length ? { mean: r1(perCase.reduce((a, s) => a + s.mean, 0) / perCase.length),
      min: Math.min(...perCase.map(s => s.min)), max: Math.max(...perCase.map(s => s.max)), n: perCase.reduce((a, s) => a + s.n, 0) } : null];
  })) as Record<FactorId, Stat | null>;
  const headline = (k: string) => stat(numbers(trials.map(t => t.score.headline[k])));
  return { label, trials: trials.length, cases: [...groups.keys()], factors: all, overall: overallOf(all, FACTORS.map(f => f.id)), byCase,
    facts: { asks: headline("needsYourCall"), tokens: headline("tokens"), minutes: headline("activeMinutes") } };
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
  if (ledger) lines.push(`| Past mistakes | ${cards.map((_, i) => i === cards.length - 1 ? (ledger.pct === null ? "–" : `${ledger.pct}%`) : "").join(" | ")} |${two ? " |" : ""} every reported mistake with a free check still passes (${ledger.pass} of ${ledger.checked}, ${ledger.label}) |`);
  const fact = (s: Stat | null, digits = 1, scale = 1) => s ? (s.mean / scale).toFixed(digits) : "–";
  lines.push("", "Not scored: " + cards.map(c => `${c.label}: ${fact(c.facts.asks)} calls for the editor, ${fact(c.facts.minutes)} min, ${fact(c.facts.tokens, 2, 1e6)}M tokens a pass`).join(" · ") + ".");
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

/** The scored trials under a path, with the detail of each factor for a single trial. */
export function loadSide(label: string, path: string): { card: Card; details?: Factors } {
  const files = findEvaluations(path);
  if (!files.length) throw new Error(`No evaluation.json under ${path}: score the run first (run.ts --evaluate-task, or a run with --yes).`);
  const trials = files.map(f => readJson<Evaluation>(f));
  return { card: card(label, trials), ...(trials.length === 1 && { details: factors(trials[0]!.score) }) };
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

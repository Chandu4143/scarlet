/**
 * Bring saved runs up to the current scoring rules (RUBRIC in score.ts) offline: no engine and no model tokens.
 *
 *   tsx evals/src/regrade.ts <run dir> <new dir> [--data <eval data root>]
 *
 * Each eligible trial's evaluation.json keeps everything the trial measured. What the rules read differently is rebuilt
 * from the case's frozen words and the cut the trial left (`score.playable[point].kept`). Before anything is rewritten,
 * the old rules are run on the same inputs and must reproduce the stored figures exactly; a trial whose case has changed
 * since it was scored is refused. The saved run is never touched: the regraded copy, and its scorecard, go to <new dir>.
 *
 * The case is looked for beside the run (a folder above it holding cases/<id>), then in --data, $SCARLET_EVAL_DATA, and
 * --data/<id> (one root per recording, as a benchmark keeps its episodes).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { cli, isMain, main } from "./args.ts";
import { loadCase } from "./case.ts";
import { addCutDetails, cutDetail, unmatchedInReference, type CutDetail } from "./cutDetail.ts";
import type { Evaluation } from "./evaluate.ts";
import type { StoredEvidence } from "./evidence.ts";
import { publishedGradingInputs } from "./gradingEvidence.ts";
import type { Range } from "./intervals.ts";
import { checkedPath, readJson, writeJson, writeText } from "./paths.ts";
import { unmatchedPassages } from "./published.ts";
import type { TrialRow } from "./report.ts";
import { card, eligibleTrials, scorecardMarkdown } from "./scorecard.ts";
import { askedOf, RUBRIC, type OperatingPoint } from "./score.ts";
import { keptSource } from "./timeline.ts";

const USAGE = `Usage:
  tsx evals/src/regrade.ts <run dir> <new dir> [--data <eval data root>]

Rescores a saved run's trials under the current rules (${RUBRIC}) without an engine or model tokens, and writes the
regraded run and its scorecard to <new dir>. The saved run is left as it was.`;

/** Older rubrics regrade reads. Each only added readings of the same runs, so all reproduce the same figures once those are set aside. */
const PREVIOUS = ["dialogue-playable-v2", "dialogue-playable-v3", "dialogue-playable-v4"];
const POINTS: OperatingPoint[] = ["automatic", "recommended"];

/** Where a trial's case lives: beside the run, or under the data roots given. */
export function findCaseRoot(runDir: string, caseId: string, roots: readonly string[]): string {
  const has = (root: string) => existsSync(join(root, "cases", caseId, "case.json"));
  for (let dir = resolve(runDir); ; dir = dirname(dir)) {
    if (has(dir)) return dir;
    if (dirname(dir) === dir) break;
  }
  for (const root of roots) for (const candidate of [root, join(root, caseId)]) if (has(candidate)) return candidate;
  throw new Error(`No case ${caseId} beside ${runDir}; pass --data <folder holding cases/${caseId}>.`);
}

/** The figures every rubric since v2 shares, for comparing a regrade with what a trial stored. */
function previous(d: CutDetail) {
  const { unscored: _unscored, joins: _joins, leftIn, wronglyCut, ...rest } = d;
  const plain = (runs: CutDetail["leftIn"]) => runs.map(({ retake: _retake, otherTake: _otherTake, asked: _asked, ...x }) => x);
  return { ...rest, wronglyCut: plain(wronglyCut), leftIn: plain(leftIn) };
}

/** One trial's evaluation under the current rules. Throws when the old rules don't reproduce what it stored. */
export function regradeEvaluation(ev: Evaluation, caseRoot: string): Evaluation {
  if (ev.score.rubric === RUBRIC) return ev;
  if (!PREVIOUS.includes(ev.score.rubric)) throw new Error(`Trial ${ev.taskId} was scored under ${ev.score.rubric ?? "an unversioned rubric"}; regrade reads ${PREVIOUS.join(" and ")}. Re-score it with rescore.ts first.`);
  const before = process.env.SCARLET_EVAL_DATA;
  process.env.SCARLET_EVAL_DATA = caseRoot;
  try {
    const loaded = loadCase(ev.caseId!);
    // A case frozen with its own grading transcript is graded on it, whatever transcript the trial cut from.
    if (loaded.file.gradingEvidence) {
      const grading = publishedGradingInputs(loaded, caseRoot);
      if (!grading) throw new Error(`Case ${ev.caseId} declares grading evidence without a verified published reference.`);
      loaded.evidence.set(loaded.file.gradingEvidence.mediaId, readJson<StoredEvidence>(grading.evidence));
    }
    const published = loaded.file.reference?.published;
    const playable = structuredClone(ev.score.playable);
    if (published && POINTS.some(p => playable[p].detail)) {
      const source = loaded.timeline(ev.score.versions.source);
      if (!source) throw new Error(`Case ${ev.caseId} is missing the source timeline ${ev.score.versions.source}.`);
      const kS = keptSource(source, loaded.file.media);
      const keys = [...kS.keys()];
      const words = (id: string) => {
        const w = loaded.evidence.get(id)?.words;
        if (!w?.length || !published.kept[id]) throw new Error(`Case ${ev.caseId} has no words or published reference for ${id}.`);
        return w;
      };
      const unscored = new Map(keys.map(id => [id, unmatchedInReference(words(id), published.kept[id]!, unmatchedPassages(published))]));
      for (const point of POINTS) {
        const stored = playable[point].detail;
        if (!stored) continue;
        const kept = playable[point].kept as Record<string, Range[]>;
        // v2 read every word; v4, and the v3 of an earlier branch, left the unmatched ones unscored. One of the two must
        // reproduce what the trial stored.
        const readings = [{}, { unscored: undefined as Range[] | undefined }].map((_, i) =>
          addCutDetails(keys.map(id => cutDetail(words(id), kS.get(id)!, kept[id] ?? [], published.kept[id]!, i ? { unscored: unscored.get(id) } : {}))));
        if (!readings.some(old => isDeepStrictEqual(JSON.parse(JSON.stringify(previous(old))), previous(stored)))) {
          throw new Error(`Trial ${ev.taskId} (${point}): the case's words no longer reproduce what the trial stored. Its case changed since it was scored.`);
        }
        playable[point] = { ...playable[point], detail: addCutDetails(keys.map(id =>
          cutDetail(words(id), kS.get(id)!, kept[id] ?? [], published.kept[id]!, { unscored: unscored.get(id), asked: askedOf(ev.score.left, id) }))) };
      }
    }
    return { ...ev, score: { ...ev.score, rubric: RUBRIC, playable }, regraded: { from: ev.score.rubric, at: new Date().toISOString() } } as Evaluation;
  } finally {
    if (before === undefined) delete process.env.SCARLET_EVAL_DATA; else process.env.SCARLET_EVAL_DATA = before;
  }
}

export function regradeRun(run: string, output: string, roots: readonly string[]) {
  if (existsSync(output)) throw new Error("Use a new output directory; the saved run must stay unchanged.");
  const rows = readJson<TrialRow[]>(checkedPath(run, join(run, "trials.json")));
  const entries = eligibleTrials(run);
  if (!entries.length) throw new Error("No eligible completed trials: " + run);
  const byConfig = new Map<string, Array<{ caseId?: string; gradingSha256?: string; score: Evaluation["score"] }>>();
  for (const { file, row } of entries) {
    const original = readFileSync(file);
    const ev = JSON.parse(original.toString("utf8")) as Evaluation;
    const next = { ...regradeEvaluation(ev, findCaseRoot(run, row.caseId, roots)),
      originalEvaluationSha256: createHash("sha256").update(original).digest("hex") };
    writeJson(join(output, relative(run, file)), next, output);
    byConfig.set(row.config, [...(byConfig.get(row.config) ?? []), { caseId: next.caseId, gradingSha256: next.gradingSha256, score: next.score }]);
  }
  writeJson(join(output, "trials.json"), rows, output);
  const cards = [...byConfig].map(([config, trials]) => card(config, trials));
  writeText(join(output, "scorecard.md"), scorecardMarkdown(cards), output);
  return { trials: entries.length, configs: [...byConfig.keys()], scorecard: join(output, "scorecard.md") };
}

async function regradeCli(argv = process.argv.slice(2)) {
  const { values, positionals } = cli({ data: { type: "string" } }, USAGE, argv);
  if (positionals.length !== 2) throw new Error(USAGE);
  const roots = [values.data, process.env.SCARLET_EVAL_DATA].filter((r): r is string => !!r).map(r => resolve(r));
  const result = regradeRun(resolve(positionals[0]!), resolve(positionals[1]!), roots);
  console.log(`Regraded ${result.trials} trial(s) of ${result.configs.join(", ")} under ${RUBRIC}. Scorecard: ${result.scorecard}`);
}

if (isMain(import.meta.url)) void main(() => regradeCli());

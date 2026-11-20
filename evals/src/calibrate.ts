/**
 * Check the scorecard's flags by ear. The flags are counted from transcripts and levels, never heard, so before a count
 * is trusted someone listens to a sample of what it counted and says which are real.
 *
 *   tsx evals/src/calibrate.ts sheet <scored path,...> --out <new dir> [--data <eval data root>] [--per-video 2] [--seed 1]
 *   tsx evals/src/calibrate.ts score <answers.json>
 *
 * `sheet` takes one pass per recording from the scored runs (v3 evaluations), picks a few spots of each kind of flag,
 * and cuts two clips for each: what Scarlet's cut plays there and what the published video plays there. It adds joins
 * nothing flagged, mixed in blind with the mid-word cuts, to see whether the flag tells them apart. The page it writes
 * (index.html, opened from disk) asks one question a spot and saves the answers to a file. `score` reads that file and
 * says, for each kind of flag, how many of the spots were real mistakes: the share of each count worth believing.
 *
 * Clips are rebuilt from the cut's kept source ranges with a 10 ms fade at each join, not rendered by Scarlet: a join
 * that sounds clipped here can be smoothed by Scarlet's own crossfade. Everything stays in the eval data folder.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { cli, isMain, main } from "./args.ts";
import { loadCase } from "./case.ts";
import type { Disagreement } from "./cutDetail.ts";
import type { Evaluation } from "./evaluate.ts";
import type { StoredEvidence } from "./evidence.ts";
import { publishedGradingInputs } from "./gradingEvidence.ts";
import { merge, type Range } from "./intervals.ts";
import { classifyEdges, DEFAULT_EDGE_OPTIONS, joinEdges, type MediaEvidence } from "./metrics.ts";
import { readJson, writeJson, writeText } from "./paths.ts";
import type { PublishedPiece } from "./published.ts";
import { findCaseRoot } from "./regrade.ts";
import { RUBRIC } from "./score.ts";
import { keptSource } from "./timeline.ts";

const USAGE = `Usage:
  tsx evals/src/calibrate.ts sheet <scored path,...> --out <new dir> [--data <eval data root>] [--per-video 2] [--seed 1]
  tsx evals/src/calibrate.ts score <answers.json>

sheet: a listening page with clips of flagged spots, from one pass per recording (needs ffmpeg).
score: how many spots of each kind of flag the listener called real.`;

export type Kind = "midword" | "control" | "wrong" | "retake" | "content";

/** What the listener is asked about each kind of spot. Mid-word flags and unflagged joins share a question, so they're blind. */
export const QUESTIONS: Record<Kind, string> = {
  midword: "Does Scarlet's cut chop off a word or a sound here?",
  control: "Does Scarlet's cut chop off a word or a sound here?",
  wrong: "Scarlet took out words your editor kept. Is Scarlet's version a mistake?",
  retake: "Scarlet left in a line your editor cut for another take. Does a line play twice, or a restart stay in?",
  content: "Scarlet left in a passage your editor cut. Should a dialogue pass have taken it out?",
};

export interface Spot {
  id: string; kind: Kind; caseId: string; mediaId: string;
  /** Source seconds of the recording. */
  at: number; end: number; text: string;
  scarlet: string; editor?: string;
}

/** A small seeded shuffle, so the same runs give the same sheet. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  let s = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The source stretches a cut plays from `before` seconds ahead of source second `t` to `after` seconds past it. */
export function playedAround(kept: readonly Range[], t: number, before = 4, after = 4): Range[] {
  const pieces = merge(kept, 0.001);
  // Where `t` falls on the cut's own clock: inside a kept piece, or at the start of the next one.
  let clock = 0, at: number | undefined;
  for (const p of pieces) {
    if (at === undefined && t < p.end) { at = clock + Math.max(0, t - p.start); }
    clock += p.end - p.start;
  }
  at ??= clock;
  const from = Math.max(0, at - before), to = Math.min(clock, at + after);
  const out: Range[] = [];
  clock = 0;
  for (const p of pieces) {
    const a = Math.max(from, clock), b = Math.min(to, clock + p.end - p.start);
    if (b > a) out.push({ start: p.start + (a - clock), end: p.start + (b - clock) });
    clock += p.end - p.start;
  }
  return out;
}

/** The published video's second that plays source second `t`, or the end of the piece before it. */
export function publishedAt(pieces: readonly PublishedPiece[], mediaId: string, t: number): number | undefined {
  const own = pieces.filter(p => p.mediaId === mediaId);
  const inside = own.find(p => p.sourceStart <= t && t <= p.sourceEnd);
  if (inside) return inside.finalStart + (t - inside.sourceStart) / inside.rate;
  const before = own.filter(p => p.sourceEnd < t).sort((a, b) => b.sourceEnd - a.sourceEnd)[0];
  return before?.finalEnd;
}

function clip(source: string, ranges: readonly Range[], out: string) {
  if (!ranges.length) throw new Error("Nothing plays there.");
  const fade = 0.01;
  const parts = ranges.map((r, i) => `[0:a]atrim=${r.start.toFixed(3)}:${r.end.toFixed(3)},asetpts=PTS-STARTPTS,` +
    `afade=t=in:d=${fade},afade=t=out:st=${Math.max(0, r.end - r.start - fade).toFixed(3)}:d=${fade}[p${i}]`);
  const graph = `${parts.join(";")};${ranges.map((_, i) => `[p${i}]`).join("")}concat=n=${ranges.length}:v=0:a=1[a]`;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", source, "-filter_complex", graph, "-map", "[a]", "-ac", "1", "-ar", "24000", "-b:a", "64k", out]);
}

/** The recording and the published video of a case, from its folder's media/. */
function mediaFiles(root: string, caseFile: { media: Array<{ id: string; path?: string; name?: string }> }, mediaId: string) {
  const dir = join(root, "media");
  const m = caseFile.media.find(x => x.id === mediaId);
  const recording = [m?.path, `${mediaId}.mp4`, m?.name?.toLowerCase(), "presenter.mp4"].filter((x): x is string => !!x).map(x => join(dir, x)).find(existsSync);
  const published = ["published.mp4", "editor.mp4"].map(x => join(dir, x)).find(existsSync);
  return { recording, published };
}

/** Every v3 evaluation.json under the given paths, with where it is. */
function evaluations(paths: readonly string[]): Array<{ file: string; ev: Evaluation }> {
  const found: string[] = [];
  const walk = (p: string) => {
    if (statSync(p).isFile()) { if (basename(p) === "evaluation.json") found.push(p); return; }
    for (const e of readdirSync(p)) walk(join(p, e));
  };
  for (const p of paths) walk(resolve(p));
  return found.sort().map(file => ({ file, ev: readJson<Evaluation>(file) })).filter(({ ev }) => ev.score.rubric === RUBRIC && ev.score.trace?.state === "done");
}

export function buildSheet(paths: readonly string[], out: string, opts: { roots: string[]; perVideo: number; seed: number }) {
  if (existsSync(out)) throw new Error("Use a new folder for the sheet.");
  const evs = evaluations(paths);
  const byCase = new Map<string, { file: string; ev: Evaluation }>();
  for (const e of evs) if (e.ev.caseId && !byCase.has(e.ev.caseId)) byCase.set(e.ev.caseId, e);
  if (!byCase.size) throw new Error(`No completed ${RUBRIC} evaluations under ${paths.join(", ")}. Regrade older runs first (regrade.ts).`);
  mkdirSync(join(out, "clips"), { recursive: true });
  const spots: Spot[] = [];
  const before = process.env.SCARLET_EVAL_DATA;
  try { for (const [caseId, { file, ev }] of byCase) {
    const root = findCaseRoot(dirname(file), caseId, opts.roots);
    process.env.SCARLET_EVAL_DATA = root;
    const loaded = loadCase(caseId);
    if (loaded.file.gradingEvidence) {
      const grading = publishedGradingInputs(loaded, root);
      if (grading) loaded.evidence.set(loaded.file.gradingEvidence.mediaId, readJson<StoredEvidence>(grading.evidence));
    }
    const published = loaded.file.reference?.published;
    const point = ev.score.playable.recommended;
    const mediaId = loaded.file.dialogueMedia[0];
    const source = loaded.timeline(ev.score.versions.source);
    if (!published || !point.detail || !mediaId || !source) { console.error(`Skipping ${caseId}: no published reference or cut detail.`); continue; }
    const { recording, published: publishedFile } = mediaFiles(root, loaded.file, mediaId);
    if (!recording) { console.error(`Skipping ${caseId}: no recording in ${join(root, "media")}.`); continue; }
    const kS = keptSource(source, loaded.file.media);
    const kept = new Map(Object.entries(point.kept as Record<string, Range[]>));
    const evidence = new Map<string, MediaEvidence>([[mediaId, loaded.evidence.get(mediaId)!]]);
    const edges = classifyEdges(joinEdges(kS, kept).filter(e => e.mediaId === mediaId), evidence, DEFAULT_EDGE_OPTIONS);
    const clipped = edges.filter(e => e.clippedWord && e.class !== "silence");
    const clean = edges.filter(e => !e.clippedWord && e.class === "silence");
    const runs = (xs: Disagreement[]) => xs.map(x => ({ at: x.start, end: x.end, text: x.text }));
    const picks: Array<{ kind: Kind; at: number; end: number; text: string }> = [
      ...shuffled(clipped.map(e => ({ kind: "midword" as const, at: e.at, end: e.at, text: e.clippedWord ?? "" })), opts.seed).slice(0, opts.perVideo),
      ...shuffled(clean.map(e => ({ kind: "control" as const, at: e.at, end: e.at, text: "" })), opts.seed).slice(0, 1),
      ...shuffled(runs(point.detail.wronglyCut.filter(x => x.words >= 2)).map(x => ({ kind: "wrong" as const, ...x })), opts.seed).slice(0, opts.perVideo),
      ...shuffled(runs(point.detail.leftIn.filter(x => x.words >= 6 && x.retake)).map(x => ({ kind: "retake" as const, ...x })), opts.seed).slice(0, Math.ceil(opts.perVideo / 2)),
      ...shuffled(runs(point.detail.leftIn.filter(x => x.words >= 6 && !x.retake)).map(x => ({ kind: "content" as const, ...x })), opts.seed).slice(0, Math.ceil(opts.perVideo / 2)),
    ];
    for (const p of picks) {
      const id = `${caseId}-${p.kind}-${Math.round(p.at * 10)}`;
      const scarlet = `clips/${id}-scarlet.m4a`;
      // A join plays 4 s either side; a run Scarlet left in plays through from 2 s before it, up to 24 s.
      const long = p.kind === "retake" || p.kind === "content";
      clip(recording, long ? playedAround(kept.get(mediaId) ?? [], p.at, 2, Math.min(22, p.end - p.at + 2)) : playedAround(kept.get(mediaId) ?? [], p.at),
        join(out, scarlet));
      let editor: string | undefined;
      const from = publishedFile ? publishedAt(published.pieces, mediaId, p.at) : undefined;
      if (publishedFile && from !== undefined) {
        editor = `clips/${id}-editor.m4a`;
        // A run the editor kept plays through; elsewhere the published video plays 4 s either side of the spot.
        const span = p.kind === "wrong" ? Math.min(24, p.end - p.at + 8) : 8;
        clip(publishedFile, [{ start: Math.max(0, from - 4), end: Math.max(0, from - 4) + span }], join(out, editor));
      }
      spots.push({ id, kind: p.kind, caseId, mediaId, at: p.at, end: p.end, text: p.text, scarlet, editor });
    }
  } } finally {
    if (before === undefined) delete process.env.SCARLET_EVAL_DATA; else process.env.SCARLET_EVAL_DATA = before;
  }
  const sheet = shuffled(spots, opts.seed);
  writeJson(join(out, "spots.json"), sheet, out);
  writeText(join(out, "index.html"), sheetHtml(sheet), out);
  return { spots: sheet.length, page: join(out, "index.html") };
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

function sheetHtml(spots: readonly Spot[]): string {
  const rows = spots.map((s, i) => `
<section data-id="${esc(s.id)}">
  <h2>${i + 1} of ${spots.length} <span>${esc(s.caseId)} · ${clock(s.at)} in the recording</span></h2>
  <p class="q">${esc(QUESTIONS[s.kind])}</p>
  ${s.kind === "midword" || s.kind === "control" ? "" : `<p class="words">“${esc(s.text.slice(0, 220))}${s.text.length > 220 ? "…" : ""}”</p>`}
  <div class="clips"><label>Scarlet <audio controls preload="none" src="${esc(s.scarlet)}"></audio></label>
  ${s.editor ? `<label>Your editor <audio controls preload="none" src="${esc(s.editor)}"></audio></label>` : ""}</div>
  <div class="answer" role="radiogroup">
    <button data-v="real">Yes, a real mistake</button><button data-v="fine">No, it's fine</button><button data-v="unsure">Not sure</button>
  </div>
</section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flag check</title>
<style>
:root{--bg:#0d0d0d;--fg:#ededed;--dim:#8a8a8a;--line:#262626;--on:#ffffff;--green:#3ecf8e}
@media (prefers-color-scheme: light){:root{--bg:#fafafa;--fg:#161616;--dim:#6b6b6b;--line:#e2e2e2;--on:#000}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 -apple-system,system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 120px}
h1{font-size:20px;margin:0 0 4px}.lead{color:var(--dim);margin:0 0 24px}
section{border-top:1px solid var(--line);padding:18px 0}
h2{font-size:14px;margin:0 0 6px}h2 span{color:var(--dim);font-weight:400;margin-left:8px}
.q{margin:0 0 8px}.words{color:var(--dim);margin:0 0 10px;font-size:14px}
.clips{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:10px}.clips label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--dim)}
audio{width:300px;max-width:100%}
.answer{display:flex;flex-wrap:wrap;gap:8px}
button{background:none;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 12px;font:inherit;cursor:pointer}
button.on{border-color:var(--on);background:var(--on);color:var(--bg)}
footer{position:fixed;left:0;right:0;bottom:0;background:var(--bg);border-top:1px solid var(--line);padding:12px 16px;display:flex;gap:12px;align-items:center;justify-content:center}
#done{color:var(--dim)}#save.ready{border-color:var(--green);color:var(--green)}
</style></head><body><main>
<h1>Flag check</h1>
<p class="lead">${spots.length} spots the eval flagged, and a few it didn't. Play Scarlet's clip, then your editor's where there is one, and answer. Clips are rebuilt from the cut with a tiny fade, not rendered by Scarlet. Answers are kept in this browser until you save them.</p>
${rows}
</main><footer><span id="done"></span><button id="save">Save answers</button></footer>
<script>
const KEY = "flag-check:" + location.pathname;
let answers = {};
try { answers = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch {}
const sections = [...document.querySelectorAll("section")];
function paint() {
  for (const s of sections) for (const b of s.querySelectorAll("button")) b.classList.toggle("on", answers[s.dataset.id] === b.dataset.v);
  const n = Object.keys(answers).length;
  document.getElementById("done").textContent = n + " of " + sections.length + " answered";
  document.getElementById("save").classList.toggle("ready", n === sections.length);
}
for (const s of sections) for (const b of s.querySelectorAll("button")) b.addEventListener("click", () => {
  answers[s.dataset.id] = b.dataset.v;
  try { localStorage.setItem(KEY, JSON.stringify(answers)); } catch {}
  paint();
});
for (const a of document.querySelectorAll("audio")) a.addEventListener("play", () => { for (const o of document.querySelectorAll("audio")) if (o !== a) o.pause(); });
document.getElementById("save").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ schema: 1, answeredAt: new Date().toISOString(), answers }, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob); link.download = "answers.json"; link.click();
});
paint();
</script></body></html>
`;
}

/** For each kind of flag, how many spots the listener called real. Unflagged joins say how often a clean join is called wrong. */
export function scoreAnswers(spots: readonly Spot[], answers: Record<string, string>) {
  const kinds: Kind[] = ["midword", "control", "wrong", "retake", "content"];
  return Object.fromEntries(kinds.map(kind => {
    const of = spots.filter(s => s.kind === kind);
    const said = (v: string) => of.filter(s => answers[s.id] === v).length;
    const decided = said("real") + said("fine");
    return [kind, { spots: of.length, real: said("real"), fine: said("fine"), unsure: said("unsure"), unanswered: of.length - said("real") - said("fine") - said("unsure"),
      realShare: decided ? Math.round(100 * said("real") / decided) : null }];
  }));
}

async function calibrateCli(argv = process.argv.slice(2)) {
  const { values, positionals } = cli({ out: { type: "string" }, data: { type: "string" }, "per-video": { type: "string" }, seed: { type: "string" } }, USAGE, argv);
  const [command, target] = positionals;
  if (command === "sheet" && target && values.out) {
    const roots = [values.data, process.env.SCARLET_EVAL_DATA].filter((r): r is string => !!r).map(r => resolve(r));
    const result = buildSheet(target.split(","), resolve(values.out), { roots, perVideo: Number(values["per-video"] ?? 2), seed: Number(values.seed ?? 1) });
    console.log(`${result.spots} spots. Open ${result.page}, answer, press Save answers, then: tsx evals/src/calibrate.ts score <answers.json>`);
    return;
  }
  if (command === "score" && target) {
    const file = JSON.parse(readFileSync(resolve(target), "utf8")) as { answers: Record<string, string> };
    const spotsFile = [join(resolve(target, ".."), "spots.json")].find(existsSync);
    if (!spotsFile) throw new Error("Keep answers.json beside the sheet's spots.json.");
    const result = scoreAnswers(readJson<Spot[]>(spotsFile), file.answers);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error(USAGE);
}

if (isMain(import.meta.url)) void main(() => calibrateCli());

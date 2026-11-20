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
import type { Word } from "./metrics.ts";
import { classifyEdges, DEFAULT_EDGE_OPTIONS, joinEdges, type MediaEvidence } from "./metrics.ts";
import { readJson, writeJson, writeText } from "./paths.ts";
import type { PublishedPiece } from "./published.ts";
import { findCaseRoot } from "./regrade.ts";
import { RUBRIC } from "./score.ts";
import { keptSource } from "./timeline.ts";

const USAGE = `Usage:
  tsx evals/src/calibrate.ts sheet <scored path,...> --out <new dir> [--data <eval data root>] [--per-video 2] [--seed 1]
  tsx evals/src/calibrate.ts page <sheet dir>
  tsx evals/src/calibrate.ts score <answers.json>

page: rewrite a sheet's index.html from its spots.json and clips, with the clips inside the page.
sheet: a listening page with clips of flagged spots, from one pass per recording (needs ffmpeg).
score: how many spots of each kind of flag the listener called real.`;

export type Kind = "midword" | "control" | "wrong" | "retake" | "content" | "doubled" | "half";

/** What the listener is asked about each kind of spot. Mid-word flags and unflagged joins share a question, so they're blind. */
/** The question each kind of spot asks, before the page adds where in the clip to listen. */
export const QUESTIONS: Record<Kind, string> = {
  midword: "Does Scarlet's cut chop off a word or a sound here?",
  control: "Does Scarlet's cut chop off a word or a sound here?",
  wrong: "Scarlet took out words your editor kept. Is Scarlet's version a mistake?",
  retake: "Scarlet left in a line your editor cut for another take. Does a line play twice, or a restart stay in?",
  content: "Scarlet left in a passage your editor cut. Should a dialogue pass have taken it out?",
  doubled: "Does a word play twice at Scarlet's join, whole or begun?",
  half: "Does Scarlet's join leave a sentence half said?",
};

export interface Spot {
  id: string; kind: Kind; caseId: string; mediaId: string;
  /** Source seconds of the recording. */
  at: number; end: number; text: string;
  scarlet: string; editor?: string;
  /** Seconds into Scarlet's clip where the spot plays, and into the editor's where the same point in the line plays. */
  offset?: number; editorOffset?: number;
  /** Seconds both clips open with the same words. */
  sharedSeconds?: number;
  /** Their sound didn't confirm the two clips start on the same words: the editor's may start a little off. */
  editorApprox?: true;
  /** The editor cut the whole stretch around the spot: their video has nothing to compare, so there is no clip of it. */
  editorCut?: true;
  /** How long the passage plays in Scarlet's clip, for a run it left in. */
  runSeconds?: number;
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

/** Seconds into a cut's own playback where source second `t` plays, or where the next kept piece starts. */
export function clockOf(kept: readonly Range[], t: number): number {
  let clock = 0;
  for (const p of merge(kept, 0.001)) {
    if (t < p.end) return clock + Math.max(0, t - p.start);
    clock += p.end - p.start;
  }
  return clock;
}

const tokenOf = (text: string) => text.trim().toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
const plays = (w: Range, kept: readonly Range[]) => kept.some(r => r.start <= w.start + 0.02 && w.end - 0.02 <= r.end);

/**
 * Where both clips start: the run of words both cuts play, unbroken, that ends just before `t`, from its first word up to
 * `lead` seconds back. Starting both on it puts the same sentence first, so the listener hears the two match and then
 * where they part; neither clip opens partway through a word. `same(a, b)` says two words play in one stretch of each
 * cut, with nothing taken out between them. Without an editor's cut it is the same run of Scarlet's alone.
 */
export function sharedLeadIn(words: readonly Word[], scarlet: readonly Range[], editor: readonly Range[] | undefined, t: number,
  inPublished: (at: number) => boolean, same: (a: Word, b: Word) => boolean = () => true, lead = 3, reach = 12): { first: Word; last: Word } | undefined {
  const both = (w: Word) => !!w.text.trim() && plays(w, scarlet) && (!editor || (plays(w, editor) && inPublished(w.start)));
  const sorted = words.filter(w => w.text.trim()).slice().sort((a, b) => a.start - b.start);
  let i = sorted.length - 1;
  while (i >= 0 && !(sorted[i]!.end <= t - 0.15 && sorted[i]!.start >= t - reach && both(sorted[i]!))) i--;
  if (i < 0) return undefined;
  const last = sorted[i]!;
  let first = last;
  for (let j = i - 1; j >= 0; j--) {
    const w = sorted[j]!;
    if (!both(w) || !same(w, first) || first.start - w.end > 1 || last.end - w.start > lead) break;
    first = w;
  }
  return { first, last };
}

/** The word both clips start on (see sharedLeadIn). */
export function anchorWord(words: readonly Word[], scarlet: readonly Range[], editor: readonly Range[] | undefined, t: number,
  inPublished: (at: number) => boolean, reach = 12): Word | undefined {
  return sharedLeadIn(words, scarlet, editor, t, inPublished, undefined, 0, reach)?.last;
}

/** Stretch a clip's last range to the end of the word it stops inside, so it doesn't end partway through one. */
export function endBetweenWords(ranges: Range[], words: readonly Word[]): Range[] {
  const last = ranges.at(-1);
  const inside = last && words.find(w => w.start < last.end && last.end < w.end);
  return inside ? [...ranges.slice(0, -1), { start: last.start, end: inside.end + 0.08 }] : ranges;
}

/** The published video's second that plays source second `t`, or the end of the piece before it. */
export function publishedAt(pieces: readonly PublishedPiece[], mediaId: string, t: number): number | undefined {
  const own = pieces.filter(p => p.mediaId === mediaId);
  const inside = own.find(p => p.sourceStart <= t && t <= p.sourceEnd);
  if (inside) return inside.finalStart + (t - inside.sourceStart) / inside.rate;
  const before = own.filter(p => p.sourceEnd < t).sort((a, b) => b.sourceEnd - a.sourceEnd)[0];
  return before?.finalEnd;
}

/** A stretch of a file's sound as a loudness envelope at 1 kHz: enough to line two copies of the same speech up by ear's measure. */
function envelope(file: string, start: number, seconds: number): Float64Array {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", Math.max(0, start).toFixed(3), "-t", seconds.toFixed(3), "-i", file, "-ac", "1", "-ar", "8000", "-f", "f32le", "-"],
    { maxBuffer: 64 * 1024 * 1024 });
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  const out = new Float64Array(Math.floor(pcm.length / 8));
  for (let i = 0; i < out.length; i++) { let sum = 0; for (let k = 0; k < 8; k++) sum += Math.abs(pcm[i * 8 + k]!); out[i] = sum / 8; }
  return out;
}

/**
 * Where in the published video the recording's sound from `source` (for `seconds`) plays, searched within `search` seconds
 * of `guess`: the word match places a stretch to a few tenths of a second, the sound to a few thousandths. Undefined when
 * no lag matches well.
 */
export function alignBySound(recording: string, source: number, published: string, guess: number, seconds = 2, search = 1): number | undefined {
  const found = matchSound(recording, source, published, guess, seconds, search);
  return found && found.r >= 0.6 ? found.at : undefined;
}

/** The best lag of `alignBySound`, with how well it matches (a correlation, 1 for the same sound). */
export function matchSound(recording: string, source: number, published: string, guess: number, seconds = 2, search = 1): { at: number; r: number } | undefined {
  const a = envelope(recording, source, seconds), b = envelope(published, guess - search, seconds + 2 * search);
  const n = a.length;
  if (n < 200 || b.length < n) return undefined;
  const mean = (x: Float64Array, from: number) => { let s = 0; for (let i = 0; i < n; i++) s += x[from + i]!; return s / n; };
  const ma = mean(a, 0);
  let normA = 0; for (let i = 0; i < n; i++) normA += (a[i]! - ma) ** 2;
  let best = -1, at = 0;
  for (let lag = 0; lag + n <= b.length; lag++) {
    const mb = mean(b, lag);
    let dot = 0, normB = 0;
    for (let i = 0; i < n; i++) { const y = b[lag + i]! - mb; dot += (a[i]! - ma) * y; normB += y * y; }
    const r = dot / Math.sqrt(normA * normB || 1);
    if (r > best) { best = r; at = lag; }
  }
  return { at: guess - search + at / 1000, r: best };
}

function clip(source: string, ranges: readonly Range[], out: string) {
  if (!ranges.length) throw new Error("Nothing plays there.");
  const fade = 0.01;
  const parts = ranges.map((r, i) => `[0:a]atrim=${r.start.toFixed(3)}:${r.end.toFixed(3)},asetpts=PTS-STARTPTS,` +
    `afade=t=in:d=${fade},afade=t=out:st=${Math.max(0, r.end - r.start - fade).toFixed(3)}:d=${fade}[p${i}]`);
  const graph = `${parts.join(";")};${ranges.map((_, i) => `[p${i}]`).join("")}concat=n=${ranges.length}:v=0:a=1[a]`;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", source, "-filter_complex", graph, "-map", "[a]", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "24k", out]);
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
      ...shuffled(runs(point.detail.leftIn.filter(x => x.words >= 6 && !x.retake && !x.otherTake)).map(x => ({ kind: "content" as const, ...x })), opts.seed).slice(0, Math.ceil(opts.perVideo / 2)),
      // Checks not yet scored: every flag of theirs, since they are few, so the next sheet says how many are real.
      ...(point.detail.joins?.doubled ?? []).map(j => ({ kind: "doubled" as const, at: j.at, end: j.at, text: j.text })),
      ...(point.detail.joins?.halfSentence ?? []).map(j => ({ kind: "half" as const, at: j.at, end: j.at, text: j.text })),
    ];
    const words = (loaded.evidence.get(mediaId)?.words ?? []).filter(w => w.text.trim()).slice().sort((a, b) => a.start - b.start);
    const scarletKept = merge(kept.get(mediaId) ?? [], 0.001), editorKept = merge(published.kept[mediaId] ?? [], 0.001);
    const own = published.pieces.filter(x => x.mediaId === mediaId);
    const pieceAt = (t: number) => own.find(x => x.sourceStart <= t && t <= x.sourceEnd);
    const finalAt = (t: number) => { const x = pieceAt(t); return x && x.finalStart + (t - x.sourceStart) / x.rate; };
    const publishedWords = published.played.filter(w => w.text.trim());
    for (const p of picks) {
      const id = `${caseId}-${p.kind}-${Math.round(p.at * 10)}`;
      const long = p.kind === "retake" || p.kind === "content";
      // Both clips start on a word both cuts play just before the spot. Where the editor cut all around it, Scarlet's
      // clip starts on a word it plays, and the editor's is where their video picks up.
      const rangeOf = (kept: readonly Range[], w: Word) => kept.findIndex(r => r.start <= w.start + 0.02 && w.end - 0.02 <= r.end);
      const together = (a: Word, b: Word) => rangeOf(scarletKept, a) === rangeOf(scarletKept, b) && rangeOf(editorKept, a) === rangeOf(editorKept, b) &&
        pieceAt(a.start) === pieceAt(b.start);
      const lead = sharedLeadIn(words, scarletKept, editorKept, p.at, t => !!pieceAt(t), together);
      const shared = lead?.first;
      const anchor = shared ?? sharedLeadIn(words, scarletKept, undefined, p.at, () => true, (a, b) => rangeOf(scarletKept, a) === rangeOf(scarletKept, b))?.first;
      const from = anchor ? anchor.start - 0.12 : undefined;
      const startClock = from !== undefined ? clockOf(scarletKept, from) : Math.max(0, clockOf(scarletKept, p.at) - 3);
      const offset = clockOf(scarletKept, p.at) - startClock;
      const runSeconds = long ? clockOf(scarletKept, p.end) - clockOf(scarletKept, p.at) : undefined;
      const seconds = Math.min(30, offset + (long ? runSeconds! + 2.5 : 4));
      const scarlet = `clips/${id}-scarlet.m4a`;
      const ranges = from !== undefined ? playedAround(scarletKept, from, 0, seconds) : playedAround(scarletKept, p.at, offset, seconds - offset);
      clip(recording, endBetweenWords(ranges, words), join(out, scarlet));
      let editor: string | undefined, editorOffset: number | undefined;
          // The word match places the shared word to a few tenths of a second; its sound places it exactly.
      const guess = shared ? finalAt(shared.start) : undefined;
      // The words both play from the start of the lead-in to its last word are the same sound in both files.
      const sharedSeconds = lead ? lead.last.end - lead.first.start : 0;
      const heard = shared && publishedFile && guess !== undefined && sharedSeconds >= 0.6
        ? alignBySound(recording, shared.start, publishedFile, guess, Math.min(3, sharedSeconds)) : undefined;
      // Where the word match tied none of the stretch to the published video, its own words may still be there: a line
      // said over and over loses the matcher (2026-11-20). Look for Scarlet's lead-in words in the published words, and
      // keep the place whose sound matches. Only where neither is found did the editor cut the stretch: then no clip,
      // since one of other words was taken for the same moment.
      let found: number | undefined;
      if (!shared && publishedFile && anchor) {
        const solo = sharedLeadIn(words, scarletKept, undefined, p.at, () => true, (a, b) => rangeOf(scarletKept, a) === rangeOf(scarletKept, b));
        const said = solo ? words.filter(w => w.start >= solo.first.start && w.end <= solo.last.end).map(w => tokenOf(w.text)).filter(Boolean) : [];
        const heardWords = publishedWords.map(w => tokenOf(w.text));
        const seconds = solo ? Math.min(3, solo.last.end - solo.first.start) : 0;
        if (said.length >= 4 && seconds >= 0.6) {
          const best = heardWords.flatMap((_, i) => said.slice(0, 4).every((t, k) => heardWords[i + k] === t) ? [publishedWords[i]!.start] : [])
            .slice(0, 8).map(c => matchSound(recording, solo!.first.start, publishedFile, c, seconds, 0.5)).filter(x => !!x)
            .sort((x, y) => y!.r - x!.r)[0];
          if (best && best.r >= 0.6) found = best.at;
        }
      }
      const editorFrom = shared ? heard ?? guess : found;
      if (publishedFile && editorFrom !== undefined) {
        editor = `clips/${id}-editor.m4a`;
        const start = Math.max(0, editorFrom - 0.12);
        // Where the editor's video reaches the same point: the spot itself when it plays it, else where its cut lands.
        // Found by its words and sound, the editor's video plays the same lead-in, so the spot is as far in as in Scarlet's.
        const reached = found !== undefined ? start + offset : shared && guess !== undefined && finalAt(p.at) !== undefined
          ? finalAt(p.at)! + (editorFrom - guess) : finalAt(p.at) ?? publishedAt(published.pieces, mediaId, p.at);
        editorOffset = reached !== undefined && reached >= start ? reached - start : undefined;
        const span = Math.min(30, (editorOffset ?? offset) + (p.kind === "wrong" ? p.end - p.at + 4 : 4));
        const played = publishedWords.map(w => ({ text: w.text, start: w.start, end: w.end }));
        clip(publishedFile, endBetweenWords([{ start, end: start + span }], played), join(out, editor));
      }
      spots.push({ id, kind: p.kind, caseId, mediaId, at: p.at, end: p.end, text: p.text, scarlet, editor,
        offset: Math.round(offset * 10) / 10, ...(lead && { sharedSeconds: Math.round((lead.last.end - lead.first.start) * 10) / 10 }), ...(editorOffset !== undefined && { editorOffset: Math.round(editorOffset * 10) / 10 }),
        ...(!shared && found === undefined && { editorCut: true as const }),
        ...(editor && shared && heard === undefined && { editorApprox: true as const }),
        ...(runSeconds !== undefined && { runSeconds: Math.round(runSeconds * 10) / 10 }) });
    }
  } } finally {
    if (before === undefined) delete process.env.SCARLET_EVAL_DATA; else process.env.SCARLET_EVAL_DATA = before;
  }
  const sheet = shuffled(spots, opts.seed);
  writeJson(join(out, "spots.json"), sheet, out);
  return { spots: sheet.length, page: writePage(out) };
}

/**
 * The sheet's page, with every clip inside it as data, so it plays wherever it is opened: a viewer that shows one file
 * can't fetch the clips beside it, and the page played nothing there (2026-11-20).
 */
export function writePage(dir: string): string {
  const spots = readJson<Spot[]>(join(dir, "spots.json"));
  const inline = (path: string) => `data:audio/mp4;base64,${readFileSync(join(dir, path)).toString("base64")}`;
  const page = join(dir, "index.html");
  writeText(page, sheetHtml(spots, inline), dir);
  return page;
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

function sheetHtml(spots: readonly Spot[], src: (path: string) => string = p => p): string {
  const at = (t: number) => `0:${String(Math.floor(t)).padStart(2, "0")}`;
  // What to listen for, and where: the clips start on the same words, a few seconds before the spot.
  const where = (s: Spot) => {
    const t = s.offset ?? 0;
    switch (s.kind) {
      case "midword": case "control": return `Listen to Scarlet's join at <b>${at(t)}</b>. Does it chop off a word or a sound there?`;
      case "doubled": return `Listen to Scarlet's join at <b>${at(t)}</b>. Does a word play twice there, whole or begun?`;
      case "half": return `Listen to Scarlet's join at <b>${at(t)}</b>. Does it leave a sentence half said?`;
      case "wrong": return `At <b>${at(t)}</b> Scarlet jumps over words your editor kept (below). Is leaving them out a mistake?`;
      case "retake": return `From <b>${at(t)}</b> to <b>${at(t + (s.runSeconds ?? 0))}</b> Scarlet plays a line your editor cut for another take. Does a line play twice, or a restart stay in?`;
      case "content": return `From <b>${at(t)}</b> to <b>${at(t + (s.runSeconds ?? 0))}</b> Scarlet plays a passage your editor cut (below). Should a dialogue pass have taken it out?`;
    }
  };
  const player = (label: string, path: string, t: number | undefined) =>
    `<div class="clip"><span>${label}</span><audio controls preload="none" src="${src(path)}"></audio>` +
    (t === undefined ? "" : `<button class="jump" data-t="${Math.max(0, t - 1.5).toFixed(1)}">Play from ${at(Math.max(0, t - 1.5))}</button>`) + `</div>`;
  const rows = spots.map((s, i) => `
<section data-id="${esc(s.id)}">
  <h2>${i + 1} of ${spots.length} <span>${esc(s.caseId)} · ${clock(s.at)} in the recording</span></h2>
  <p class="q">${where(s)}</p>
  ${s.kind === "midword" || s.kind === "control" ? "" : `<p class="words">${s.kind === "wrong" ? "Words Scarlet took out, so they're not in its clip" : s.kind === "doubled" || s.kind === "half" ? "The words either side of the join (‖), by the transcript" : "What Scarlet keeps there"}:
    “${esc(s.text.slice(0, 220))}${s.text.length > 220 ? "…" : ""}”</p>`}
  <div class="clips">${player("Scarlet", s.scarlet, s.offset)}
  ${s.editor ? player(s.editorApprox ? "Your editor, around the same words (couldn't line up exactly)" : "Your editor, same words first", s.editor, s.editorOffset)
    : `<div class="clip"><span>${s.editorCut ? (s.kind === "wrong" ? "Your editor's version of these words couldn't be found in their video, so there's no clip of it. Judge Scarlet's clip on its own." : "Your editor cut this whole stretch, so there's nothing of theirs to compare. Judge Scarlet's clip on its own.") : "No clip of your editor's version here."}</span></div>`}</div>
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
.clips{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:10px}.clip{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--dim)}
.clip .jump{align-self:flex-start;font-size:13px;padding:3px 10px}.q b{color:var(--on)}
audio{width:300px;max-width:100%}
.answer{display:flex;flex-wrap:wrap;gap:8px}
button{background:none;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 12px;font:inherit;cursor:pointer}
button.on{border-color:var(--on);background:var(--on);color:var(--bg)}
#saved{display:none;width:100%;height:120px;margin-top:8px;background:none;color:var(--fg);border:1px solid var(--line);border-radius:6px;font:12px ui-monospace,monospace}
footer{position:fixed;left:0;right:0;bottom:0;background:var(--bg);border-top:1px solid var(--line);padding:12px 16px;display:flex;gap:12px;align-items:center;justify-content:center}
#done{color:var(--dim)}#save.ready{border-color:var(--green);color:var(--green)}
</style></head><body><main>
<h1>Flag check</h1>
<p class="lead">${spots.length} spots the eval flagged, and a few it didn't. Each spot says where to listen in Scarlet's clip; the button plays from just before it. Your editor's clip starts on the same words, so you can hear how they handled the same moment. Answer about Scarlet's clip only. Clips are rebuilt from the cut with a tiny fade, not rendered by Scarlet. Answers are kept in this browser until you save them. If saving doesn't download a file, copy the answers from the box that opens and paste them back.</p>
${rows}
<textarea id="saved" readonly></textarea>
</main><footer><span id="done"></span><button id="save">Save answers</button></footer>
<script>
const KEY = "flag-check:" + location.pathname;
let answers = {};
try { answers = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch {}
const sections = [...document.querySelectorAll("section")];
function paint() {
  for (const s of sections) for (const b of s.querySelectorAll(".answer button")) b.classList.toggle("on", answers[s.dataset.id] === b.dataset.v);
  const n = Object.keys(answers).length;
  document.getElementById("done").textContent = n + " of " + sections.length + " answered";
  document.getElementById("save").classList.toggle("ready", n === sections.length);
}
for (const s of sections) for (const b of s.querySelectorAll(".answer button")) b.addEventListener("click", () => {
  answers[s.dataset.id] = b.dataset.v;
  try { localStorage.setItem(KEY, JSON.stringify(answers)); } catch {}
  paint();
});
for (const b of document.querySelectorAll(".jump")) b.addEventListener("click", () => {
  const a = b.parentElement.querySelector("audio");
  const go = () => { a.currentTime = Number(b.dataset.t); a.play(); };
  if (a.readyState >= 1) go(); else { a.preload = "auto"; a.addEventListener("loadedmetadata", go, { once: true }); a.load(); }
});
for (const a of document.querySelectorAll("audio")) a.addEventListener("play", () => { for (const o of document.querySelectorAll("audio")) if (o !== a) o.pause(); });
document.getElementById("save").addEventListener("click", () => {
  const text = JSON.stringify({ schema: 1, answeredAt: new Date().toISOString(), answers }, null, 2);
  // Some viewers block downloads: the answers also show in a box to copy from.
  const box = document.getElementById("saved");
  box.value = text; box.style.display = "block"; box.select();
  try { navigator.clipboard && navigator.clipboard.writeText(text).catch(() => {}); } catch {}
  try {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "application/json" })); link.download = "answers.json"; link.click();
  } catch {}
});
paint();
</script></body></html>
`;
}

/** For each kind of flag, how many spots the listener called real. Unflagged joins say how often a clean join is called wrong. */
export function scoreAnswers(spots: readonly Spot[], answers: Record<string, string>) {
  const kinds: Kind[] = ["midword", "control", "wrong", "retake", "content", "doubled", "half"];
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
  if (command === "page" && target) {
    console.log(`Rewrote ${writePage(resolve(target))}`);
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

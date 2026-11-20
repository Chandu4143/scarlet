/**
 * A cut read against the editor's own, decision by decision. Word counts flatter a pass: most of what comes out of a
 * raw recording is long retakes and production talk that any cut removes, so the few dozen hard calls vanish in the
 * thousands of easy words. Here each run of removed words is one decision however long it is, each pause either
 * editor could trim is one pause, and each line said twice is one choice of take.
 *
 * Pure: the scorecard feeds it a recording's words and what each cut kept of it, in source seconds.
 */
import { findRestarts } from "../../packages/shared/src/restarts.ts";
import { covered, merge, type Range } from "./intervals.ts";
import { labelWords, type Label, type Word } from "./metrics.ts";

/** A pause shorter than this is the space between words, not a pause anyone trims. */
export const PAUSE_SECONDS = 0.4;
/** A piece shorter than this between two cuts plays as a stutter. */
export const STUTTER_SECONDS = 1;
/** A run of this many words or more that one cut plays and the other doesn't is one a viewer would notice. */
export const NOTICED_WORDS = 2;
/** A run of this many words or more that Scarlet left in and the editor cut is a clear missed removal, not a brief tightening. */
export const LONG_MISSED_WORDS = 6;

/**
 * Words said again within this many seconds are another take of the same line: a long retake can come a minute later,
 * and a short restart within a breath or two. A run of fewer than LONG_RUN words takes the short reach.
 */
export const OTHER_TAKE_SECONDS = { long: 60, short: 15 } as const;
const LONG_RUN = 4;
/** Of a run's words, the share another take must say in the same order to be the same line. Two words must match exactly. */
const SAME_LINE = 0.8;
/** A hesitation sound is no word of the line: it doesn't make two takes differ. */
const HESITATION = /^(u+h+m*|u+m+|e+r+m*|a+h+|h+m+|m+h*m*|e+h+)$/u;

/** Consecutive in-scope words one cut removed and the other kept: `words` long, from `start` to `end`. */
export interface Disagreement extends Range {
  words: number; text: string;
  /**
   * The same words still play from another take of them nearby: Scarlet kept one saying and the editor another, or
   * Scarlet took out a repeat the editor left in. The viewer hears the line either way, so it is a choice of take,
   * not a line lost or a passage left in. Of the 111 runs twenty passes of one model were marked down for as cut though
   * the editor kept them, 71 were another saying of words the pass still played, such as “it is a very good model. It is
   * a very good model” (2026-11-20).
   */
  otherTake?: true;
}

export interface CutDetail {
  /** Removals as decisions: a run of words a cut takes out, one decision whatever its length. */
  decisions: {
    editor: number; scarlet: number;
    /** The editor's removals Scarlet made too (it cut at least half their words), and Scarlet's the editor made too. */
    editorMatched: number; scarletMatched: number;
  };
  /** Runs Scarlet cut that the editor kept, and runs Scarlet left in that the editor cut. */
  wronglyCut: Disagreement[];
  leftIn: Disagreement[];
  /** Pauses of PAUSE_SECONDS or more between two words both cuts play. */
  pauses: { total: number; editorTrimmed: number; scarletTrimmed: number; bothTrimmed: number };
  /** Lines said twice where the editor kept one delivery: whether Scarlet kept the same one. */
  takes: { decided: number; same: number; other: number; both: number; neither: number };
  /** Pieces between two of Scarlet's cuts that play for under STUTTER_SECONDS. */
  pieces: { total: number; short: number; editorTotal: number; editorShort: number };
}

const text = (ws: readonly Word[]) => ws.map(w => w.text.trim()).join(" ");
const tokenOf = (w: Word) => w.text.trim().toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
const said = (t: string) => !!t && !HESITATION.test(t);

/** Length of the longest common subsequence of two token lists. */
function common(a: readonly string[], b: readonly string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    const next = [0];
    for (let j = 0; j < b.length; j++) next.push(x === b[j] ? prev[j]! + 1 : Math.max(prev[j + 1]!, next[j]!));
    prev = next;
  }
  return prev[b.length]!;
}

/**
 * Whether the words of run [a, b) are said again nearby by words `plays` accepts: the same words in the same order,
 * all of them for a run of one or two, SAME_LINE of them for a longer one, with a word or two between allowed.
 */
function saidNearby(sorted: readonly Word[], tokens: readonly string[], [a, b]: [number, number], plays: (i: number) => boolean): boolean {
  const line = tokens.slice(a, b).filter(said);
  if (!line.length) return false;
  const reach = line.length >= LONG_RUN ? OTHER_TAKE_SECONDS.long : OTHER_TAKE_SECONDS.short;
  const from = sorted[a]!.start - reach, to = sorted[b - 1]!.end + reach;
  const near: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if ((i >= a && i < b) || sorted[i]!.end < from || sorted[i]!.start > to || !plays(i) || !said(tokens[i]!)) continue;
    near.push(tokens[i]!);
  }
  const need = line.length <= 2 ? line.length : Math.ceil(SAME_LINE * line.length);
  const opens = new Set(line.slice(0, line.length - need + 1));
  for (let p = 0; p + need <= near.length; p++) {
    if (opens.has(near[p]!) && common(line, near.slice(p, p + line.length + 2)) >= need) return true;
  }
  return false;
}

/** Maximal runs of consecutive words (by index in `labels`) for which `pick` holds; a word out of scope ends a run. */
function runs(labels: ReadonlyArray<Label | undefined>, pick: (i: number) => boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let from = -1;
  for (let i = 0; i <= labels.length; i++) {
    const on = i < labels.length && labels[i] !== undefined && pick(i);
    if (on && from < 0) from = i;
    if (!on && from >= 0) { out.push([from, i]); from = -1; }
  }
  return out;
}

const share = (labels: ReadonlyArray<Label | undefined>, [a, b]: [number, number], label: Label) => {
  let n = 0;
  for (let i = a; i < b; i++) if (labels[i] === label) n++;
  return n / (b - a);
};

/** Pieces a cut plays, and how many are short: the first and last piece of a recording aren't between two cuts. */
function pieces(kept: readonly Range[]) {
  const ps = merge(kept, 0.001);
  return { total: ps.length, short: ps.slice(1, -1).filter(p => p.end - p.start < STUTTER_SECONDS).length };
}

/**
 * One recording. `base` is what the source version plays of it, `scarlet` what the pass left, `editor` what the
 * published video kept. A word is kept by a cut that plays at least half of it.
 */
export function cutDetail(words: readonly Word[], base: readonly Range[], scarlet: readonly Range[], editor: readonly Range[]): CutDetail {
  const sorted = words.filter(w => w.text.trim()).slice().sort((a, b) => a.start - b.start);
  const s = labelWords(sorted, base, scarlet), e = labelWords(sorted, base, editor);
  const cutBy = (l: ReadonlyArray<Label | undefined>) => runs(l, i => l[i] === "cut");
  const editorCuts = cutBy(e), scarletCuts = cutBy(s);
  const span = ([a, b]: [number, number]): Disagreement => ({ start: sorted[a]!.start, end: sorted[b - 1]!.end, words: b - a, text: text(sorted.slice(a, b)) });

  // Pauses both cuts could have trimmed: between two neighbouring words each of them plays.
  const sKept = merge(scarlet), eKept = merge(editor);
  const whole = (kept: readonly Range[], gap: Range) => covered(gap, kept) >= (gap.end - gap.start) - 0.02;
  const pauses = { total: 0, editorTrimmed: 0, scarletTrimmed: 0, bothTrimmed: 0 };
  for (let i = 0; i + 1 < sorted.length; i++) {
    if (s[i] !== "keep" || s[i + 1] !== "keep" || e[i] !== "keep" || e[i + 1] !== "keep") continue;
    const gap = { start: sorted[i]!.end, end: sorted[i + 1]!.start };
    if (gap.end - gap.start < PAUSE_SECONDS) continue;
    const byEditor = !whole(eKept, gap), byScarlet = !whole(sKept, gap);
    pauses.total++;
    if (byEditor) pauses.editorTrimmed++;
    if (byScarlet) pauses.scarletTrimmed++;
    if (byEditor && byScarlet) pauses.bothTrimmed++;
  }

  // A line said twice: the editor chose a take where it kept one delivery and cut the other.
  const tokens = sorted.map(tokenOf);
  const takes = { decided: 0, same: 0, other: 0, both: 0, neither: 0 };
  for (const r of findRestarts(tokens, sorted.map(w => w.start), sorted.map(w => w.end))) {
    if (r.length < 2) continue;
    const first: [number, number] = [r.at, r.at + r.length], second: [number, number] = [r.next, r.next + r.length];
    if (second[1] > sorted.length || [...Array(r.length)].some((_, k) => e[first[0] + k] === undefined || e[second[0] + k] === undefined)) continue;
    const kept = (l: ReadonlyArray<Label | undefined>, t: [number, number]) => share(l, t, "keep") >= 0.5;
    const eFirst = kept(e, first), eSecond = kept(e, second);
    if (eFirst === eSecond) continue;
    const sFirst = kept(s, first), sSecond = kept(s, second);
    takes.decided++;
    if (sFirst && sSecond) takes.both++;
    else if (!sFirst && !sSecond) takes.neither++;
    else if (sFirst === eFirst) takes.same++;
    else takes.other++;
  }

  const mine = pieces(scarlet), theirs = pieces(editor);
  return {
    decisions: {
      editor: editorCuts.length, scarlet: scarletCuts.length,
      editorMatched: editorCuts.filter(r => share(s, r, "cut") >= 0.5).length,
      scarletMatched: scarletCuts.filter(r => share(e, r, "cut") >= 0.5).length,
    },
    // Cut, and still heard: Scarlet plays the words from another saying of them.
    wronglyCut: runs(s, i => s[i] === "cut" && e[i] === "keep").map(r => ({ ...span(r),
      ...(saidNearby(sorted, tokens, r, i => s[i] === "keep") && { otherTake: true as const }) })),
    // Left in, and the editor plays the same words from a saying Scarlet cut: a swap of takes. Words the editor plays
    // that Scarlet plays too would mean Scarlet plays the line twice, which is a restart left in.
    leftIn: runs(s, i => s[i] === "keep" && e[i] === "cut").map(r => ({ ...span(r),
      ...(saidNearby(sorted, tokens, r, i => e[i] === "keep" && s[i] === "cut") && { otherTake: true as const }) })),
    pauses, takes,
    pieces: { total: mine.total, short: mine.short, editorTotal: theirs.total, editorShort: theirs.short },
  };
}

/** Several recordings of one cut, added up. */
export function addCutDetails(parts: readonly CutDetail[]): CutDetail {
  const sum = <T extends Record<string, number>>(pick: (d: CutDetail) => T): T =>
    parts.reduce((acc, d) => { for (const [k, v] of Object.entries(pick(d))) (acc as Record<string, number>)[k] = ((acc as Record<string, number>)[k] ?? 0) + v; return acc; }, {} as T);
  return { decisions: sum(d => d.decisions), wronglyCut: parts.flatMap(d => d.wronglyCut), leftIn: parts.flatMap(d => d.leftIn),
    pauses: sum(d => d.pauses), takes: sum(d => d.takes), pieces: sum(d => d.pieces) };
}

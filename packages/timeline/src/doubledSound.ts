import type { MediaAsset, MediaClip, Timeline, TimeRange } from "./schema.js";
import { clipEnd, timelineToSource } from "./time.js";

/** Two audible clips playing the same moment of the same recording at once, which the mix sums. */
export interface DoubledSound {
  mediaId: string;
  clipIds: [string, string];
  /** Timeline seconds where both play. */
  overlap: TimeRange;
  /** Seconds of the recording both play there. */
  source: TimeRange;
}

/** Copies an edit made louder: their volumes add up in the mix to more than the edit's base played there. */
export interface LouderDoubledSound extends DoubledSound {
  /**
   * The combined linear gain the copies play at, where it's furthest above the base, and what the base played that
   * moment of the recording at: its own layering, its loudest clip, or for a moment it didn't play, the louder of unity
   * and the loudest single copy.
   */
  level: { before: number; after: number };
}

// The two copies line up to well under an audio sample at 48 kHz. Any farther apart is an offset someone placed, which
// can be shorter than a frame, so a frame is far too coarse a test.
const SAME_MOMENT = 1e-5;
// Shorter than half a sample at 48 kHz plays nothing.
const PLAYS = 0.5 / 48_000;
// Gains closer than this are the same level.
const SAME_LEVEL = 1e-6;

type Audio = Pick<MediaAsset, "id" | "kind" | "hasAudio">;
interface Heard { clip: MediaClip; start: number; end: number; source: TimeRange }
interface Pair { mediaId: string; a: Heard; b: Heard; overlap: TimeRange; source: TimeRange }
interface Layering { heard: Map<string, Heard[]>; pairs: Pair[] }

/** The clips the renderer mixes: enabled media with sound, at a volume above zero, on an unmuted video or audio track. */
function heardClips(timeline: Timeline, media: ReadonlyMap<string, Audio>): Map<string, Heard[]> {
  const byMedia = new Map<string, Heard[]>();
  for (const track of timeline.tracks) {
    if (track.kind === "caption" || track.muted) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "media" || clip.enabled === false || !(clip.volume > 0)) continue;
      const asset = media.get(clip.mediaId);
      if (!asset || (asset.kind !== "video" && asset.kind !== "audio") || asset.hasAudio === false) continue;
      const heard = byMedia.get(clip.mediaId) ?? [];
      const start = clip.timelineIn, end = clipEnd(clip);
      heard.push({ clip, start, end, source: { start: timelineToSource(clip, start), end: timelineToSource(clip, end) } });
      byMedia.set(clip.mediaId, heard);
    }
  }
  return byMedia;
}

/** A crossfade overlaps its clips while one fades out and the other fades in, which is a join and not a second copy. */
function crossfades(a: Heard, b: Heard, overlap: TimeRange): boolean {
  const [first, second] = a.start <= b.start ? [a, b] : [b, a];
  return overlap.start >= first.end - first.clip.audioFadeOut - PLAYS && overlap.end <= second.start + second.clip.audioFadeIn + PLAYS;
}

/** Every pair of audible clips that play the same moment of the same recording together, at the same speed. */
function layering(timeline: Timeline, media: ReadonlyMap<string, Audio>): Layering {
  const heardBy = heardClips(timeline, media);
  const pairs: Pair[] = [];
  for (const [mediaId, heard] of heardBy) {
    heard.sort((a, b) => a.start - b.start);
    for (let i = 0; i < heard.length; i++) {
      const a = heard[i]!;
      // Sorted by start, so the first clip that starts after this one ends ends the clips it can overlap.
      for (let j = i + 1; j < heard.length && heard[j]!.start < a.end - PLAYS; j++) {
        const b = heard[j]!;
        const overlap = { start: b.start, end: Math.min(a.end, b.end) };
        if (overlap.end - overlap.start < PLAYS) continue;
        if (Math.abs((a.clip.speed ?? 1) - (b.clip.speed ?? 1)) > 1e-9) continue;
        // Where the overlap starts, both clips play the same second of the recording.
        if (Math.abs(timelineToSource(a.clip, overlap.start) - timelineToSource(b.clip, overlap.start)) > SAME_MOMENT) continue;
        if (crossfades(a, b, overlap)) continue;
        pairs.push({ mediaId, a, b, overlap, source: { start: timelineToSource(a.clip, overlap.start), end: timelineToSource(a.clip, overlap.end) } });
      }
    }
  }
  return { heard: heardBy, pairs };
}

function described(p: Pair): DoubledSound {
  return { mediaId: p.mediaId, clipIds: [p.a.clip.id, p.b.clip.id], overlap: { start: round3(p.overlap.start), end: round3(p.overlap.end) },
    source: { start: round3(p.source.start), end: round3(p.source.end) } };
}

/** Every pair of audible clips that play the same moment of the same recording together, at the same speed. */
export function doubledSound(timeline: Timeline, media: Iterable<Audio>): DoubledSound[] {
  return layering(timeline, new Map([...media].map(m => [m.id, m] as const))).pairs.map(described);
}

const covers = (range: TimeRange, at: number) => range.start <= at && range.end > at;

/**
 * How one recording plays its second `at`: each set of copies in sync there, with their volumes added up as the mix
 * does, and the loudest clip playing it at all.
 */
function playedAt(heard: readonly Heard[], pairs: readonly Pair[], at: number) {
  const playing = heard.filter(h => covers(h.source, at));
  const loudest = Math.max(0, ...playing.map(h => h.clip.volume));
  // Pairs chain into the copies in sync with each other: a and b, and b and c, are three copies of one moment.
  const group = new Map<Heard, Heard>();
  const root = (h: Heard): Heard => { const up = group.get(h) ?? h; return up === h ? h : root(up); };
  const layered = pairs.filter(p => covers(p.source, at));
  for (const p of layered) group.set(root(p.a), root(p.b));
  const stacks = new Map<Heard, { level: number; pairs: Pair[] }>();
  for (const h of new Set(layered.flatMap(p => [p.a, p.b]))) {
    const stack = stacks.get(root(h)) ?? { level: 0, pairs: [] };
    stack.level += h.clip.volume;
    stacks.set(root(h), stack);
  }
  for (const p of layered) stacks.get(root(p.a))!.pairs.push(p);
  return { played: playing.length > 0, loudest, stacks: [...stacks.values()] };
}

/**
 * Sound `next` plays louder than `before` did by layering copies of it: wherever copies of one moment of a recording
 * play in sync, their volumes add up, and that's compared against what `before` played that moment of the recording at,
 * wherever on the timeline it was. Splitting, rippling or moving copies layered on purpose leaves their level, so they
 * aren't reported, and nor is one clip's own volume. Where a stack is louder, the pairs `before` didn't have are the ones
 * reported: an edit that only turns up copies `before` already layered is reported by those pairs.
 */
export function introducedDoubledSound(before: Timeline | null, next: Timeline, media: Iterable<Audio>): LouderDoubledSound[] {
  const assets = new Map([...media].map(m => [m.id, m] as const));
  const was: Layering = before ? layering(before, assets) : { heard: new Map(), pairs: [] };
  const now = layering(next, assets);
  const louder = new Map<Pair, { before: number; after: number }>();
  for (const mediaId of new Set(now.pairs.map(p => p.mediaId))) {
    const nowPairs = now.pairs.filter(p => p.mediaId === mediaId), wasPairs = was.pairs.filter(p => p.mediaId === mediaId);
    const nowHeard = now.heard.get(mediaId) ?? [], wasHeard = was.heard.get(mediaId) ?? [];
    // Every second of the recording a clip or a pair starts or stops playing; between two, nothing changes.
    const edges = [...nowPairs, ...wasPairs, ...nowHeard, ...wasHeard].flatMap(r => [r.source.start, r.source.end]).sort((a, b) => a - b);
    for (let i = 1; i < edges.length; i++) {
      if (edges[i]! - edges[i - 1]! < PLAYS) continue;
      const at = (edges[i - 1]! + edges[i]!) / 2;
      const n = playedAt(nowHeard, nowPairs, at);
      if (!n.stacks.length) continue;
      const w = playedAt(wasHeard, wasPairs, at);
      const base = w.played ? Math.max(w.loudest, ...w.stacks.map(s => s.level)) : Math.max(1, n.loudest);
      for (const stack of n.stacks) {
        if (stack.level <= base + SAME_LEVEL) continue;
        for (const p of stack.pairs) {
          const had = louder.get(p);
          if (!had || stack.level - base > had.after - had.before) louder.set(p, { before: base, after: stack.level });
        }
      }
    }
  }
  const key = (a: string, b: string) => [a, b].sort().join(" ");
  const oldPairs = new Set(was.pairs.map(p => key(p.a.clip.id, p.b.clip.id)));
  const isNew = (p: Pair) => !oldPairs.has(key(p.a.clip.id, p.b.clip.id));
  const found = now.pairs.filter(p => louder.has(p));
  // A pair `before` already had is reported only when no new pair layers the same stretch: that one is the addition.
  return found.filter(p => isNew(p) || !found.some(o => isNew(o) && o.mediaId === p.mediaId &&
    o.source.start < p.source.end && o.source.end > p.source.start))
    .map(p => { const l = louder.get(p)!; return { ...described(p), level: { before: round3(l.before), after: round3(l.after) } }; });
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

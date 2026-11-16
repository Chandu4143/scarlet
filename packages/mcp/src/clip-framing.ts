import { clipEnd, type Clip, type MediaAsset, type MediaClip, type Timeline, type Transform, type TransformKeyframe } from "@scarlet/timeline";

/** A clip an edit added that plays its recording full frame, beside a clip of the same recording that is framed. */
export interface UnframedClip {
  clipId: string;
  trackId: string;
  /** Where the added clip starts, in seconds on the edited timeline. */
  at: number;
  /** The framed clip beside it on the same track, and its framing. */
  beside: { clipId: string; transform?: Transform; keyframes?: TransformKeyframe[] };
}

const framed = (clip: MediaClip) => !!clip.transform || !!clip.keyframes?.length;

/**
 * Footage an edit puts back or copies arrives as new clips, which play their recording full frame unless the edit
 * frames them. Beside clips of the same recording that are zoomed or inset, that shows as a jump: a speed-up put a
 * 16 s wait back with the camera filling the frame and the screen unzoomed, between clips with the camera in the corner
 * (2026-11-15), and a cold open's first draft did the same. The agent reads this as evidence; whether the new clip
 * should match is its call.
 */
export function unframedBeside(before: Timeline | null, after: Timeline): UnframedClip[] {
  const existing = new Set(before?.tracks.flatMap(t => t.clips.map(c => c.id)) ?? []);
  const found: UnframedClip[] = [];
  for (const track of after.tracks) {
    if (track.kind !== "video") continue;
    const clips = track.clips.filter((c): c is MediaClip => c.kind === "media" && c.enabled !== false)
      .sort((a, b) => a.timelineIn - b.timelineIn);
    clips.forEach((clip, i) => {
      if (existing.has(clip.id) || framed(clip)) return;
      const near = [clips[i - 1], clips[i + 1]].find(c => c && c.mediaId === clip.mediaId && framed(c));
      if (!near) return;
      found.push({ clipId: clip.id, trackId: track.id, at: Math.round(clip.timelineIn * 1000) / 1000,
        beside: { clipId: near.id, ...(near.transform && { transform: near.transform }), ...(near.keyframes?.length && { keyframes: near.keyframes }) } });
    });
  }
  return found;
}

export const UNFRAMED_NEXT = "Each clip in unframedBeside was added by this edit and plays its recording full frame, while the clip beside it on its track, from the same recording, is framed as shown. If it should look the same, give it that transform (and keyframes) with updateClip.";

/** A stretch of a version where its pictures leave part of the frame to the background. */
export interface BackgroundSpan {
  /** Seconds on the version. */
  from: number;
  to: number;
  /** The share of the frame no picture covers, 0 to 1. */
  share: number;
  /** The clips whose pictures play there. */
  clipIds: string[];
}
export interface BackgroundShowing {
  /** How long the version plays with part of the frame empty, of its whole length. */
  seconds: number;
  of: number;
  /** The least and the most of the frame left empty over those seconds. */
  share: { least: number; most: number };
  /** The longest stretches, in playing order. `more` counts the ones left out. */
  spans: BackgroundSpan[];
  more?: number;
}

type Box = { left: number; top: number; right: number; bottom: number };
type Canvas = { width: number; height: number };
type Sized = Pick<MediaAsset, "id" | "kind" | "width" | "height" | "hasAlpha">;

/** Shares under a hundredth of the frame are a crop's rounding, not a picture that leaves the frame empty. */
const SHARE_FLOOR = 0.01;
const LISTED_SPANS = 8;

/**
 * Where a clip's picture sits in the frame, as fractions of it: cropped, fitted inside the frame, scaled, then moved
 * (the renderer's order, `transformChain`). Undefined for a picture that can't be placed from its numbers alone: one
 * that moves or turns, or one that doesn't cover what is under it.
 */
function pictureBox(clip: Clip, media: Map<string, Sized>, canvas: Canvas): Box | undefined {
  if (clip.kind === "color") return { left: 0, top: 0, right: 1, bottom: 1 };
  if (clip.kind !== "media") return undefined;
  const asset = media.get(clip.mediaId);
  if (!asset || asset.kind === "audio" || asset.hasAlpha || !asset.width || !asset.height) return undefined;
  const t = clip.transform;
  if (clip.keyframes?.length || t?.rotation) return undefined;
  const kept = { w: Math.max(0.01, 1 - (t?.cropLeft ?? 0) - (t?.cropRight ?? 0)), h: Math.max(0.01, 1 - (t?.cropTop ?? 0) - (t?.cropBottom ?? 0)) };
  const aspect = (asset.width * kept.w) / (asset.height * kept.h), frame = canvas.width / canvas.height, scale = t?.scale ?? 1;
  const w = Math.min(1, aspect / frame) * scale, h = Math.min(1, frame / aspect) * scale;
  const cx = 0.5 + (t?.x ?? 0), cy = 0.5 + (t?.y ?? 0);
  const box = { left: Math.max(0, cx - w / 2), top: Math.max(0, cy - h / 2), right: Math.min(1, cx + w / 2), bottom: Math.min(1, cy + h / 2) };
  return box.right > box.left && box.bottom > box.top ? box : undefined;
}

/** The share of the frame a set of boxes covers between them. */
function covered(boxes: Box[]) {
  const xs = [...new Set(boxes.flatMap(b => [b.left, b.right]))].sort((a, b) => a - b);
  const ys = [...new Set(boxes.flatMap(b => [b.top, b.bottom]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 1; i < xs.length; i++) for (let j = 1; j < ys.length; j++) {
    const x = (xs[i - 1]! + xs[i]!) / 2, y = (ys[j - 1]! + ys[j]!) / 2;
    if (boxes.some(b => b.left <= x && x < b.right && b.top <= y && y < b.bottom)) area += (xs[i]! - xs[i - 1]!) * (ys[j]! - ys[j - 1]!);
  }
  return area;
}

function backgroundSpans(timeline: Timeline, media: Map<string, Sized>, canvas: Canvas): BackgroundSpan[] {
  const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
  const pictures = timeline.tracks.filter(t => t.kind === "video" && !t.hidden)
    .flatMap(t => t.clips.filter(c => c.kind !== "caption" && c.enabled !== false && (c.opacity ?? 1) >= 0.99 && !(c.kind === "media" && media.get(c.mediaId)?.hasAlpha)));
  const edges = [...new Set(pictures.flatMap(c => [c.timelineIn, clipEnd(c)]))].sort((a, b) => a - b);
  const spans: BackgroundSpan[] = [];
  for (let i = 1; i < edges.length; i++) {
    const from = edges[i - 1]!, to = edges[i]!;
    if (to - from < 1e-6) continue;
    const playing = pictures.filter(c => c.timelineIn < to - 1e-6 && clipEnd(c) > from + 1e-6);
    if (!playing.length) continue;
    const boxes = playing.map(c => pictureBox(c, media, canvas));
    // A picture that moves, turns or lets the one under it through can't be measured from its numbers: say nothing there.
    if (boxes.some(b => !b)) continue;
    const share = round(1 - covered(boxes as Box[]), 2);
    if (share < SHARE_FLOOR) continue;
    const last = spans.at(-1);
    // The same framing carried across a cut is one stretch.
    if (last && Math.abs(last.to - from) < 1e-3 && last.share === share) {
      last.to = round(to, 3);
      last.clipIds.push(...playing.map(c => c.id).filter(id => !last.clipIds.includes(id)));
    } else spans.push({ from: round(from, 3), to: round(to, 3), share, clipIds: playing.map(c => c.id) });
  }
  return spans;
}

/**
 * Where a saved version's pictures leave part of the frame showing only the background, when the edit changed that.
 * A first pass cropped a screen recording to its app window, half the screen wide, and left it at that size: a third
 * of the frame was empty for seventeen of twenty minutes, with the text in it too small to read (2026-11-16). Whether
 * that is the layout wanted is the agent's call, by the skill and the editor's words; this is the measurement.
 */
export function backgroundShowing(before: Timeline | null, after: Timeline, assets: readonly Sized[], canvas: Canvas): BackgroundShowing | undefined {
  const media = new Map(assets.map(a => [a.id, a]));
  const spans = backgroundSpans(after, media, canvas);
  if (!spans.length) return undefined;
  const key = (list: BackgroundSpan[]) => JSON.stringify(list.map(s => [s.from, s.to, s.share]));
  if (before && key(backgroundSpans(before, media, canvas)) === key(spans)) return undefined;
  const length = (s: BackgroundSpan) => s.to - s.from;
  const listed = [...spans].sort((a, b) => length(b) - length(a)).slice(0, LISTED_SPANS).sort((a, b) => a.from - b.from)
    .map(s => ({ ...s, clipIds: s.clipIds.length > 4 ? [...s.clipIds.slice(0, 3), `and ${s.clipIds.length - 3} more`] : s.clipIds }));
  const total = Math.max(0, ...after.tracks.flatMap(t => t.clips.map(clipEnd)));
  return { seconds: Math.round(spans.reduce((sum, s) => sum + length(s), 0) * 10) / 10, of: Math.round(total * 10) / 10,
    share: { least: Math.min(...spans.map(s => s.share)), most: Math.max(...spans.map(s => s.share)) },
    spans: listed, ...(spans.length > listed.length && { more: spans.length - listed.length }) };
}

import { applyOps, clipEnd, type MediaAsset, type MediaClip, type Timeline, type TimelineOp } from "@scarlet/timeline";
import { pictureBox, type Box } from "./framing.js";

/** Pictures on screen for less than this between two others are reported. How long one should hold is the skill's call. */
export const BRIEF_PICTURE_SECONDS = 1;

/** A picture the edit shows for a moment between two others. Times are seconds on the edited timeline. */
export interface BriefPicture {
  from: number;
  to: number;
  seconds: number;
  /** The clips on screen through it, top first, and the ones before and after it. */
  shows: string[];
  before: string[];
  after: string[];
}

type Layer = { clip: MediaClip; order: number; source: { width: number; height: number } };
type Shown = { clip: MediaClip; box: Box };
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const near = (a: number, b: number, by: number) => Math.abs(a - b) <= by;

/**
 * Where the picture on screen changes and changes again within a moment. A pass ended a screen insert 0.13 s before the
 * dialogue cut where it punched in on the camera, so the wide camera played for four frames between the screen and the
 * tight framing (2026-11-16). The picture is what the viewer sees: each opaque picture from the top track down to the
 * first that fills the video. A cut between two pieces of a recording at the same framing is not a change of picture,
 * and neither is a framing that moves on across a clip edge; a dissolve or fade at either change is left alone.
 */
export function briefPictures(timeline: Timeline, media: readonly MediaAsset[], canvas: { width: number; height: number },
  min = BRIEF_PICTURE_SECONDS): BriefPicture[] {
  const assets = new Map(media.map(m => [m.id, m]));
  const layers: Layer[] = timeline.tracks.flatMap((track, order) => track.kind !== "video" || track.hidden ? [] :
    track.clips.flatMap(clip => {
      if (clip.kind !== "media" || clip.enabled === false || clip.opacity <= 0) return [];
      const asset = assets.get(clip.mediaId);
      if (!asset || (asset.kind !== "video" && asset.kind !== "image") || asset.hasAlpha) return [];
      return [{ clip, order, source: { width: asset.width || canvas.width, height: asset.height || canvas.height } }];
    }));
  layers.sort((a, b) => b.order - a.order);

  function picture(t: number): Shown[] {
    const shown: Shown[] = [];
    for (const { clip, source } of layers) {
      if (!(clip.timelineIn <= t && t < clipEnd(clip))) continue;
      const box = pictureBox(clip, t - clip.timelineIn, source, canvas);
      if (box[2] <= 0 || box[3] <= 0 || box[0] >= 1 || box[1] >= 1) continue;
      shown.push({ clip, box });
      const fills = box[0] <= 0.004 && box[1] <= 0.004 && box[2] >= 0.996 && box[3] >= 0.996;
      if (fills && clip.opacity >= 1 && !clip.transform?.rotation) break;
    }
    return shown;
  }
  const crop = (c: MediaClip) => [c.transform?.cropLeft ?? 0, c.transform?.cropTop ?? 0, c.transform?.cropRight ?? 0, c.transform?.cropBottom ?? 0];
  const same = (a: Shown[], b: Shown[]) => a.length === b.length && a.every((x, i) => {
    const y = b[i]!;
    return x.clip.mediaId === y.clip.mediaId && x.box.every((v, k) => near(v, y.box[k]!, 0.003)) &&
      crop(x.clip).every((v, k) => near(v, crop(y.clip)[k]!, 0.001));
  });

  const end = Math.max(0, ...layers.map(l => clipEnd(l.clip)));
  // Clip edges within a millisecond of each other are one change, read just before the first and just after the last.
  const times = layers.flatMap(l => [l.clip.timelineIn, clipEnd(l.clip)]).filter(t => t > 0 && t < end).sort((a, b) => a - b);
  const edges: [number, number][] = [];
  for (const t of times) {
    const last = edges.at(-1);
    if (last && t - last[1] < 1e-3) last[1] = t;
    else edges.push([t, t]);
  }
  const changes: { at: number; before: Shown[]; after: Shown[] }[] = [];
  for (const [first, last] of edges) {
    const before = picture(first - 1e-5), after = picture(last + 1e-5);
    if (!same(before, after)) changes.push({ at: r3(first), before, after });
  }
  // A dissolve or fade blends one picture into the next over its length: it is not a hard change to judge here.
  const blended = (c: (typeof changes)[number]) => [...c.before, ...c.after].some(({ clip }) =>
    clip.transitionIn || (clip.videoFadeIn > 0 && near(clip.timelineIn, c.at, 0.002)) || (clip.videoFadeOut > 0 && near(clipEnd(clip), c.at, 0.002)));
  const found: BriefPicture[] = [];
  for (let i = 0; i + 1 < changes.length; i++) {
    const a = changes[i]!, b = changes[i + 1]!;
    if (b.at - a.at >= min - 1e-6 || blended(a) || blended(b)) continue;
    found.push({ from: a.at, to: b.at, seconds: r3(b.at - a.at), shows: a.after.map(s => s.clip.id),
      before: a.before.map(s => s.clip.id), after: b.after.map(s => s.clip.id) });
  }
  return found;
}

/** The brief pictures an edit makes: those it leaves as they were (the same recordings for the same time) aren't news. */
export function newBriefPictures(before: Timeline | null, after: Timeline, media: readonly MediaAsset[], canvas: { width: number; height: number }) {
  const sig = (tl: Timeline, f: BriefPicture) => {
    const clips = new Map(tl.tracks.flatMap(t => t.clips.map(c => [c.id, c] as const)));
    return `${f.seconds}|${f.shows.map(id => { const c = clips.get(id); return c?.kind === "media" ? c.mediaId : id; }).join(",")}`;
  };
  const had = new Set(before ? briefPictures(before, media, canvas).map(f => sig(before, f)) : []);
  return briefPictures(after, media, canvas).filter(f => !had.has(sig(after, f)));
}

export const BRIEF_PICTURES_NEXT = `Each stretch in briefPictures shows that picture for under ${BRIEF_PICTURE_SECONDS} s between two others, from \`from\` to \`to\` in seconds of the edit. ` +
  "If it shouldn't play that briefly, run the shot before or after over it, or move the change onto the same cut.";

/** A picture this short between two others is a flash: no one means it, so its edge goes onto the cut beside it. */
export const FLASH_SECONDS = 0.1;

/** A flash an edit made that Scarlet closed: `clips` had their edges at `from` and now meet the cut at `to`. */
export interface MetCut { from: number; to: number; seconds: number; clips: string[] }

/**
 * The ops that move each flash the edit makes onto the cut beside it. At 0:55 of one pass the screen insert ended two
 * frames before the camera cut to the next take, so the camera showed full frame, still looking at the screen, then cut
 * again (2026-11-17); briefPictures reported it and the run left it. The edges that move are those of pictures laid
 * over the edit, when the cut is in the bottom picture and they are silent: the bottom track holds the dialogue's cut
 * and the sound stays as it was. `stable` names the clips an op can reach on the engine (those already in the video and
 * those the edit names by id). A flash that can't be closed that way stays in briefPictures for the run.
 */
export function flashesOntoCuts(before: Timeline | null, after: Timeline, media: readonly MediaAsset[], canvas: { width: number; height: number },
  stable: (clipId: string) => boolean): { ops: TimelineOp[]; met: MetCut[] } {
  const assets = new Map(media.map(m => [m.id, m]));
  const tracks = after.tracks.map((track, order) => ({ track, order })).filter(({ track }) => track.kind === "video" && !track.hidden);
  const ops: TimelineOp[] = [], met: MetCut[] = [];
  let tl = after;
  for (const flash of newBriefPictures(before, after, media, canvas).filter(f => f.seconds <= FLASH_SECONDS + 1e-3)) {
    // The clip edges at each end of the flash, and whether one of them is the bottom picture's.
    const edgesAt = (t: number) => tracks.flatMap(({ track, order }) => track.clips.flatMap(clip => clip.kind !== "media" ? [] :
      ([["start", clip.timelineIn], ["end", clipEnd(clip)]] as const).filter(([, at]) => near(at, t, 0.002)).map(([side, at]) => ({ clip, side, order, at }))));
    const bottom = Math.min(...tracks.filter(({ track }) => track.clips.some(c => c.timelineIn <= flash.from + 0.002 && clipEnd(c) >= flash.to - 0.002)).map(t => t.order));
    const atFrom = edgesAt(flash.from), atTo = edgesAt(flash.to);
    // The flash's times are rounded: the moved edges go to the bottom picture's cut itself.
    const [moving, cut] = atTo.some(e => e.order === bottom) && atFrom.length && atFrom.every(e => e.order !== bottom) ? [atFrom, atTo]
      : atFrom.some(e => e.order === bottom) && atTo.length && atTo.every(e => e.order !== bottom) ? [atTo, atFrom] : [[], []];
    const to = cut.find(e => e.order === bottom)?.at;
    if (!moving.length || to === undefined) continue;
    const patches: TimelineOp[] = [];
    for (const { clip, side } of moving) {
      const asset = assets.get(clip.mediaId), speed = clip.speed ?? 1;
      if (!stable(clip.id) || (clip.volume > 0 && asset?.hasAudio !== false)) { patches.length = 0; break; }
      const delta = to - (side === "start" ? clip.timelineIn : clipEnd(clip));
      const sourceIn = side === "start" ? clip.sourceIn + delta * speed : clip.sourceIn;
      const sourceOut = side === "end" ? clip.sourceOut + delta * speed : clip.sourceOut;
      // The recording has to have the footage the moved edge shows.
      if (sourceIn < 0 || sourceOut <= sourceIn || (asset?.duration && sourceOut > asset.duration + 1e-6)) { patches.length = 0; break; }
      const patch = side === "start"
        ? { timelineIn: to, sourceIn, ...(clip.keyframes?.length && { keyframes: clip.keyframes.map(k => ({ ...k, time: k.time - delta })) }) }
        : { sourceOut };
      patches.push({ op: "updateClip", clipId: clip.id, patch } as TimelineOp);
    }
    if (!patches.length) continue;
    let next: Timeline;
    try { next = applyOps(tl, patches); } catch { continue; }
    // Kept only if no moved clip now overlaps another on its track and the flash is gone. Audio joins overlap on purpose.
    const moved = new Set(moving.map(e => e.clip.id));
    const overlaps = next.tracks.some(track => track.clips.some((c, i) => i > 0 && (moved.has(c.id) || moved.has(track.clips[i - 1]!.id)) &&
      c.timelineIn < clipEnd(track.clips[i - 1]!) - 1e-6));
    if (overlaps || briefPictures(next, media, canvas, FLASH_SECONDS + 1e-3).some(f => near(f.from, flash.from, 0.002) || near(f.to, flash.to, 0.002))) continue;
    tl = next;
    ops.push(...patches);
    met.push({ from: flash.from, to: flash.to, seconds: flash.seconds, clips: moving.map(e => e.clip.id) });
  }
  return { ops, met };
}

export const MET_CUT_NEXT = `Each stretch in metCut showed a picture for ${FLASH_SECONDS} s or less between two others: Scarlet moved the listed ` +
  "clips' edges onto the cut beside it, so the shot over it now changes on that cut.";

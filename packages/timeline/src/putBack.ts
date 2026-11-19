import type { Clip, MediaClip, Timeline } from "./schema.js";
import { shiftClip, straightenCrossfades } from "./ops.js";
import { clipEnd } from "./time.js";

/** Everything about a clip but where it sits, what footage it plays and the fades at its ends. */
const look = (clip: MediaClip) => JSON.stringify({ ...clip, id: "", timelineIn: 0, sourceIn: 0, sourceOut: 0,
  audioFadeIn: 0, audioFadeOut: 0, videoFadeIn: 0, videoFadeOut: 0 });

/**
 * The timeline with the footage a cut took out put back at its join, and every other edit as it was. A cut leaves two
 * clips of one recording meeting at `at`, the second starting `length` seconds of footage after the first ends; that
 * footage goes back between them, and everything after the join moves along. Clips that look the same either side are
 * one clip again, as before the cut; where a later edit gave them different looks they stay two, and the footage put
 * back takes the look of the clip before it.
 *
 * It answers nothing where the join isn't that simple (a clip laid across it since, another recording after it, a
 * transition on it), so the caller can ask Scarlet instead.
 */
export function putBackCut(head: Timeline, at: number, length: number, fps: number): Timeline | undefined {
  const tl = structuredClone(head);
  const near = 0.5 / fps;
  let restored = 0;
  for (const track of tl.tracks) {
    // A crossfade on the join goes back to the straight cut at its centre, which is where the cut is.
    straightenCrossfades(track, at, at);
    const ends: Clip[] = [], starts: Clip[] = [];
    for (const clip of track.clips) {
      const end = clipEnd(clip);
      if (Math.abs(clip.timelineIn - at) <= near) starts.push(clip);
      else if (Math.abs(end - at) <= near) ends.push(clip);
      else if (clip.timelineIn < at && end > at) return;
    }
    if (ends.length > 1 || starts.length > 1) return;
    const left = ends[0], right = starts[0];
    let joined: MediaClip | undefined, dropped: Clip | undefined;
    if (left && right) {
      if (left.kind !== "media" || right.kind !== "media" || left.mediaId !== right.mediaId || left.speed !== right.speed || right.transitionIn) return;
      if (Math.abs((right.sourceIn - left.sourceOut) / left.speed - length) > 1 / fps) return;
      restored++;
      if (look(left) === look(right) && !left.keyframes?.length) {
        joined = { ...left, sourceOut: right.sourceOut, audioFadeOut: right.audioFadeOut, videoFadeOut: right.videoFadeOut };
        dropped = right;
      } else {
        joined = { ...left, sourceOut: right.sourceIn, audioFadeOut: 0, videoFadeOut: 0 };
      }
    }
    track.clips = track.clips.flatMap(clip => {
      if (clip === dropped) return [];
      if (clip === left && joined) return [joined];
      if (clip.timelineIn < at - near) return [clip];
      const moved = shiftClip(clip, length);
      // The clip after the join starts where the footage put back ends, with no fade in: the picture and sound run on.
      return [clip === right && joined && moved.kind === "media" ? { ...moved, timelineIn: clipEnd(joined), audioFadeIn: 0, videoFadeIn: 0 } : moved];
    });
  }
  if (!restored) return;
  for (const m of tl.markers) {
    if (m.end !== undefined && (m.end > at + near || m.time >= at - near)) m.end += length;
    if (m.time >= at - near) m.time += length;
  }
  return tl;
}

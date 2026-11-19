import { expect, it } from "vitest";
import { emptyTimeline, makeMediaClip, makeTrack } from "./builders.js";
import { replayJoinFades } from "./joinCrossfade.js";
import { applyOps } from "./ops.js";
import { putBackCut } from "./putBack.js";
import type { Timeline } from "./schema.js";
import { clipEnd, timelineDuration } from "./time.js";

const FPS = 30;

/** One 60 s take, picture and sound, cut at 10–12 s and at 30–31 s, with a crossfade on each join's sound. */
function cutTwice() {
  const first = emptyTimeline("project");
  first.tracks[0]!.clips = [makeMediaClip("take", 0, 60, 0, { id: "picture", volume: 0 })];
  first.tracks[1]!.clips = [makeMediaClip("take", 0, 60, 0, { id: "sound" })];
  const cut = applyOps(first, [{ op: "rippleDelete", start: 30, end: 31 }, { op: "rippleDelete", start: 10, end: 12 }]);
  const faded = replayJoinFades(cut, [{ at: 10, trackId: "a1" }, { at: 28, trackId: "a1" }], 0.04);
  return { first, faded };
}

/** What plays, without the clips' names: a clip put back together keeps the first one's. */
const played = (timeline: Timeline) => timeline.tracks.map(track => track.clips.map(({ id: _id, ...clip }) => clip));

it("puts back the footage one cut took out and leaves the other cut as it was", () => {
  const { first, faded } = cutTwice();
  // The sound's join is a crossfade: its clips overlap round the cut.
  expect(faded.tracks[1]!.clips.map(c => [c.timelineIn, clipEnd(c)])).toEqual([[0, 10.02], [9.98, 28.02], [27.98, 57]]);
  const back = putBackCut(faded, 10, 2, FPS)!;
  expect(timelineDuration(back)).toBeCloseTo(59);
  // The same as cutting only at 30–31 s and fading that join.
  const only = replayJoinFades(applyOps(first, [{ op: "rippleDelete", start: 30, end: 31 }]), [{ at: 30, trackId: "a1" }], 0.04);
  expect(JSON.parse(JSON.stringify(played(back), (_k, v) => typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v)))
    .toEqual(JSON.parse(JSON.stringify(played(only), (_k, v) => typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v)));
  // Both put back, it is the take again.
  const whole = putBackCut(back, 30, 1, FPS)!;
  expect(whole.tracks.map(t => t.clips.map(c => [c.timelineIn, clipEnd(c), c.kind === "media" && c.audioFadeIn, c.kind === "media" && c.audioFadeOut])))
    .toEqual([[[0, 60, 0, 0]], [[0, 60, 0, 0]]]);
});

it("keeps a later edit's look on the clip after the join, and moves markers along", () => {
  const { faded } = cutTwice();
  const punched = applyOps(faded, [{ op: "updateClip", clipId: faded.tracks[0]!.clips[1]!.id, patch: { transform: { x: 0, y: 0, scale: 1.1, rotation: 0 } } },
    { op: "addMarker", marker: { id: "m", time: 20, text: "Here" } }]);
  const back = putBackCut(punched, 10, 2, FPS)!;
  const [before, after] = back.tracks[0]!.clips;
  // The footage put back plays in the clip before the join; the punch-in still starts where it did in the take.
  expect([before!.timelineIn, clipEnd(before!), after!.timelineIn]).toEqual([0, 12, 12]);
  expect(after!.kind === "media" && [after.sourceIn, after.transform?.scale]).toEqual([12, 1.1]);
  expect(back.markers.map(m => m.time)).toEqual([22]);
});

it("answers nothing where the join isn't the cut's own any more", () => {
  const { faded } = cutTwice();
  // No join there, or not that much footage missing at it.
  expect(putBackCut(faded, 15, 2, FPS)).toBeUndefined();
  expect(putBackCut(faded, 10, 5, FPS)).toBeUndefined();
  // A clip a later edit laid across the join.
  const music = makeTrack("audio", "Music", "a2");
  music.clips = [makeMediaClip("song", 0, 40, 0)];
  expect(putBackCut({ ...faded, tracks: [...faded.tracks, music] }, 10, 2, FPS)).toBeUndefined();
});

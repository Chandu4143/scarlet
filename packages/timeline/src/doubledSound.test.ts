import { describe, expect, it } from "vitest";
import { applyOps, doubledSound, emptyTimeline, introducedDoubledSound, makeMediaClip, type MediaClip, type Timeline } from "./index.js";

const media = [
  { id: "media-a", kind: "video" as const, hasAudio: true },
  { id: "media-b", kind: "video" as const, hasAudio: true },
  { id: "silent", kind: "video" as const, hasAudio: false },
  { id: "still", kind: "image" as const },
];

function timeline(video: MediaClip[], audio: MediaClip[] = []): Timeline {
  const tl = emptyTimeline("project");
  tl.tracks[0]!.clips = video;
  tl.tracks[1]!.clips = audio;
  return tl;
}

// The saved edit from #18: the whole recording on V1 and again on A1, both at unity gain.
const reported = () => timeline(
  [makeMediaClip("media-a", 0, 5.75, 0, { id: "video-clip" })],
  [makeMediaClip("media-a", 0, 5.75, 0, { id: "audio-clip" })],
);

describe("doubled sound", () => {
  it("finds the report's video and audio clips playing the same moment of one recording", () => {
    expect(doubledSound(reported(), media)).toEqual([
      { mediaId: "media-a", clipIds: ["video-clip", "audio-clip"], overlap: { start: 0, end: 5.75 }, source: { start: 0, end: 5.75 } },
    ]);
  });

  it("finds a partial overlap, at the timeline range both clips play", () => {
    const tl = timeline(
      [makeMediaClip("media-a", 2, 8, 2, { id: "v" })],
      [makeMediaClip("media-a", 0, 5, 0, { id: "a" })],
    );
    expect(doubledSound(tl, media)).toEqual([{ mediaId: "media-a", clipIds: ["a", "v"], overlap: { start: 2, end: 5 }, source: { start: 2, end: 5 } }]);
  });

  it("compares where the overlap starts on each clip's own clock, at its speed", () => {
    // Both play source 4 s at timeline 2 s at double speed, from different places on the timeline.
    const tl = timeline(
      [makeMediaClip("media-a", 0, 8, 0, { id: "v", speed: 2 })],
      [makeMediaClip("media-a", 4, 8, 2, { id: "a", speed: 2 })],
    );
    expect(doubledSound(tl, media)).toEqual([{ mediaId: "media-a", clipIds: ["v", "a"], overlap: { start: 2, end: 4 }, source: { start: 4, end: 8 } }]);
  });

  it("leaves the edit as it should have been: the video clip at volume 0 with the sound on A1", () => {
    const tl = reported();
    (tl.tracks[0]!.clips[0] as MediaClip).volume = 0;
    expect(doubledSound(tl, media)).toEqual([]);
  });

  it("leaves a copy offset by less than a frame, which can be a deliberate audio offset", () => {
    const tl = reported();
    // 5 ms is under a frame at any common rate.
    tl.tracks[1]!.clips[0] = makeMediaClip("media-a", 0.005, 5.75, 0, { id: "audio-clip" });
    expect(doubledSound(tl, media)).toEqual([]);
    tl.tracks[1]!.clips[0] = makeMediaClip("media-a", 0, 5.75, 0.005, { id: "audio-clip" });
    expect(doubledSound(tl, media)).toEqual([]);
  });

  it("leaves a copy at another speed, a muted track, a disabled clip and two different recordings", () => {
    const speed = timeline([makeMediaClip("media-a", 0, 5, 0)], [makeMediaClip("media-a", 0, 10, 0, { speed: 2 })]);
    const muted = reported();
    muted.tracks[1]!.muted = true;
    const disabled = reported();
    disabled.tracks[1]!.clips[0]!.enabled = false;
    const other = timeline([makeMediaClip("media-a", 0, 5, 0)], [makeMediaClip("media-b", 0, 5, 0)]);
    for (const tl of [speed, muted, disabled, other]) expect(doubledSound(tl, media)).toEqual([]);
  });

  it("leaves media with no sound, and the picture of a hidden track still counts as heard", () => {
    const silent = timeline([makeMediaClip("silent", 0, 5, 0)], [makeMediaClip("silent", 0, 5, 0)]);
    const still = timeline([makeMediaClip("still", 0, 5, 0)], [makeMediaClip("still", 0, 5, 0)]);
    expect(doubledSound(silent, media)).toEqual([]);
    expect(doubledSound(still, media)).toEqual([]);
    // The renderer mixes a hidden video track's sound, so hiding the picture doesn't take the second copy out.
    const hidden = reported();
    hidden.tracks[0]!.hidden = true;
    expect(doubledSound(hidden, media)).toHaveLength(1);
  });

  it("leaves a crossfade between two clips that continue the same source", () => {
    // Split at 5 s with nothing removed, then crossfaded over two frames at 30 fps: each fades across the overlap.
    const fade = 2 / 30;
    const tl = timeline([], [
      makeMediaClip("media-a", 0, 5 + fade / 2, 0, { id: "left", audioFadeOut: fade }),
      makeMediaClip("media-a", 5 - fade / 2, 10, 5 - fade / 2, { id: "right", audioFadeIn: fade }),
    ]);
    expect(doubledSound(tl, media)).toEqual([]);
    // Without the fades it's the same sound twice.
    (tl.tracks[1]!.clips[0] as MediaClip).audioFadeOut = 0;
    expect(doubledSound(tl, media)).toHaveLength(1);
  });

  it("reports copies an edit adds of a moment the base played once, wherever on the timeline", () => {
    const once = timeline([makeMediaClip("media-a", 0, 5.75, 0, { id: "video-clip" })]);
    const next = structuredClone(once);
    next.tracks[1]!.clips.push(makeMediaClip("media-a", 0, 2, 10, { id: "late-a" }));
    next.tracks[0]!.clips.push(makeMediaClip("media-a", 0, 2, 10, { id: "late-v" }));
    expect(introducedDoubledSound(once, next, media)).toEqual([{ mediaId: "media-a", clipIds: ["late-v", "late-a"],
      overlap: { start: 10, end: 12 }, source: { start: 0, end: 2 }, level: { before: 1, after: 2 } }]);
    // From an empty timeline the report's two copies at unity are twice unity.
    expect(introducedDoubledSound(null, reported(), media)).toEqual([{ ...doubledSound(reported(), media)[0]!, level: { before: 1, after: 2 } }]);
  });

  it("leaves a copy of a moment the base already layered, at the level it played it", () => {
    const next = reported();
    next.tracks[1]!.clips.push(makeMediaClip("media-a", 0, 2, 10, { id: "late-a" }));
    next.tracks[0]!.clips.push(makeMediaClip("media-a", 0, 2, 10, { id: "late-v" }));
    expect(introducedDoubledSound(reported(), next, media)).toEqual([]);
  });

  it("compares combined level: one clip at 1 split into two copies at 0.5 plays as before, and raising them to 1 doubles it", () => {
    const single = timeline([makeMediaClip("media-a", 0, 5.75, 0, { id: "video-clip" })]);
    const halves = reported();
    for (const track of halves.tracks.slice(0, 2)) (track.clips[0] as MediaClip).volume = 0.5;
    expect(introducedDoubledSound(single, halves, media)).toEqual([]);
    const raised = applyOps(halves, [
      { op: "updateClip", clipId: "video-clip", patch: { volume: 1 } },
      { op: "updateClip", clipId: "audio-clip", patch: { volume: 1 } },
    ]);
    expect(introducedDoubledSound(halves, raised, media)).toEqual([{ ...doubledSound(raised, media)[0]!, level: { before: 1, after: 2 } }]);
    // Raising one of them to 1 is 1.5.
    const one = applyOps(halves, [{ op: "updateClip", clipId: "audio-clip", patch: { volume: 1 } }]);
    expect(introducedDoubledSound(halves, one, media).map(d => d.level)).toEqual([{ before: 1, after: 1.5 }]);
  });

  it("leaves one clip's own volume, with no second copy", () => {
    const single = timeline([makeMediaClip("media-a", 0, 5.75, 0, { id: "v" })]);
    const louder = applyOps(single, [{ op: "updateClip", clipId: "v", patch: { volume: 3 } }]);
    expect(introducedDoubledSound(single, louder, media)).toEqual([]);
  });

  it("holds a moment the base didn't play to the louder of unity and the loudest copy", () => {
    const quiet = timeline([makeMediaClip("media-a", 0, 5, 0, { id: "v", volume: 0.5 })], [makeMediaClip("media-a", 0, 5, 0, { id: "a", volume: 0.3 })]);
    expect(introducedDoubledSound(null, quiet, media)).toEqual([]);
    const loud = timeline([makeMediaClip("media-a", 0, 5, 0, { id: "v", volume: 1.5 })], [makeMediaClip("media-a", 0, 5, 0, { id: "a", volume: 0.5 })]);
    expect(introducedDoubledSound(null, loud, media).map(d => d.level)).toEqual([{ before: 1.5, after: 2 }]);
    // The base playing another stretch of the recording quietly doesn't hold this one to that level.
    const elsewhere = timeline([makeMediaClip("media-a", 0, 2, 0, { id: "early", volume: 0.5 })]);
    const later = timeline([makeMediaClip("media-a", 3, 5, 3, { id: "v", volume: 0.6 })], [makeMediaClip("media-a", 3, 5, 3, { id: "a", volume: 0.3 })]);
    expect(introducedDoubledSound(elsewhere, later, media)).toEqual([]);
    // A muted clip in the base played nothing.
    const muted = timeline([makeMediaClip("media-a", 0, 5, 0, { id: "v", volume: 0 })]);
    expect(introducedDoubledSound(muted, reported(), media).map(d => d.level)).toEqual([{ before: 1, after: 2 }]);
  });

  it("doesn't report sound layered on purpose that a later edit cuts through, which gives its clips new ids", () => {
    const layered = reported();
    const rippled = applyOps(layered, [{ op: "rippleDelete", start: 2, end: 3 }]);
    expect(doubledSound(rippled, media)).toHaveLength(2);
    expect(introducedDoubledSound(layered, rippled, media)).toEqual([]);
    const split = applyOps(layered, [{ op: "splitClip", clipId: "audio-clip", at: 2, newClipId: "audio-right" }]);
    expect(introducedDoubledSound(layered, split, media)).toEqual([]);
  });

  it("reports a third copy moved under two layered on purpose, by the pairs it makes, at 3 where the base played 2", () => {
    const before = reported();
    before.tracks.push({ ...structuredClone(before.tracks[1]!), id: "a2", clips: [makeMediaClip("media-a", 0, 5.75, 20, { id: "third" })] });
    const next = applyOps(before, [{ op: "moveClip", clipId: "third", timelineIn: 0 }]);
    expect(introducedDoubledSound(before, next, media).map(d => [d.clipIds, d.level])).toEqual([
      [["video-clip", "third"], { before: 2, after: 3 }], [["audio-clip", "third"], { before: 2, after: 3 }],
    ]);
  });
});

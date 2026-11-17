import { describe, expect, it } from "vitest";
import { applyOps, emptyTimeline, type MediaAsset, type Timeline } from "@scarlet/timeline";
import { newBriefPictures, briefPictures } from "./brief-pictures.js";

const canvas = { width: 3840, height: 2160 };
const media = [
  { id: "camera", kind: "video", width: 3840, height: 2160 },
  { id: "screen", kind: "video", width: 3840, height: 2160 },
] as MediaAsset[];
const tight = { x: -0.005, y: -0.061, scale: 1.18, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 };
const zoomed = { x: -0.08, y: -0.61, scale: 3.64, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 };

/** The stretch of his edit at 1:26 (2026-11-16): wide camera, a screen insert over it, then a punch-in at the next cut. */
function edit(insertEnd: number, extra: object[] = []): Timeline {
  return applyOps(emptyTimeline("p"), [
    { op: "addTrack", track: { id: "v_demo", kind: "video", name: "Screen", clips: [] } },
    { op: "addClip", trackId: "v1", clip: { id: "wide", kind: "media", mediaId: "camera", sourceIn: 308.35, sourceOut: 314.52, timelineIn: 80.15 } },
    { op: "addClip", trackId: "v1", clip: { id: "punch", kind: "media", mediaId: "camera", sourceIn: 332.44, sourceOut: 339.25, timelineIn: 86.32, transform: tight } },
    { op: "addClip", trackId: "v_demo", clip: { id: "wang_reply", kind: "media", mediaId: "screen", sourceIn: 322.22, sourceOut: 322.22 + (insertEnd - 83.05) * 0.25,
      speed: 0.25, timelineIn: 83.05, transform: zoomed } },
    ...extra,
  ] as never);
}

describe("briefPictures", () => {
  it("names the wide camera left on screen for four frames between an insert and a punch-in", () => {
    expect(briefPictures(edit(86.19), media, canvas)).toEqual([
      { from: 86.19, to: 86.32, seconds: 0.13, shows: ["wide"], before: ["wang_reply"], after: ["punch"] },
    ]);
  });

  it("says nothing when the insert ends on the cut, or the camera holds for a second", () => {
    expect(briefPictures(edit(86.32), media, canvas)).toEqual([]);
    expect(briefPictures(edit(85.2), media, canvas)).toEqual([]);
  });

  it("doesn't count a cut between two pieces at the same framing, or a change hidden under a full insert", () => {
    const tl = applyOps(emptyTimeline("p"), [
      { op: "addTrack", track: { id: "v2", kind: "video", name: "Screen", clips: [] } },
      { op: "addClip", trackId: "v1", clip: { id: "a", kind: "media", mediaId: "camera", sourceIn: 0, sourceOut: 5, timelineIn: 0 } },
      { op: "addClip", trackId: "v1", clip: { id: "b", kind: "media", mediaId: "camera", sourceIn: 9, sourceOut: 9.2, timelineIn: 5 } },
      { op: "addClip", trackId: "v1", clip: { id: "c", kind: "media", mediaId: "camera", sourceIn: 12, sourceOut: 20, timelineIn: 5.2, transform: tight } },
      { op: "addClip", trackId: "v1", clip: { id: "d", kind: "media", mediaId: "camera", sourceIn: 20, sourceOut: 20.2, timelineIn: 13.2 } },
      { op: "addClip", trackId: "v1", clip: { id: "e", kind: "media", mediaId: "camera", sourceIn: 22, sourceOut: 30, timelineIn: 13.4, transform: tight } },
      { op: "addClip", trackId: "v2", clip: { id: "s", kind: "media", mediaId: "screen", sourceIn: 0, sourceOut: 3, timelineIn: 12, transform: zoomed } },
    ] as never);
    // b is the same wide framing as a, so a→b→c changes the picture once; d plays only under the screen.
    expect(briefPictures(tl, media, canvas)).toEqual([]);
  });

  it("leaves a dissolve alone", () => {
    const tl = edit(86.19, [{ op: "updateClip", clipId: "punch", patch: { videoFadeIn: 0.3 } }]);
    expect(briefPictures(tl, media, canvas)).toEqual([]);
  });

  it("reports only a brief picture the edit makes, not one already in the video", () => {
    const before = edit(86.19);
    const after = applyOps(before, [{ op: "updateClip", clipId: "punch", patch: { opacity: 1 } }] as never);
    expect(newBriefPictures(before, after, media, canvas)).toEqual([]);
    expect(newBriefPictures(edit(86.32), before, media, canvas)).toHaveLength(1);
  });
});

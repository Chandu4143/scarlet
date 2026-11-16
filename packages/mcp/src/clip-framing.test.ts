import { describe, expect, it } from "vitest";
import { applyOps, emptyTimeline } from "@scarlet/timeline";
import { backgroundShowing, unframedBeside } from "./clip-framing.js";

const inset = { x: 0.35, y: 0.315, scale: 0.32, rotation: 0, cropLeft: 0.15, cropRight: 0.15, cropTop: 0.09, cropBottom: 0.09 };

function base() {
  return applyOps(emptyTimeline("p"), [
    { op: "addTrack", track: { id: "cam", kind: "video", name: "Camera", clips: [] } },
    { op: "addClip", trackId: "cam", clip: { id: "a", kind: "media", mediaId: "camera", sourceIn: 0, sourceOut: 10, timelineIn: 0, transform: inset } },
    { op: "addClip", trackId: "cam", clip: { id: "b", kind: "media", mediaId: "camera", sourceIn: 30, sourceOut: 40, timelineIn: 10, transform: inset } },
  ]);
}

describe("unframedBeside", () => {
  it("names a clip put back full frame between framed clips of the same recording", () => {
    const before = base();
    const after = applyOps(before, [
      { op: "rippleInsertGap", at: 10, duration: 5 },
      { op: "addClip", trackId: "cam", clip: { id: "back", kind: "media", mediaId: "camera", sourceIn: 10, sourceOut: 30, timelineIn: 10, speed: 4 } },
    ]);
    expect(unframedBeside(before, after)).toEqual([{ clipId: "back", trackId: "cam", at: 10, beside: { clipId: "a", transform: expect.objectContaining({ scale: 0.32 }) } }]);
  });

  it("says nothing when the added clip is framed, or its neighbours are another recording or unframed too", () => {
    const before = base();
    const framed = applyOps(before, [
      { op: "rippleInsertGap", at: 10, duration: 5 },
      { op: "addClip", trackId: "cam", clip: { id: "back", kind: "media", mediaId: "camera", sourceIn: 10, sourceOut: 15, timelineIn: 10, transform: inset } },
    ]);
    expect(unframedBeside(before, framed)).toEqual([]);
    const other = applyOps(before, [
      { op: "rippleInsertGap", at: 10, duration: 5 },
      { op: "addClip", trackId: "cam", clip: { id: "still", kind: "media", mediaId: "photo", sourceIn: 0, sourceOut: 5, timelineIn: 10 } },
    ]);
    expect(unframedBeside(before, other)).toEqual([]);
    // A split keeps the framing on both halves, so nothing it makes is new and unframed.
    expect(unframedBeside(before, applyOps(before, [{ op: "splitClip", clipId: "a", at: 5, newClipId: "a2" }]))).toEqual([]);
  });
});

describe("backgroundShowing", () => {
  const canvas = { width: 3840, height: 2160 };
  const assets = [{ id: "screen", kind: "video" as const, width: 3840, height: 2160 }, { id: "camera", kind: "video" as const, width: 3840, height: 2160 },
    { id: "title", kind: "graphic" as const, width: 3840, height: 2160, hasAlpha: true }];
  // The app window is the middle half of the screen: cropped to it and left at that size, it is 64% of the frame wide.
  const windowCrop = { x: -0.032, y: 0, scale: 1.04, rotation: 0, cropLeft: 0.273, cropRight: 0.22, cropTop: 0.105, cropBottom: 0.09 };
  const corner = { x: 0.326, y: 0.315, scale: 0.3, rotation: 0, cropLeft: 0.105, cropRight: 0.05, cropTop: 0, cropBottom: 0 };
  const demo = (screen?: object) => applyOps(emptyTimeline("p"), [
    { op: "addTrack", track: { id: "scr", kind: "video", name: "Screen", clips: [] } },
    { op: "addTrack", track: { id: "cam", kind: "video", name: "Camera", clips: [] } },
    { op: "addClip", trackId: "cam", clip: { id: "open", kind: "media", mediaId: "camera", sourceIn: 0, sourceOut: 10, timelineIn: 0 } },
    { op: "addClip", trackId: "scr", clip: { id: "s1", kind: "media", mediaId: "screen", sourceIn: 10, sourceOut: 40, timelineIn: 10, ...(screen && { transform: screen }) } },
    { op: "addClip", trackId: "scr", clip: { id: "s2", kind: "media", mediaId: "screen", sourceIn: 50, sourceOut: 70, timelineIn: 40, ...(screen && { transform: screen }) } },
    { op: "addClip", trackId: "cam", clip: { id: "in1", kind: "media", mediaId: "camera", sourceIn: 10, sourceOut: 40, timelineIn: 10, transform: corner } },
    { op: "addClip", trackId: "cam", clip: { id: "in2", kind: "media", mediaId: "camera", sourceIn: 50, sourceOut: 70, timelineIn: 40, transform: corner } },
  ]);

  it("says how much of the frame a screen recording cropped to its window leaves empty, across the cuts that share the framing", () => {
    const found = backgroundShowing(null, demo(windowCrop), assets, canvas);
    // The window covers 65% of the frame and the inset beside it another 5%: one stretch, though two clips play it.
    expect(found).toEqual({ seconds: 50, of: 60, share: { least: 0.3, most: 0.3 },
      spans: [{ from: 10, to: 60, share: 0.3, clipIds: ["s1", "in1", "s2", "in2"] }] });
  });

  it("says nothing of pictures that fill the frame, of an edit that left the framing as it was, or of a picture that moves", () => {
    expect(backgroundShowing(null, demo(), assets, canvas)).toBeUndefined();
    const cropped = demo(windowCrop);
    expect(backgroundShowing(cropped, applyOps(cropped, [{ op: "updateClip", clipId: "open", patch: { volume: 0.5 } }]), assets, canvas)).toBeUndefined();
    const moving = applyOps(cropped, [{ op: "updateClip", clipId: "s1", patch: { keyframes: [{ time: 0, transform: { scale: 1 } }, { time: 2, transform: { scale: 1.6 } }] } }]);
    expect(backgroundShowing(null, moving, assets, canvas)).toMatchObject({ seconds: 20, spans: [{ from: 40, to: 60 }] });
    // A title with alpha lets the picture under it through, so it neither covers the frame nor leaves it empty.
    const titled = applyOps(demo(), [{ op: "addTrack", track: { id: "gfx", kind: "video", name: "Titles", clips: [] } },
      { op: "addClip", trackId: "gfx", clip: { id: "t", kind: "media", mediaId: "title", sourceIn: 0, sourceOut: 4, timelineIn: 12, transform: { ...corner, scale: 0.5 } } }]);
    expect(backgroundShowing(null, titled, assets, canvas)).toBeUndefined();
  });
});

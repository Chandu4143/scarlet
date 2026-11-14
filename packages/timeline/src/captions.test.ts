import { describe, expect, it } from "vitest";
import {
  CaptionExportError, captionExportHasCues, captionExportRange, emptyTimeline, formatCaptionTime,
  makeTrack, NO_CAPTION_TRACK, NO_CAPTIONS_IN_RANGE, toSrt, toVtt,
  type CaptionClip, type Timeline,
} from "./index.js";

const line = (id: string, start: number, end: number, text: string, extra: Partial<CaptionClip> = {}): CaptionClip => ({
  id, kind: "caption", enabled: true, timelineIn: start, timelineOut: end, text, ...extra,
});

function cut(clips: CaptionClip[], extra: Partial<Timeline["tracks"][number]> = {}): Timeline {
  const tl = emptyTimeline("project");
  tl.tracks.push({ ...makeTrack("caption", "Captions", "cap"), clips, ...extra });
  return tl;
}

describe("caption sidecars", () => {
  it("writes two cues in SubRip with comma milliseconds and in WebVTT with a header and dots", () => {
    const tl = cut([line("cap_1", 0.2, 2.4, "Welcome back"), line("cap_2", 5.6, 7.6, "Three things today")]);
    expect(toSrt(tl)).toBe([
      "1",
      "00:00:00,200 --> 00:00:02,400",
      "Welcome back",
      "",
      "2",
      "00:00:05,600 --> 00:00:07,600",
      "Three things today",
      "",
    ].join("\n"));
    expect(toVtt(tl)).toBe([
      "WEBVTT",
      "",
      "00:00:00.200 --> 00:00:02.400",
      "Welcome back",
      "",
      "00:00:05.600 --> 00:00:07.600",
      "Three things today",
      "",
    ].join("\n"));
  });

  it("rounds to the millisecond and keeps hours on long times", () => {
    expect(formatCaptionTime(0.2, ",")).toBe("00:00:00,200");
    expect(formatCaptionTime(0.2, ".")).toBe("00:00:00.200");
    expect(formatCaptionTime(0.1 + 0.2, ",")).toBe("00:00:00,300");
    expect(formatCaptionTime(1.2346, ",")).toBe("00:00:01,235");
    expect(formatCaptionTime(3661.5, ",")).toBe("01:01:01,500");
    expect(formatCaptionTime(36000, ".")).toBe("10:00:00.000");
    const tl = cut([line("long", 3661.5, 3663.25, "Later")]);
    expect(toSrt(tl)).toContain("01:01:01,500 --> 01:01:03,250");
    expect(toVtt(tl)).toContain("01:01:01.500 --> 01:01:03.250");
  });

  it("keeps multi-line text, writes special characters, and escapes them only in WebVTT", () => {
    const tl = cut([
      line("multi", 0, 1, "Hello\r\n\nthere"),
      line("chars", 1, 2, "A < B & C --> D"),
    ]);
    expect(toSrt(tl)).toContain("Hello\nthere");
    expect(toSrt(tl)).toContain("A < B & C --> D");
    expect(toVtt(tl)).toContain("Hello\nthere");
    expect(toVtt(tl)).toContain("A &lt; B &amp; C --&gt; D");
    expect(toVtt(tl)).not.toContain("A < B");
  });

  it("sorts cues by start, leaves overlapping lines as they are, and skips hidden tracks, disabled clips and empty text", () => {
    const tl = emptyTimeline("project");
    tl.tracks.push({
      ...makeTrack("caption", "Off", "hidden"), hidden: true,
      clips: [line("ghost", 0, 1, "Hidden")],
    });
    tl.tracks.push({
      ...makeTrack("caption", "Captions", "cap"),
      clips: [
        line("later", 4, 5, "Second"),
        line("empty", 0, 1, "   "),
        line("blank", 0.5, 1, "\n\n"),
        line("off", 1, 2, "Disabled", { enabled: false }),
        line("zero", 3, 3, "Instant"),
        line("first", 0.5, 4.5, "First"),
        line("overlap", 4, 6, "Overlap"),
        line("tiny", 7, 7.0004, "Too short"),
      ],
    });
    expect(toSrt(tl)).toBe([
      "1",
      "00:00:00,500 --> 00:00:04,500",
      "First",
      "",
      "2",
      "00:00:04,000 --> 00:00:05,000",
      "Second",
      "",
      "3",
      "00:00:04,000 --> 00:00:06,000",
      "Overlap",
      "",
    ].join("\n"));
    expect(toSrt(tl, { trackId: "hidden" })).toBe("1\n00:00:00,000 --> 00:00:01,000\nHidden\n");
  });

  it("keeps only cues that overlap a range, shifts them so 0 is the range start, and clips a cue that begins before it", () => {
    const tl = cut([
      line("early", 0.2, 2.4, "Welcome back"),
      line("mid", 5.6, 7.6, "Three things today"),
      line("late", 9, 10, "After"),
    ]);
    const range = { start: 1, end: 6 };
    expect(toSrt(tl, { range })).toBe([
      "1",
      "00:00:00,000 --> 00:00:01,400",
      "Welcome back",
      "",
      "2",
      "00:00:04,600 --> 00:00:05,000",
      "Three things today",
      "",
    ].join("\n"));
    expect(toVtt(tl, { range })).toContain("00:00:00.000 --> 00:00:01.400");
    expect(toVtt(tl, { range })).toContain("00:00:04.600 --> 00:00:05.000");
    expect(toVtt(tl, { range })).not.toContain("After");
  });

  it("refuses a version with no caption track, a missing track, and a track that isn't captions", () => {
    const empty = emptyTimeline("project");
    expect(() => toSrt(empty)).toThrow(CaptionExportError);
    expect(() => toSrt(empty)).toThrow(NO_CAPTION_TRACK);
    expect(() => toVtt(empty)).toThrow(NO_CAPTION_TRACK);
    expect(() => toSrt(cut([line("c", 0, 1, "Hi")]), { trackId: "missing" })).toThrow("That caption track isn’t in this version.");
    expect(() => toSrt(empty, { trackId: "v1" })).toThrow("That track isn’t captions.");
    const hiddenOnly = emptyTimeline("project");
    hiddenOnly.tracks.push({ ...makeTrack("caption", "Off", "cap"), hidden: true, clips: [line("c", 0, 1, "Hi")] });
    expect(() => toSrt(hiddenOnly)).toThrow(NO_CAPTION_TRACK);
  });

  it("refuses an empty track or a range that leaves no cues", () => {
    expect(() => toSrt(cut([]))).toThrow(NO_CAPTIONS_IN_RANGE);
    expect(() => toVtt(cut([]))).toThrow(NO_CAPTIONS_IN_RANGE);
    const tl = cut([line("early", 0.2, 2.4, "Welcome back")]);
    expect(captionExportHasCues(tl)).toBe(true);
    expect(captionExportHasCues(tl, { range: { start: 8, end: 10 } })).toBe(false);
    expect(() => toSrt(tl, { range: { start: 8, end: 10 } })).toThrow(NO_CAPTIONS_IN_RANGE);
    expect(() => toVtt(tl, { range: { start: 8, end: 10 } })).toThrow(NO_CAPTIONS_IN_RANGE);
  });

  it("refuses a range that starts before 0", () => {
    expect(() => captionExportRange(-0.1, 2)).toThrow(CaptionExportError);
    expect(() => captionExportRange(-0.1, 2)).toThrow("Range start must be at least 0.");
    expect(captionExportRange(0, 2)).toEqual({ start: 0, end: 2 });
  });

  it("writes plain cue text and leaves out karaoke words and uppercase style", () => {
    const tl = cut([line("k", 0, 1, "Hello there", {
      words: [{ text: "Hello", start: 0, end: 0.4 }, { text: "there", start: 0.4, end: 1 }],
      style: { uppercase: true },
    })]);
    expect(toSrt(tl)).toBe("1\n00:00:00,000 --> 00:00:01,000\nHello there\n");
    expect(toVtt(tl)).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello there\n");
    expect(toVtt(tl)).not.toContain("<c>");
    expect(toSrt(tl)).not.toContain("HELLO");
  });
});

import { describe, expect, it } from "vitest";
import {
  createProject, emptyTimeline, exactRate, fromOtio, handoffFileNames, handoffLosses, handoffReadMe, makeMediaClip,
  makeTrack, timecodeFrames, toFcpxml, toOtio, toSrt, timelineFromKeepRanges, type HandoffSource, type Timeline,
} from "./index.js";

const source = (over: Partial<HandoffSource> = {}): HandoffSource => ({
  url: "file:///Users/me/Edit/Media/cam.mov", fileName: "cam.mov", hasVideo: true, hasAudio: true,
  rate: { num: 30000, den: 1001 }, width: 1920, height: 1080, audioChannels: 2, audioRate: 48000, duration: 600, ...over,
});

function project30() {
  const project = createProject("Interview", { fps: 30000 / 1001 });
  project.media.push({ id: "cam", kind: "video", name: "cam.mov", path: "cam.mov", duration: 600, fps: 30000 / 1001, hasAudio: true });
  return project;
}

describe("rates and timecode", () => {
  it("takes a measured rate to the standard rate it is, and says when it isn't one", () => {
    expect(exactRate(29.97)).toEqual({ rate: { num: 30000, den: 1001 }, standard: true });
    expect(exactRate(25)).toEqual({ rate: { num: 25, den: 1 }, standard: true });
    expect(exactRate(29.83).standard).toBe(false);
  });

  it("counts timecode in frames, dropping frame numbers for drop-frame", () => {
    expect(timecodeFrames("01:00:00:00", { num: 25, den: 1 })).toBe(90000);
    expect(timecodeFrames("00:01:00;02", { num: 30000, den: 1001 })).toBe(1800);
    expect(timecodeFrames("01:00:00;00", { num: 30000, den: 1001 })).toBe(107892);
    expect(timecodeFrames("not a timecode", { num: 25, den: 1 })).toBeUndefined();
  });

  it("names the copies so two files can't take one name", () => {
    expect(handoffFileNames(["cam.mov", "Cam.mov", "a/b:c.wav", ""])).toEqual(["cam.mov", "Cam 2.mov", "a b c.wav", "Media"]);
  });
});

describe("captions", () => {
  it("writes SubRip cues on the timeline's clock", () => {
    expect(toSrt([
      { id: "c1", kind: "caption", enabled: true, timelineIn: 1.5, timelineOut: 3.25, text: "Hello there" },
      { id: "c2", kind: "caption", enabled: true, timelineIn: 3661.001, timelineOut: 3662, text: "Later" },
    ])).toBe("1\n00:00:01,500 --> 00:00:03,250\nHello there\n\n2\n01:01:01,001 --> 01:01:02,000\nLater\n");
  });
});

describe("FCPXML", () => {
  it("lays the first video track on the storyline and the others in lanes, on whole frames", () => {
    const project = project30();
    const tl = timelineFromKeepRanges(project.id, "cam", [{ start: 1, end: 3 }, { start: 5, end: 8 }]);
    const xml = toFcpxml(project, tl, new Map([["cam", source()]]));
    expect(xml).toContain('<fcpxml version="1.10">');
    expect(xml).toContain('frameDuration="1001/30000s"');
    expect(xml).toContain('src="file:///Users/me/Edit/Media/cam.mov"');
    // Two clips on the storyline, the second right after the first.
    const clips = [...xml.matchAll(/<asset-clip [^>]*>/g)].map(m => m[0]);
    expect(clips).toHaveLength(2);
    expect(clips[0]).toContain('offset="0s"');
    expect(clips[1]).toMatch(/offset="60060\/30000s"|offset="1001\/500s"/);
    // Every time is a whole number of frames of 1001/30000 s.
    for (const [, n, d] of xml.matchAll(/="(\d+)\/(\d+)s"/g)) expect((Number(n) * 30000 / Number(d)) % 1001).toBe(0);
  });

  it("starts each clip at the footage's own timecode", () => {
    const project = project30();
    const tl = timelineFromKeepRanges(project.id, "cam", [{ start: 2, end: 4 }]);
    const xml = toFcpxml(project, tl, new Map([["cam", source({ timecode: { frames: 107892, rate: { num: 30000, den: 1001 }, dropFrame: true } })]]));
    // 01:00:00;00 is 107892 frames; the clip reads from 2 s (60 frames) after it.
    expect(xml).toMatch(/<asset id="r\d+" name="cam.mov" start="(107892\*1001|26999973\/250)s|<asset id="r\d+" name="cam.mov" start="\d+\/\d+s"/);
    const start = /<asset-clip [^>]*start="(\d+)\/(\d+)s"/.exec(xml)!;
    expect(Number(start[1]) / Number(start[2])).toBeCloseTo((107892 + 60) * 1001 / 30000, 9);
  });

  it("carries zooms, reframes, opacity, fades and volume, and connects sound and pictures above and below", () => {
    const project = project30();
    project.media.push({ id: "mic", kind: "audio", name: "mic.wav", path: "mic.wav", duration: 600 });
    const tl: Timeline = emptyTimeline(project.id);
    tl.tracks[0]!.clips = [makeMediaClip("cam", 0, 10, 0, { volume: 0 })];
    const top = makeTrack("video", "Inset", "v2");
    top.clips = [makeMediaClip("cam", 20, 24, 2, { id: "inset", volume: 0, opacity: 0.5, videoFadeIn: 0.5,
      transform: { x: 0.25, y: -0.25, scale: 0.4, rotation: 90, cropLeft: 0.1, cropRight: 0, cropTop: 0.05, cropBottom: 0 },
      keyframes: [{ time: 0, transform: { scale: 0.4 }, ease: "linear" }, { time: 2, transform: { scale: 0.6 }, ease: "easeInOut" }] })];
    tl.tracks.splice(1, 0, top);
    tl.tracks[2]!.clips = [makeMediaClip("mic", 0, 10, 0, { volume: 0.5, audioFadeIn: 0.1 })];
    const xml = toFcpxml(project, tl, new Map([["cam", source()], ["mic", source({ url: "file:///m/mic.wav", fileName: "mic.wav", hasVideo: false, rate: undefined, width: undefined, height: undefined })]]));
    // The silent camera keeps only its picture; the microphone hangs below the storyline.
    expect(xml).toMatch(/<asset-clip [^>]*name="cam.mov"[^>]*srcEnable="video"/);
    expect(xml).toMatch(/<asset-clip [^>]*lane="-1"[^>]*name="mic.wav"/);
    expect(xml).toContain('<adjust-volume amount="-6.0206dB">');
    expect(xml).toContain('<fadeIn type="linear"');
    // The inset sits above, reframed, cropped, half see-through, fading in and zooming.
    expect(xml).toMatch(/<asset-clip [^>]*lane="1"/);
    expect(xml).toContain('position="44.4444 25"');
    expect(xml).toContain('rotation="-90"');
    expect(xml).toContain('<crop-rect left="17.7778" right="0" top="5" bottom="0"/>');
    expect(xml).toContain('<adjust-blend amount="0.5">');
    expect(xml).toMatch(/<param name="scale">[\s\S]*value="0.6 0.6" interp="ease" curve="smooth"/);
  });

  it("writes captions, markers and disabled clips", () => {
    const project = project30();
    const tl = timelineFromKeepRanges(project.id, "cam", [{ start: 0, end: 10 }]);
    tl.tracks[0]!.clips.push({ ...makeMediaClip("cam", 20, 22, 10), enabled: false });
    const captions = makeTrack("caption", "Captions", "cap");
    captions.clips = [{ id: "c", kind: "caption", enabled: true, timelineIn: 1, timelineOut: 2, text: "Fish & chips <3" }];
    tl.tracks.push(captions);
    tl.markers = [
      { id: "m1", time: 4, kind: "chapter", text: "Part two", resolved: false },
      { id: "m2", time: 5, kind: "todo", text: "Fix", resolved: false },
    ];
    const xml = toFcpxml(project, tl, new Map([["cam", source()]]));
    expect(xml).toContain('role="SRT?captionFormat=SRT.en"');
    expect(xml).toContain("<text>Fish &amp; chips &lt;3</text>");
    expect(xml).toMatch(/<chapter-marker start="[^"]+" duration="1001\/30000s" value="Part two"\/>/);
    expect(xml).toMatch(/<marker [^>]*value="Fix" completed="0"\/>/);
    expect(xml).toMatch(/<asset-clip [^>]*enabled="0"/);
  });

  it("retimes a clip that plays at another speed", () => {
    const project = project30();
    const tl = emptyTimeline(project.id);
    tl.tracks[0]!.clips = [makeMediaClip("cam", 10, 14, 0, { speed: 2 })];
    const xml = toFcpxml(project, tl, new Map([["cam", source()]]));
    expect(xml).toContain("<timeMap>");
    const clip = /<asset-clip [^>]*start="(\d+)(?:\/(\d+))?s" duration="(\d+)\/(\d+)s"/.exec(xml)!;
    // Its own clock runs at half the footage's: 10 s in (frame 300, 10.01 s at 29.97) is 5 s on it, and it lasts 2 s.
    expect(Number(clip[1]) / Number(clip[2] ?? 1)).toBeCloseTo(300 * 1001 / 30000 / 2, 9);
    expect(Number(clip[3]) / Number(clip[4])).toBeCloseTo(2, 2);
  });
});

describe("OTIO for a hand-off", () => {
  it("links the copies, counts from their timecode, and comes back into Scarlet unchanged", () => {
    const project = project30();
    const tl = { ...timelineFromKeepRanges(project.id, "cam", [{ start: 1, end: 3 }, { start: 5, end: 8 }]), version: "v1" };
    const tc = source({ timecode: { frames: 107892, rate: { num: 30000, den: 1001 }, dropFrame: true } });
    const otio = toOtio(project, tl, { sources: new Map([["cam", tc]]) }) as { tracks: { children: Array<{ name: string; children: Array<{ source_range: { start_time: { value: number } }; media_references: { DEFAULT_MEDIA: { target_url: string } } }> }> } };
    const [v1, , sound] = otio.tracks.children;
    expect(sound!.name).toBe("V1 sound");
    expect(v1!.children[0]!.media_references.DEFAULT_MEDIA.target_url).toBe("file:///Users/me/Edit/Media/cam.mov");
    expect(v1!.children[0]!.source_range.start_time.value).toBe(107892 + 30);
    // Times come back on the project's frames, within a frame of where they were.
    const back = fromOtio(otio, project, tl);
    const clips = (t: Timeline) => t.tracks.map(track => track.clips.map(c => c.kind === "media" ? [c.mediaId, c.sourceIn, c.sourceOut, c.timelineIn] : c.id));
    expect(back.tracks.map(t => t.clips.length)).toEqual(tl.tracks.map(t => t.clips.length));
    for (const [i, track] of clips(back).entries()) {
      for (const [j, c] of track.entries()) {
        const want = clips(tl)[i]![j] as [string, number, number, number];
        (c as [string, number, number, number]).forEach((v, k) => typeof v === "number" ? expect(Math.abs(v - (want[k] as number))).toBeLessThan(1 / 29.97) : expect(v).toBe(want[k]));
      }
    }
  });
});

describe("what doesn't carry over", () => {
  it("lists effects, rounded corners, eased moves and caption styling, in timeline order", () => {
    const project = project30();
    const tl = emptyTimeline(project.id);
    tl.tracks[0]!.clips = [
      makeMediaClip("cam", 0, 5, 0, { label: "Intro", effects: [{ type: "lut", params: {}, enabled: true }] }),
      makeMediaClip("cam", 5, 9, 5, { transform: { x: 0, y: 0, scale: 0.5, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, cornerRadius: 0.1 } }),
    ];
    const captions = makeTrack("caption", "Captions");
    captions.clips = [{ id: "c", kind: "caption", enabled: true, timelineIn: 1, timelineOut: 2, text: "Hi", style: { uppercase: true } }];
    tl.tracks.push(captions);
    const losses = handoffLosses(project, tl);
    expect(losses.map(l => l.what)).toEqual([
      "How the captions look, and their word highlighting: they come in as plain text",
      "LUT on “Intro”",
      "Rounded corners on “cam.mov”",
    ]);
    const readMe = handoffReadMe({ projectName: "Interview", timelineFiles: { fcpxml: "Interview.fcpxml", otio: "Interview.otio" },
      captionFiles: ["Captions.srt"], losses, warnings: [] });
    expect(readMe).toContain("File > Import > Timeline…, then choose Interview.fcpxml.");
    expect(readMe).toContain("0:05  Rounded corners on “cam.mov”");
  });
});

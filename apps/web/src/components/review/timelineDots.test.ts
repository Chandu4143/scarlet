// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { bandLabel, gapLabel, layoutMarks, nearestMark, type TimelineDot } from "./TimelineScrubber";

const dot = (time: number, n: number): TimelineDot => ({ time, n, title: `Edit ${n}` });
const shapes = (layout: ReturnType<typeof layoutMarks>) => layout.map(m => m.label);

describe("layoutMarks", () => {
  // 100 s across 1000 px: 1 s is 10 px, and a numbered circle needs 20 px to its neighbour.
  const marks = [dot(10, 1), dot(11, 2), dot(12, 3), dot(50, 4), dot(90, 5), dot(90.5, 6)];

  it("shares one pill between edits whose circles would touch, and gives an edit with room its own circle", () => {
    const layout = layoutMarks(marks, 0, 100, 1000);
    expect(shapes(layout)).toEqual(["1–3", "4", "5–6"]);
    // The pill sits over the middle of its run and stands for every edit in it.
    expect(layout[0]).toMatchObject({ time: 10, times: [10, 11, 12], at: 11 });
  });

  it("gives each edit its circle once zoomed in far enough", () => {
    expect(shapes(layoutMarks(marks, 9, 4, 1000))).toEqual(["1", "2", "3"]);
  });

  it("reaches back when sharing widens a pill into the marker before it", () => {
    // 1 and 2 have room for two circles. 3 joins 2, and their wider pill no longer clears 1.
    expect(shapes(layoutMarks([dot(10, 1), dot(12, 2)], 0, 100, 1000))).toEqual(["1", "2"]);
    expect(shapes(layoutMarks([dot(10, 1), dot(12, 2), dot(12.5, 3)], 0, 100, 1000))).toEqual(["1–3"]);
  });

  it("shows the lowest number and a plus when the edits sharing a pill skip numbers", () => {
    expect(shapes(layoutMarks([dot(10, 4), dot(10.5, 9)], 0, 100, 1000))).toEqual(["4+"]);
  });

  it("shares one marker between edits on the same frame", () => {
    expect(shapes(layoutMarks([dot(10, 4), dot(10, 5), dot(30, 9), dot(30, 7)], 0, 100, 1000))).toEqual(["4–5", "7+"]);
  });

  it("keeps duplicates and unnumbered calls out of contiguous number ranges", () => {
    const shared = [dot(10, 5), dot(10.1, 3), dot(10.2, 3), dot(10.3, 6)];
    expect(shapes(layoutMarks(shared, 0, 100, 1000))).toEqual(["3+"]);
    expect(shapes(layoutMarks([dot(10, 1), { time: 10.01, title: "Call" }], 0, 100, 1000))).toEqual(["1+"]);
  });

  it("caps a run's reach, so a dense pass reads as several runs that never touch", () => {
    // 119 cuts, one every 5 s across 600 s and 900 px: each 7.5 px from the next, so every circle would touch.
    const pass = Array.from({ length: 119 }, (_, i) => dot(5 * i + 2, i + 1));
    const layout = layoutMarks(pass, 0, 600, 900);
    expect(layout.map(m => m.label)).toEqual(["1–14", "15–28", "29–42", "43–56", "57–70", "71–84", "85–98", "99–112", "113–119"]);
    // Together the runs hold every cut once, in order.
    expect(layout.flatMap(m => m.dots.map(d => d.n))).toEqual(pass.map(d => d.n));
    for (const m of layout) expect((Math.max(...m.times) - Math.min(...m.times)) / 600 * 900).toBeLessThanOrEqual(104);
    // No pill touches the next, and none leaves the track.
    for (let i = 1; i < layout.length; i++) {
      const a = layout[i - 1]!, b = layout[i]!;
      expect((b.at - a.at) / 100 * 900).toBeGreaterThanOrEqual(a.width / 2 + b.width / 2 + 3 - 1e-6);
    }
    expect(layout.at(-1)!.at / 100 * 900 + layout.at(-1)!.width / 2).toBeLessThanOrEqual(900 + 1e-6);
  });

  it("keeps the open edit's own circle out of every pill, the runs either side moved clear of it", () => {
    const pass = Array.from({ length: 30 }, (_, i) => ({ ...dot(5 * i + 2, i + 1), current: i === 14 }));
    const layout = layoutMarks(pass, 0, 150, 300);
    const open = layout.find(m => m.dots.some(d => d.current))!;
    expect([open.label, open.dots.length]).toEqual(["15", 1]);
    for (let i = 1; i < layout.length; i++) {
      const a = layout[i - 1]!, b = layout[i]!;
      expect((b.at - a.at) / 100 * 300).toBeGreaterThanOrEqual(a.width / 2 + b.width / 2 + 3 - 1e-6);
    }
    expect(layout.flatMap(m => m.dots.map(d => d.n))).toEqual(pass.map(d => d.n));
  });

  it("keeps long labels and their hit targets separate at both ends of the strip", () => {
    const marks = [
      dot(0, 141), dot(1, 142), { ...dot(1.5, 12), group: "call" },
      { ...dot(98, 143), state: "kept" as const }, { ...dot(99, 144), state: "kept" as const },
      { ...dot(100, 13), group: "call" },
    ];
    const width = 400;
    const layout = layoutMarks(marks, 0, 100, width);
    expect(shapes(layout)).toEqual(["141–142", "12", "143–144", "13"]);
    let previousEnd = -3;
    for (const mark of layout) {
      const mid = mark.at / 100 * width;
      const left = mid - mark.width / 2, right = mid + mark.width / 2;
      expect(left - previousEnd).toBeGreaterThanOrEqual(3 - 1e-6);
      expect(right).toBeLessThanOrEqual(width + 1e-6);
      expect(nearestMark(layout, (left + 1) / width * 100, width)).toBe(mark);
      expect(nearestMark(layout, (right - 1) / width * 100, width)).toBe(mark);
      previousEnd = right;
    }
    expect(layout.flatMap(mark => mark.times)).toEqual([0, 1, 1.5, 98, 99, 100]);
  });

  it("keeps a selected number over its cut when a neighboring label can move aside", () => {
    const layout = layoutMarks([dot(20, 130), dot(20.5, 131), { ...dot(21, 132), current: true }], 0, 100, 800);
    expect(shapes(layout)).toEqual(["130–131", "132"]);
    expect(layout[1]!.at).toBeCloseTo(21);
    const space = (layout[1]!.at - layout[0]!.at) * 8 - (layout[1]!.width + layout[0]!.width) / 2;
    expect(space).toBeGreaterThanOrEqual(3 - 1e-6);
  });

  it("fits dense calls, flags and kept edits on a narrow strip without mixing their numbers", () => {
    const marks = Array.from({ length: 90 }, (_, i) => [
      { ...dot(i + .1, i + 1), group: "call", state: "check" as const },
      { ...dot(i + .2, i + 1), group: "flag", state: "check" as const },
      { ...dot(i + .3, i + 1), state: "kept" as const, current: i === 82 },
    ]).flat();
    const width = 320;
    const layout = layoutMarks(marks, 0, 90, width);
    expect(layout.flatMap(mark => mark.dots)).toHaveLength(marks.length);
    expect(layout.find(mark => mark.dots.some(dot => dot.current))?.dots).toEqual([marks[82 * 3 + 2]]);
    let previousEnd = 0;
    for (const mark of layout) {
      expect(new Set(mark.dots.map(dot => dot.group)).size).toBe(1);
      const center = mark.at / 100 * width;
      expect(center - mark.width / 2).toBeGreaterThanOrEqual(previousEnd - 1e-6);
      previousEnd = center + mark.width / 2;
    }
    expect(previousEnd).toBeLessThanOrEqual(width + 1e-6);
  });

  it("works out its runs for the zoom on its way, so the pills don't change on the way there", () => {
    const pass = Array.from({ length: 40 }, (_, i) => dot(5 * i + 2, i + 1));
    // Halfway through a zoom from the whole 200 s to 0–40 s, the runs are already the ones at 0–40 s.
    const landed = layoutMarks(pass, 0, 40, 1000).map(m => m.label);
    const midway = layoutMarks(pass, 0, 120, 1000, 40).filter(m => m.times[0]! <= 40).map(m => m.label);
    expect(midway.slice(0, landed.length)).toEqual(landed);
  });

  it("never puts a call's number and an edit's in one pill, though their circles would touch", () => {
    // Calls 1 and 2 sit a second and a half apart, with an edit numbered 1 between them. The two calls share a pill;
    // the edit keeps its own circle.
    const call = (time: number, n: number): TimelineDot => ({ ...dot(time, n), group: "call" });
    const layout = layoutMarks([call(10, 1), dot(11, 1), call(11.5, 2), dot(50, 2)], 0, 100, 1000);
    expect(layout.map(m => [m.label, m.dots.map(d => d.group ?? "edit")])).toEqual([["1–2", ["call", "call"]], ["1", ["edit"]], ["2", ["edit"]]]);
    // On the same frame too, and each marker has its own name.
    const same = layoutMarks([call(10, 3), dot(10, 4)], 0, 100, 1000);
    expect(same.map(m => m.label)).toEqual(["3", "4"]);
    expect(new Set(same.map(m => m.key)).size).toBe(2);
  });

  it("draws circles before the track is measured", () => {
    expect(shapes(layoutMarks(marks.slice(0, 2), 0, 100, 0))).toEqual(["1", "2"]);
  });
});

describe("nearestMark", () => {
  const layout = layoutMarks([dot(10, 1), dot(11, 2), dot(50, 3)], 0, 100, 1000);

  it("picks the pill anywhere along the crowded run it stands for", () => {
    expect(nearestMark(layout, 10.1, 1000)?.label).toBe("1–2");
    expect(nearestMark(layout, 11.2, 1000)?.label).toBe("1–2");
  });

  it("picks nothing far from every edit", () => {
    expect(nearestMark(layout, 30, 1000)).toBeUndefined();
    expect(nearestMark(layout, 52, 1000)?.label).toBe("3");
  });
});

describe("gapLabel", () => {
  const gap = { label: "Cut at 12:05", shortLabel: "12:05" };

  it("names the cut in full where the gap has room", () => {
    expect(gapLabel(gap, 200)).toBe("Cut at 12:05");
  });

  it("falls back to the cut's time on a narrow gap, so the tag isn't cut off", () => {
    expect(gapLabel(gap, 85)).toBe("12:05");
  });

  it("draws no label on a gap too narrow for even the time, rather than one cut off mid-word", () => {
    expect(gapLabel(gap, 43)).toBe("12:05");
    expect(gapLabel(gap, 24)).toBe("");
  });

  it("keeps the full label before the track is measured, or without a short one", () => {
    expect(gapLabel(gap, 0)).toBe("Cut at 12:05");
    expect(gapLabel({ label: "Cut at 12:05" }, 40)).toBe("Cut at 12:05");
  });
});

describe("bandLabel", () => {
  it("keeps the open edit's label whole while it fits its band, then just the amount, then nothing", () => {
    expect(bandLabel("Removed · 7.2 s", 320)).toBe("Removed · 7.2 s");
    // A one-second cut zoomed with five seconds either side is a band a few dozen pixels wide.
    expect(bandLabel("Removed · 1.4 s", 60)).toBe("1.4 s");
    expect(bandLabel("Removed · 0.5 s", 30)).toBe("");
    // A label with no amount is whole or absent, never cut off mid-word.
    expect(bandLabel("Audio", 60)).toBe("Audio");
    expect(bandLabel("Audio", 20)).toBe("");
    // Before the track is measured there is nothing to fit it to.
    expect(bandLabel("Removed · 1.4 s", 0)).toBe("Removed · 1.4 s");
  });
});

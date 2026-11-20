import { describe, expect, it } from "vitest";
import { anchorWord, clockOf, endBetweenWords, playedAround, publishedAt, scoreAnswers, type Spot } from "../src/calibrate.ts";

describe("calibrate", () => {
  it("finds what a cut plays either side of a source second, across its joins", () => {
    // The cut plays 0–10 and 20–30 of the recording.
    const kept = [{ start: 0, end: 10 }, { start: 20, end: 30 }];
    expect(playedAround(kept, 10)).toEqual([{ start: 6, end: 10 }, { start: 20, end: 24 }]);
    // A second the cut took out plays as the start of the next piece.
    expect(playedAround(kept, 15, 2, 2)).toEqual([{ start: 8, end: 10 }, { start: 20, end: 22 }]);
  });

  it("finds the published second that plays a source second", () => {
    const pieces = [{ mediaId: "m", finalStart: 0, finalEnd: 10, sourceStart: 100, sourceEnd: 110, rate: 1 },
      { mediaId: "m", finalStart: 10, finalEnd: 15, sourceStart: 130, sourceEnd: 135, rate: 1 }];
    expect(publishedAt(pieces, "m", 105)).toBe(5);
    expect(publishedAt(pieces, "m", 120)).toBe(10);
    expect(publishedAt(pieces, "x", 105)).toBeUndefined();
  });

  it("says how many spots of each kind the listener called real, leaving unsure ones out of the share", () => {
    const spot = (id: string, kind: Spot["kind"]): Spot => ({ id, kind, caseId: "c", mediaId: "m", at: 0, end: 0, text: "", scarlet: "" });
    const spots = [spot("a", "midword"), spot("b", "midword"), spot("c", "midword"), spot("d", "control")];
    const result = scoreAnswers(spots, { a: "real", b: "fine", c: "unsure", d: "fine" });
    expect(result.midword).toMatchObject({ spots: 3, real: 1, fine: 1, unsure: 1, realShare: 50 });
    expect(result.control).toMatchObject({ real: 0, realShare: 0 });
    expect(result.wrong!.realShare).toBeNull();
  });

  it("starts both clips on the last word both cuts play before the spot, and ends them between words", () => {
    const words = ["so", "today", "we", "look", "at", "carbon"].map((text, i) => ({ text, start: i, end: i + 0.8 }));
    // Scarlet plays 0–3.9 and 5–6; the editor plays 0–2.9 and 5–6. The spot is Scarlet's join at 3.9.
    const scarlet = [{ start: 0, end: 3.9 }, { start: 5, end: 6 }], editor = [{ start: 0, end: 2.9 }, { start: 5, end: 6 }];
    expect(anchorWord(words, scarlet, editor, 3.9, () => true)!.text).toBe("we");
    expect(anchorWord(words, scarlet, editor, 3.9, t => t < 1)!.text).toBe("so");
    expect(clockOf(scarlet, 5.5)).toBeCloseTo(4.4, 6);
    expect(endBetweenWords([{ start: 1, end: 3.5 }], words)).toEqual([{ start: 1, end: 3.88 }]);
    expect(endBetweenWords([{ start: 1, end: 3.9 }], words)).toEqual([{ start: 1, end: 3.9 }]);
  });
});

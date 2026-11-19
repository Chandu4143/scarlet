import { describe, expect, it } from "vitest";
import { reachesEditor } from "./checkIn.js";

describe("reachesEditor", () => {
  it("brings the editor more of what Scarlet doubts at each step, and never what it is certain of", () => {
    const grades = ["certain", "high", "medium", "low"] as const;
    const brought = (setting: "less" | "balanced" | "more") => grades.filter(grade => reachesEditor(grade, setting));
    expect(brought("less")).toEqual(["low"]);
    expect(brought("balanced")).toEqual(["medium", "low"]);
    expect(brought("more")).toEqual(["high", "medium", "low"]);
  });
});

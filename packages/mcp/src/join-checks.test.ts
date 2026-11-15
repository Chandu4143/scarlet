import { expect, it } from "vitest";
import { JoinChecks } from "./join-checks.js";
import { json, noteUnmeasured, unmeasured, type ToolResult } from "./tool-result.js";

const body = (r: ToolResult) => JSON.parse((r.content[0] as { text: string }).text);

it("returns finished cuts in their original slots and delivers late measurement warnings on collection", async () => {
  const checks = new JoinChecks();
  let release!: () => void, runs = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const run: Parameters<JoinChecks["collect"]>[3] = async publish => {
    runs++;
    publish(1, { status: "unchanged", start: 3, end: 4 });
    await gate;
    noteUnmeasured("microphone", new Error("no samples"));
    return json({ version: "cut", joins: [{ error: "no samples" }, { status: "unchanged", start: 3, end: 4 }] });
  };
  const poll = () => checks.collect("batch", "cut", 2, run, 5);
  expect(body(await poll())).toMatchObject({ status: "measuring", pendingCuts: [0],
    joins: [{ status: "pending" }, { status: "unchanged", start: 3, end: 4 }] });
  release();
  const missed = new Map<string, string>();
  const [a, b] = await unmeasured.run(missed, () => Promise.all([poll(), poll()]));
  expect(body(a)).toEqual(body(b));
  expect(body(a).joins[0]).toEqual({ error: "no samples" });
  expect(missed.get("microphone")).toContain("no samples");
  expect(runs).toBe(1);
  await poll();
  expect(runs).toBe(2);
});

it("delivers a failed background measurement and permits a fresh attempt", async () => {
  const checks = new JoinChecks();
  let fail!: (err: Error) => void;
  const work = new Promise<ToolResult>((_, reject) => { fail = reject; });
  const poll = () => checks.collect("single", "version", 1, () => work, 5);
  expect(body(await poll()).pendingCuts).toEqual([0]);
  fail(new Error("missing recording"));
  await expect(poll()).rejects.toThrow("missing recording");
  expect(body(await checks.collect("single", "version", 1, async () => json({ status: "adjusted" }), 5))).toEqual({ status: "adjusted" });
});

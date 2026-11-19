import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createProject, timelineFromKeepRanges, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { localUser } from "../auth.js";
import { recordHistoryEdit, rejectCuts } from "./cutHistory.js";
import { storeVersion } from "./timeline.js";

let dataDir: string;
let app: ScarletApp;
let project: Project;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "scarlet-cut-history-"));
  app = createApp({ dataDir, env: {}, log: () => {} });
  project = app.ctx.repos.projects.insert(createProject("Long interview"));
});
afterEach(async () => {
  await app.ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

it("calls the whole video the video when a restore can't go ahead, and restores as a new version when it can", () => {
  const { ctx } = app;
  const user = localUser(ctx);
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "interview.mov", kind: "video", path: "camera.mov" }, "ready");
  const first = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 60 }]), { parent: null });
  const second = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 40 }]), { parent: first.version });
  ctx.repos.projects.update(project.id, { head: second.version });
  const branch = ctx.repos.projects.get(project.id)!.branch ?? "main";
  const restore = (version: string, expectedHead: string) => recordHistoryEdit(ctx, user, project.id, version, "restore", expectedHead, branch);
  // Asked for from a video that has moved on since, and for the version the video is on already.
  expect(() => restore(first.version, first.version)).toThrow("The video changed. Try again.");
  expect(() => restore(second.version, second.version)).toThrow("The video is already on this version.");
  expect(ctx.repos.projects.get(project.id)!.head).toBe(second.version);
  // The earlier version comes back as a new one on top: both versions stay.
  const { project: restored, change } = restore(first.version, second.version);
  expect(change.description).toBe(`Restore · ${first.version}`);
  expect(ctx.repos.versions.summaries(project.id, restored.head).map(v => v.version)).toEqual(expect.arrayContaining([first.version, second.version, restored.head]));
  expect(ctx.repos.versions.summaries(project.id, restored.head).find(v => v.isHead)).toMatchObject({ parent: second.version, duration: 60 });
});

it("puts a rejected cut's footage back itself, and refuses a cut whose join it can't find", () => {
  const { ctx } = app;
  const user = localUser(ctx);
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "interview.mov", kind: "video", path: "camera.mov" }, "ready");
  const first = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 60 }]), { parent: null });
  const cut = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 10 }, { start: 12, end: 40 }, { start: 45, end: 60 }]), { parent: first.version });
  ctx.repos.projects.update(project.id, { head: cut.version });
  const branch = ctx.repos.projects.get(project.id)!.branch ?? "main";
  const pause = { changeId: "chg_pass", spot: 0, label: "Trimmed the pause.", at: 10, before: { version: first.version, removed: { start: 10, end: 12 } } };
  const reject = (cuts: (typeof pause)[], head = cut.version) => rejectCuts(ctx, user, project.id, "thread", cuts, head, branch);
  // Asked for from a video that has moved on, at a place with no join, and for more footage than the join is missing.
  expect(() => reject([pause], first.version)).toThrow("The video changed. Try again.");
  expect(() => reject([{ ...pause, at: 20 }])).toThrow("This cut can’t be put back as it was.");
  expect(() => reject([{ ...pause, before: { version: first.version, removed: { start: 10, end: 13 } } }])).toThrow("This cut can’t be put back as it was.");
  expect(ctx.repos.projects.get(project.id)!.head).toBe(cut.version);
  // The pause is back and the other cut is as it was: 53 s plus the 2 s it took.
  const { project: after, change } = reject([pause]);
  expect(change).toMatchObject({ rejects: true, state: "approved", threadId: "thread", description: "Rejected · Trimmed the pause.",
    timelineEdits: [{ label: "Trimmed the pause.", range: { start: 10, end: 12 }, replaces: { changeId: "chg_pass", spot: 0 } }] });
  const now = ctx.repos.versions.get(project.id, after.head!)!.timeline;
  expect(now.tracks.flatMap(t => t.clips).filter(c => c.kind === "media").map(c => [c.timelineIn, c.sourceIn, c.sourceOut]).sort((a, b) => a[0]! - b[0]!))
    .toEqual(expect.arrayContaining([[0, 0, 40], [40, 45, 60]]));
  expect(ctx.repos.versions.summaries(project.id, after.head).find(v => v.isHead)).toMatchObject({ parent: cut.version, duration: 55 });
});

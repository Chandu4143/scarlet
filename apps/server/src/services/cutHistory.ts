import type { User } from "@scarlet/shared";
import { diffTimelines, HistoryConflict, makeTimeMap, newId, planRevert, putBackCut, timelineDuration, type Change, type TimeRange } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { conflict, notFound } from "../errors.js";
import { actorFor, logActivity } from "./activity.js";
import { ensureProjectHead, resolveTimeline, storeVersion } from "./timeline.js";

export function recordHistoryEdit(ctx: Ctx, user: User, projectId: string, target: string,
  action: "revert" | "restore", expectedHead: string, branch: string) {
  return ctx.db.transaction(() => {
    const project = ensureProjectHead(ctx, projectId);
    const { head } = project, timeline = resolveTimeline(ctx, project);
    if (head !== expectedHead || project.branch !== branch) throw conflict("cut_changed", "The video changed. Try again.");
    const selected = ctx.repos.versions.get(projectId, target);
    if (!selected) throw notFound("version");
    let result = selected.timeline;
    if (action === "revert") {
      try {
        result = planRevert(ctx.repos.versions.links(projectId), head, target, project.settings.fps,
          id => resolveTimeline(ctx, project, id), id => ctx.repos.changes.get(id));
      } catch (e) {
        if (e instanceof HistoryConflict) throw conflict("revert_conflict", e.message);
        throw e;
      }
    } else if (head === target) throw conflict("already_head", "The video is already on this version.");
    const description = `${action === "revert" ? "Undo" : "Restore"} · ${selected.description ?? target}`;
    const author = actorFor(user);
    const id = newId("chg");
    const saved = storeVersion(ctx, projectId, result, { parent: head, author, description, changeId: id });
    const change: Change = { id, projectId, description, author, decidedBy: author, state: "approved",
      fromVersion: head, toVersion: saved.version, appliedOnto: head, appliedVersion: saved.version,
      revertsVersion: action === "revert" ? target : undefined, noteIds: [], renders: [],
      ranges: diffTimelines(timeline, saved, project.settings.fps).ranges, createdAt: now(), updatedAt: now() };
    ctx.repos.changes.put(change);
    const updated = ctx.repos.projects.update(projectId, { head: saved.version });
    ctx.bus.publish({ type: "change.updated", projectId, change });
    ctx.bus.publish({ type: "project.updated", projectId, project: updated });
    logActivity(ctx, { projectId, actor: author, type: action === "revert" ? "change.undone" : "version.restored",
      summary: description, data: { changeId: id, target, from: head, version: saved.version, branch } });
    return { project: updated, change };
  }, "immediate")();
}

/** A cut the editor rejected: the edit it is, where its join is in the video now, and the footage it took out. */
export interface RejectedCut {
  changeId: string; spot: number; label: string; at: number;
  before: { version: string; removed: TimeRange };
}

/**
 * Reject applied cuts: the footage each took out goes back at its join, and every other edit stays as it is. No model
 * runs. It is refused (`needs_scarlet`) where a join isn't the cut's own any more, such as one a later edit laid a clip
 * across, or where the result doesn't play that footage whole: the editor's × asks Scarlet then.
 */
export function rejectCuts(ctx: Ctx, user: User, projectId: string, threadId: string, cuts: RejectedCut[], expectedHead: string, branch: string) {
  return ctx.db.transaction(() => {
    const project = ensureProjectHead(ctx, projectId);
    const { head } = project, timeline = resolveTimeline(ctx, project);
    if (head !== expectedHead || project.branch !== branch) throw conflict("cut_changed", "The video changed. Try again.");
    const fps = project.settings.fps;
    const unclear = () => conflict("needs_scarlet", "This cut can’t be put back as it was.");
    let result = timeline;
    // Last first, so the joins before each one are still where the editor saw them.
    const placed = [...cuts].sort((a, b) => b.at - a.at);
    for (const cut of placed) {
      const next = putBackCut(result, cut.at, cut.before.removed.end - cut.before.removed.start, fps);
      if (!next) throw unclear();
      result = next;
    }
    // Each stretch of footage must play again, whole and in one piece, where its cut was.
    const edits: NonNullable<Change["timelineEdits"]> = [];
    let moved = 0;
    for (const cut of [...placed].reverse()) {
      const before = ctx.repos.versions.get(projectId, cut.before.version)?.timeline;
      if (!before) throw unclear();
      const { removed } = cut.before, length = removed.end - removed.start;
      const map = makeTimeMap(before, result, fps);
      const start = map(removed.start, "right"), end = map(removed.end, "left");
      if (start === null || end === null || Math.abs(start - (cut.at + moved)) > 1 / fps || Math.abs(end - start - length) > 1 / fps) throw unclear();
      edits.push({ label: cut.label.slice(0, 180), range: { start, end }, replaces: { changeId: cut.changeId, spot: cut.spot } });
      moved += length;
    }
    if (Math.abs(timelineDuration(result) - timelineDuration(timeline) - moved) > 1 / fps) throw unclear();
    const description = cuts.length > 1 ? `Rejected ${cuts.length} cuts` : `Rejected · ${cuts[0]!.label}`;
    const author = actorFor(user);
    const id = newId("chg");
    const saved = storeVersion(ctx, projectId, result, { parent: head, author, description, changeId: id });
    const change: Change = { id, projectId, description, author, decidedBy: author, state: "approved", threadId, rejects: true,
      fromVersion: head, toVersion: saved.version, appliedOnto: head, appliedVersion: saved.version, timelineEdits: edits,
      noteIds: [], renders: [], ranges: diffTimelines(timeline, saved, fps).ranges, createdAt: now(), updatedAt: now() };
    ctx.repos.changes.put(change);
    const updated = ctx.repos.projects.update(projectId, { head: saved.version });
    ctx.bus.publish({ type: "change.updated", projectId, change });
    ctx.bus.publish({ type: "project.updated", projectId, project: updated });
    logActivity(ctx, { projectId, actor: author, type: "change.undone",
      summary: description, data: { changeId: id, rejected: cuts.map(c => ({ changeId: c.changeId, spot: c.spot })), from: head, version: saved.version, branch } });
    return { project: updated, change };
  }, "immediate")();
}

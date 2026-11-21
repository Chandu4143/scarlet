import { isProjectEditTask, type BrollRunRequest, type BrollRunResponse, type Task } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { FINISHED_TASK, createTask } from "./tasks.js";

/** How many B-roll runs one request has at work at once. Each is a CLI of its own, with a shell and the web. */
export const BROLL_AT_ONCE = 3;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** The B-roll runs a request started that haven't finished. */
function atWork(ctx: Ctx, asker: Task): Task[] {
  return ctx.repos.tasks.select("project_id = ? AND kind = 'broll_make' AND json_extract(json, '$.context.checksTaskId') = ?", [asker.projectId, asker.id])
    .filter(run => !FINISHED_TASK.has(run.state));
}

/**
 * Find or make one piece of B-roll for a request: a short run of its own, with the asking request's agent and model
 * and its harness's own shell, file and web tools, beside that request and outside the project's queue. The run adds
 * what it made to the project's media and places nothing; the request reads what it made here and lays it in. Waits
 * for the run up to `waitMs`, and a call with `runId` waits on one started earlier.
 *
 * Only this run carries the shell's and the web's tool definitions: a request that needs no B-roll pays for none.
 * The editor asks for a shot, in their words or in a skill of theirs, and Scarlet starts none on its own (their
 * decision, 2026-11-21). The asking run reads whether they did; Scarlet's code matches no word of theirs.
 */
export async function brollRun(ctx: Ctx, projectId: string, askerId: string | undefined, body: BrollRunRequest, signal: AbortSignal): Promise<BrollRunResponse> {
  const asker = askerId ? ctx.repos.tasks.get(askerId) : undefined;
  if (!asker || asker.projectId !== projectId || asker.agent === "api" || !isProjectEditTask(asker)) {
    throw badRequest("not_a_request", "Only a request's own run can ask for B-roll.");
  }
  let run: Task | null | undefined;
  if (body.runId) {
    run = ctx.repos.tasks.get(body.runId);
    if (!run || run.kind !== "broll_make" || run.context.checksTaskId !== asker.id) throw notFound("that B-roll run");
  } else {
    const open = atWork(ctx, asker);
    if (open.length >= BROLL_AT_ONCE) {
      throw conflict("broll_busy", `${open.length} B-roll runs are at work for this request (${open.map(r => r.id).join(", ")}). Wait on one with runId before starting another.`);
    }
    const brief = { at: body.at!, want: body.want!, ...(body.duration && { duration: body.duration }), ...(body.says && { says: body.says }), ...(body.url && { url: body.url }) };
    run = createTask(ctx, { projectId, kind: "broll_make", agent: asker.agent, model: asker.model, effort: asker.effort, fast: asker.fast,
      serviceTier: asker.serviceTier, instruction: `B-roll at ${clock(brief.at)}: ${brief.want}`.slice(0, 600), context: { checksTaskId: asker.id, broll: brief },
      createdBy: asker.createdBy });
    ctx.log(`[broll] ${run.id} started for ${asker.id} at ${brief.at} s`);
  }
  const deadline = Date.now() + (body.waitMs ?? 0);
  const id = run.id;
  const current = () => ctx.repos.tasks.get(id)!;
  while (!FINISHED_TASK.has(current().state) && Date.now() < deadline && !signal.aborted) await new Promise(done => setTimeout(done, 500));
  signal.throwIfAborted();
  const now = current();
  const media = ctx.repos.projects.listMedia(projectId).filter(m => m.provenance?.taskId === id)
    .map(m => ({ id: m.id, kind: m.kind, name: m.name, duration: m.duration, width: m.width, height: m.height, hasAlpha: m.hasAlpha, ...(m.source && { source: { url: m.source.url } }) }));
  if (!FINISHED_TASK.has(now.state)) return { runId: id, state: "working", media };
  return now.state === "done" ? { runId: id, state: "done", summary: now.summary ?? undefined, media }
    : { runId: id, state: "failed", error: now.error ?? (now.state === "cancelled" ? "The run was stopped." : "The run ended without finishing."), summary: now.summary ?? undefined, media };
}

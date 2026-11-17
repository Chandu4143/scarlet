/**
 * What of a recording's picture viewers may see: boxes an agent or the editor gave on single frames, kept with the
 * project, and where each still holds, read from the recording's edges. The edges are read once, a small frame every
 * few seconds, and kept beside the waveform; a box added later is placed against them in milliseconds.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileInDirectoryAsync } from "@scarlet/render";
import { AREA_HOLDS_AT, AREA_SIDES, SHOW_EDGE_HEIGHT, SHOW_EDGE_STEP, SHOW_EDGE_VERSION, SHOW_EDGE_WIDTH, assignAreas, edgeBits, edgeBytes, sideFits,
  type AreaBox, type AreaSide, type HeldArea, type ShowArea } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { badRequest, notFound } from "../errors.js";
import { rememberLast, withFrames, type VideoMedia } from "./pictureReading.js";

export interface ShowAreaState {
  mediaId: string;
  /** Seconds between the frames edges were read on. */
  step: number;
  /** False while the recording's edges are still being read: `areas` then have no holds yet. */
  done: boolean;
  error?: string;
  areas: HeldArea[];
  /** Stretches of source seconds no area holds for. */
  unset: Array<[number, number]>;
}

interface Edges { frames: number; bits: Buffer }
const reading = new Map<string, Promise<Edges>>();
const kept = new Map<string, Edges>();
const failed = new Map<string, string>();

const edgePath = (ctx: Ctx, media: VideoMedia) => join(ctx.paths.waveforms(media.projectId), `${media.id}.show-edges.v${SHOW_EDGE_VERSION}.bin`);
const sourceFile = async (ctx: Ctx, media: VideoMedia) => {
  const file = await fileInDirectoryAsync(ctx.paths.media(media.projectId), media.path);
  if (!file) throw notFound("source file");
  return file;
};

/** The recording's edges, read now if they never were. One reading per recording runs at a time. */
function edges(ctx: Ctx, media: VideoMedia): Promise<Edges> {
  const have = kept.get(media.id);
  if (have) return Promise.resolve(have);
  let run = reading.get(media.id);
  if (!run) {
    run = (async () => {
      const path = edgePath(ctx, media), size = edgeBytes();
      const saved = await readFile(path).catch(() => undefined);
      if (saved && saved.length >= size && saved.length % size === 0) return { frames: saved.length / size, bits: saved };
      const file = await sourceFile(ctx, media), started = Date.now(), parts: Uint8Array[] = [];
      // A reading a running edit asked for: a pause of the project's media work doesn't stop it, the project closing does.
      await withFrames(ctx, media, file, "show-edges", { start: 0, end: media.duration ?? 0, fps: 1 / SHOW_EDGE_STEP, width: SHOW_EDGE_WIDTH, height: SHOW_EDGE_HEIGHT,
        signal: ctx.projectSignal(media.projectId) }, (_at, rgb) => { parts.push(edgeBits(rgb)); return false; }, async () => undefined);
      if (!parts.length) throw new Error("no frames could be read");
      const bits = Buffer.concat(parts), tmp = `${path}.${randomUUID()}`;
      await writeFile(tmp, bits);
      await rename(tmp, path).catch(async error => { await rm(tmp, { force: true }); throw error; });
      ctx.log(`[show-area] ${media.id}: read ${parts.length} frames' edges in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      return { frames: parts.length, bits };
    })();
    reading.set(media.id, run);
    run.then(found => { failed.delete(media.id); rememberLast(kept, media.id, found, 3); }, error => failed.set(media.id, error instanceof Error ? error.message : String(error)))
      .finally(() => reading.delete(media.id));
  }
  return run;
}

function saved(ctx: Ctx, mediaId: string): ShowArea[] {
  return (ctx.db.prepare("SELECT json FROM show_areas WHERE media_id = ? ORDER BY at").all(mediaId) as Array<{ json: string }>).map(row => JSON.parse(row.json) as ShowArea);
}

/** A recording's areas and where each holds. Waits up to `waitMs` for a first reading of its edges. */
export async function showArea(ctx: Ctx, media: VideoMedia, opts: { waitMs: number }): Promise<ShowAreaState> {
  const areas = saved(ctx, media.id), duration = media.duration ?? 0;
  const base = { mediaId: media.id, step: SHOW_EDGE_STEP };
  const run = edges(ctx, media);
  run.catch(() => {});
  const found = await Promise.race([run.catch(() => undefined), new Promise<undefined>(done => { setTimeout(() => done(undefined), opts.waitMs).unref(); })]);
  if (!found) {
    const error = failed.get(media.id);
    return { ...base, done: false, ...(error && !reading.has(media.id) && { error }), areas: areas.map(a => ({ ...a, holds: [] })), unset: [] };
  }
  const size = edgeBytes();
  const assigned = assignAreas(found.frames, duration, areas, (frame, area) => sideFits(found.bits.subarray(frame * size, (frame + 1) * size), area));
  return { ...base, done: true, ...assigned };
}

/** The edges of the exact frame a box was given on, so a box's missing lines are read where the agent looked. */
async function frameEdges(ctx: Ctx, media: VideoMedia, at: number): Promise<Uint8Array | undefined> {
  let bits: Uint8Array | undefined;
  const file = await sourceFile(ctx, media);
  await withFrames(ctx, media, file, "show-area", { start: at, end: Math.min(media.duration ?? at + 1, at + 0.5), fps: 4, width: SHOW_EDGE_WIDTH, height: SHOW_EDGE_HEIGHT,
    signal: ctx.projectSignal(media.projectId) }, (_at, rgb) => { bits ??= edgeBits(rgb); return false; }, async () => undefined).catch(() => undefined);
  return bits;
}

export interface ShowAreaEdit { set?: Array<{ at: number; area: number[] }>; remove?: number[] }

/** Add, replace (same second) or remove areas. Each new box records the edges it has no line under on its own frame. */
export async function editShowAreas(ctx: Ctx, media: VideoMedia, edit: ShowAreaEdit): Promise<void> {
  const duration = media.duration ?? 0;
  const rows: ShowArea[] = [];
  for (const { at, area } of edit.set ?? []) {
    if (!(at >= 0 && at <= duration)) throw badRequest("bad_time", `An area's second is inside the recording's ${duration.toFixed(2)} s.`);
    if (area.length !== 4 || area.some(n => !(n >= 0 && n <= 1)) || !(area[2]! - area[0]! >= 0.05 && area[3]! - area[1]! >= 0.05)) {
      throw badRequest("bad_area", "An area is [left, top, right, bottom] as fractions of the picture, at least a twentieth of it each way.");
    }
    const box = area.map(n => Math.round(n * 10000) / 10000) as AreaBox;
    const bits = await frameEdges(ctx, media, at);
    const fits = bits && sideFits(bits, box);
    const noLine: AreaSide[] = fits ? AREA_SIDES.filter(side => fits[side] < AREA_HOLDS_AT) : [];
    rows.push({ at: Math.round(at * 1000) / 1000, area: box, noLine });
  }
  ctx.db.transaction(() => {
    for (const at of edit.remove ?? []) ctx.db.prepare("DELETE FROM show_areas WHERE media_id = ? AND abs(at - ?) < 0.0005").run(media.id, at);
    for (const row of rows) {
      ctx.db.prepare("DELETE FROM show_areas WHERE media_id = ? AND abs(at - ?) < 0.0005").run(media.id, row.at);
      ctx.db.prepare("INSERT INTO show_areas (media_id, at, json, created_at) VALUES (?, ?, ?, ?)").run(media.id, row.at, JSON.stringify(row), new Date().toISOString());
    }
  })();
}

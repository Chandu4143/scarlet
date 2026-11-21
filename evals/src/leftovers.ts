/**
 * Restarts that play in the editor's own edits now: a free sweep of a Scarlet library, no engine and no model.
 *
 * A report names one spot. This says how many spots of the same kind his projects play, so a fix is judged on the
 * class: run it before the fix and after (on the replayed or re-run edit), and record both counts in the ledger entry.
 *
 * For each project's current edit it lists every phrase the dialogue plays twice within a moment (the closing check's
 * own finder, findRestarts), marks the ones only cut-off words find, and, from the project's latest dialogue pass,
 * how many repeats the model kept silently with dialogue_check_repeats (a keep plays on and is never shown to the
 * editor). A phrase said twice is often deliberate ("it was short, it was concise"): the list is for reading, not a
 * count of mistakes.
 *
 *   node_modules/.bin/tsx evals/src/leftovers.ts [--db <scarlet.db>] [--project <id or name>] [--json]
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { findRestarts } from "../../packages/shared/src/restarts.ts";
import { normalizeTranscriptToken } from "../../packages/shared/src/transcriptSearch.ts";
import { appSupportDir } from "./paths.ts";

interface Word { text: string; start: number; end: number }
interface Clip { mediaId?: string; sourceIn: number; sourceOut: number; timelineIn: number; speed?: number; enabled?: boolean; volume?: number }
interface Played { text: string; start: number; end: number; source: number; mediaId: string }
export interface Leftover { at: number; source: number; mediaId: string; before: string; first: string; again: string; cutOffOnly: boolean }
export interface ProjectLeftovers { id: string; name: string; head: string; words: number; restarts: Leftover[]; pass?: { taskId: string; kept: string[] } }

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

/** The words each dialogue recording's longest saved transcript has, keyed by media. */
function transcripts(db: DatabaseSync) {
  const best = new Map<string, Word[]>();
  for (const row of db.prepare("select media_id, json from transcripts").all() as { media_id: string; json: string }[]) {
    const t = JSON.parse(row.json) as { segments?: { words?: Word[] }[] };
    const words = (t.segments ?? []).flatMap(s => s.words ?? []).filter(w => w.end > w.start);
    if (words.length > (best.get(row.media_id)?.length ?? 0)) best.set(row.media_id, words);
  }
  return best;
}

/** Words the edit plays, in playback order: each word whose middle a sounding audio clip plays, once per recording. */
function played(tracks: { kind?: string; clips: Clip[] }[], words: Map<string, Word[]>): Played[] {
  const out: Played[] = [], seen = new Set<string>();
  for (const track of tracks.filter(t => t.kind === "audio")) {
    for (const c of track.clips) {
      if (c.enabled === false || c.volume === 0 || !c.mediaId) continue;
      const speed = c.speed ?? 1;
      for (const w of words.get(c.mediaId) ?? []) {
        const middle = (w.start + w.end) / 2, key = `${c.mediaId}:${w.start}`;
        if (middle < c.sourceIn || middle >= c.sourceOut || seen.has(key)) continue;
        seen.add(key);
        out.push({ text: w.text, start: c.timelineIn + (w.start - c.sourceIn) / speed, end: c.timelineIn + (w.end - c.sourceIn) / speed, source: w.start, mediaId: c.mediaId });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The reasons the project's latest pass that ran the closing repeat check gave for the repeats it kept. */
function keptByLatestPass(db: DatabaseSync, projectId: string) {
  const tasks = db.prepare("select id from tasks where project_id = ? and kind = 'edit' order by created_at desc").all(projectId) as { id: string }[];
  for (const { id } of tasks) {
    let checked = false;
    const kept = new Map<string, string>();
    for (const row of db.prepare("select json from task_events where task_id = ? order by id").all(id) as { json: string }[]) {
      const e = JSON.parse(row.json) as { type?: string; data?: { tool?: string; input?: { keep?: { id: string; reason: string }[] } } };
      if (e.type !== "tool" || !e.data?.tool?.endsWith("dialogue_check_repeats")) continue;
      checked = true;
      for (const k of e.data.input?.keep ?? []) kept.set(k.id, k.reason);
    }
    if (checked) return { taskId: id, kept: [...kept.values()] };
  }
  return undefined;
}

export function leftovers(dbPath: string, only?: string): ProjectLeftovers[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const words = transcripts(db);
  const found: ProjectLeftovers[] = [];
  for (const p of db.prepare("select id, name, head from projects").all() as { id: string; name: string; head: string | null }[]) {
    if (!p.head || (only && only !== p.id && only !== p.name)) continue;
    const row = db.prepare("select json from timeline_versions where project_id = ? and version = ?").get(p.id, p.head) as { json: string } | undefined;
    if (!row) continue;
    const said = played((JSON.parse(row.json) as { tracks: { kind?: string; clips: Clip[] }[] }).tracks, words);
    if (said.length < 100) continue;
    const tokens = said.map(w => normalizeTranscriptToken(w.text)), starts = said.map(w => w.start), ends = said.map(w => w.end);
    const exact = new Set(findRestarts(tokens, starts, ends).map(r => r.next));
    const text = (from: number, to: number) => said.slice(Math.max(0, from), to).map(w => w.text.trim()).join(" ");
    const restarts = findRestarts(tokens, starts, ends, { cutOffWords: true }).map(r => ({
      at: Math.round(said[r.at]!.start * 100) / 100, source: Math.round(said[r.at]!.source * 100) / 100, mediaId: said[r.at]!.mediaId,
      before: text(r.at - 4, r.at), first: text(r.at, r.next), again: text(r.next, r.next + 6), cutOffOnly: !exact.has(r.next),
    }));
    found.push({ id: p.id, name: p.name, head: p.head, words: said.length, restarts, pass: keptByLatestPass(db, p.id) });
  }
  return found;
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = leftovers(arg("db") ?? join(appSupportDir(), "data", "scarlet.db"), arg("project"));
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 1));
  else {
    for (const p of result) {
      const cutOff = p.restarts.filter(r => r.cutOffOnly).length;
      console.log(`\n## ${p.name} (${p.id}, head ${p.head}): ${p.restarts.length} phrases play twice${cutOff ? `, ${cutOff} found only by a cut-off word` : ""}` +
        (p.pass ? `; its pass ${p.pass.taskId} kept ${p.pass.kept.length} repeats silently` : ""));
      for (const r of p.restarts) console.log(`  ${clock(r.at)}${r.cutOffOnly ? " *" : "  "} … ${r.before} [${r.first}] ${r.again} …  (src ${r.source})`);
    }
    console.log(`\n${result.reduce((n, p) => n + p.restarts.length, 0)} phrases play twice across ${result.length} edits. Read them: many are said twice on purpose.`);
  }
}

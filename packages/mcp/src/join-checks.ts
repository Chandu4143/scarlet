import { setTimeout as delay } from "node:timers/promises";
import { json, unmeasured, type ToolResult } from "./tool-result.js";

type JoinReading = Record<string, unknown>;
type Run = (publish: (index: number, reading: JoinReading) => void) => Promise<ToolResult>;

interface JoinJob {
  done: Promise<ToolResult>;
  readings: (JoinReading | undefined)[];
  missed: Map<string, string>;
  finished?: number;
}

/** A slow join check survives individual MCP calls in this session. Deliver its final reading once so a
 * later independent check gets fresh transcript, scan and audio evidence, even on the same timeline. */
export class JoinChecks {
  private readonly jobs = new Map<string, JoinJob>();

  async collect(key: string, version: string, count: number, run: Run, waitMs: number): Promise<ToolResult> {
    for (const [id, job] of this.jobs) {
      if (job.finished !== undefined && Date.now() - job.finished > 10 * 60_000) this.jobs.delete(id);
    }
    let job = this.jobs.get(key);
    if (!job) {
      if (this.jobs.size >= 16) {
        const oldest = [...this.jobs].filter(([, j]) => j.finished !== undefined).sort((a, b) => a[1].finished! - b[1].finished!)[0];
        if (oldest) this.jobs.delete(oldest[0]);
        else return json({ status: "busy", version, next: "Other join checks are still running. Collect one of those checks, then retry this one." });
      }
      const readings = Array<JoinReading | undefined>(count).fill(undefined);
      const missed = new Map<string, string>();
      const done = unmeasured.run(missed, () => run((index, reading) => { readings[index] = reading; }));
      const entry: JoinJob = { done, readings, missed };
      this.jobs.set(key, entry);
      job = entry;
      // Keep errors for the polling caller too. Removing a failed job here would silently start it again.
      const finish = () => { entry.finished = Date.now(); };
      void done.then(finish, finish);
    }
    const timer = new AbortController();
    const pending = Symbol("still measuring");
    try {
      const result = await Promise.race([job.done, delay(waitMs, pending, { signal: timer.signal, ref: false })]);
      if (typeof result !== "symbol") {
        if (this.jobs.get(key) === job) this.jobs.delete(key);
        for (const [what, why] of job.missed) unmeasured.getStore()?.set(what, why);
        return result;
      }
      const pendingCuts = job.readings.flatMap((reading, i) => reading ? [] : [i]);
      const joins = job.readings.map(reading => {
        if (!reading) return { status: "pending" };
        if (reading.error) return { error: reading.error };
        return { status: reading.status, start: reading.start, end: reading.end };
      });
      return json({ status: "measuring", version, joins, pendingCuts, retryAfterSeconds: 5,
        next: "Repeat this call with the same cuts and options on the returned version after 5 seconds for the full readings." });
    } catch (err) {
      if (this.jobs.get(key) === job) this.jobs.delete(key);
      throw err;
    } finally { timer.abort(); }
  }
}

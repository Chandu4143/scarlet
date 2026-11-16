import { useSyncExternalStore } from "react";
import type { EditRef } from "@scarlet/shared";
import { appLog, errorName } from "./appLog";

/**
 * Applied edits the editor has reviewed and kept, per thread. Keep only records the review: the edit is
 * already in the cut. A revision gets a new identity, so it needs a fresh look.
 */
const PREFIX = "scarlet.kept-edits.v1";
const listeners = new Set<() => void>();
/**
 * The parsed set for each key, with the stored text it came from so a change in storage is noticed.
 * sessionOnly marks a record that storage refused; it stands until storage holds something else.
 */
const cache = new Map<string, { raw: string | null; value: ReadonlySet<string>; sessionOnly?: boolean }>();

export const editKey = (ref: EditRef) => `${ref.changeId}/${ref.spot}`;
/**
 * What a Keep records. An edit that a later save gave a new reason to look is kept under that save's edit, and a doubt
 * a later request raised about an edit already in the video (`recheck`, when it was raised) is a new one, so a Keep
 * before it doesn't settle it.
 */
export const reviewKey = (ref: EditRef & { recheck?: string; reviewRef?: EditRef }) => {
  const key = editKey(ref.reviewRef ?? ref);
  return ref.recheck ? `${key}@${ref.recheck}` : key;
};
const storageKey = (projectId: string, threadId: string) => `${PREFIX}/${projectId}/${threadId}`;

let lastReadFailure: string | undefined;

function read(projectId: string, threadId: string): ReadonlySet<string> {
  const key = storageKey(projectId, threadId);
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
    lastReadFailure = undefined;
  } catch (error) {
    const name = errorName(error);
    if (name !== lastReadFailure) appLog("review", "keep-read-failed", { project: projectId, thread: threadId, name }, { level: "warn" });
    lastReadFailure = name;
  }
  const known = cache.get(key);
  // A record storage refused stands for the session, whatever storage still holds.
  if (known && (known.raw === raw || known.sessionOnly)) return known.value;
  let value: ReadonlySet<string> = new Set();
  try {
    const saved = JSON.parse(raw ?? "null");
    if (Array.isArray(saved)) value = new Set(saved.filter((k): k is string => typeof k === "string"));
  } catch (error) {
    appLog("review", "keep-read-failed", { project: projectId, thread: threadId, name: errorName(error) }, { level: "warn" });
  }
  cache.set(key, { raw, value });
  return value;
}

export function keepEdits(projectId: string, threadId: string, refs: Array<EditRef & { recheck?: string; reviewRef?: EditRef }>) {
  const key = storageKey(projectId, threadId);
  const before = read(projectId, threadId);
  const next = new Set(before);
  for (const ref of refs) next.add(reviewKey(ref));
  if (next.size === before.size) return false;
  const raw = JSON.stringify([...next]);
  const fields = { project: projectId, thread: threadId, count: next.size - before.size };
  try {
    localStorage.setItem(key, raw);
    cache.set(key, { raw, value: next });
    appLog("review", "kept", fields);
  } catch (error) {
    appLog("review", "keep-persist-failed", { ...fields, name: errorName(error) }, { level: "warn" });
    cache.set(key, { raw: null, value: next, sessionOnly: true });
  }
  for (const listener of listeners) listener();
  return true;
}

export function useKeptEdits(projectId: string, threadId: string | undefined): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => threadId ? read(projectId, threadId) : empty);
}
const empty: ReadonlySet<string> = new Set();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

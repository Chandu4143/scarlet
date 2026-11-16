import type { EditKind, ThreadEdit } from "@scarlet/shared";
import { focusAround, type ProgressFocus } from "../components/player/SimpleProgress";
import { lengthLabel } from "./format";

const WORDS: Partial<Record<EditKind, string>> = {
  cut: "Cut", restore: "Added", audio: "Audio", zoom: "Zoom", reframe: "Reframe", text: "Text", overlay: "Overlay", graphic: "Graphic", speed: "Speed", transition: "Transition",
};

/** One word for what an edit did, the same in the list, on the timeline and on the card. None for an assembly or a mix. */
export function editKindWord(edit: Pick<ThreadEdit, "kind">): string | undefined {
  return edit.kind && WORDS[edit.kind];
}

/** The card shows why Scarlet made the edit, followed by any cue for the editor to check. */
export function editNote(edit: Pick<ThreadEdit, "label" | "check" | "summary" | "reason" | "recheck" | "marker">): string {
  if (edit.reason) {
    if (!edit.check || edit.reason.includes(edit.check)) return edit.reason;
    return `${/[.!?]$/.test(edit.reason) ? edit.reason : `${edit.reason}.`} ${edit.check}`;
  }
  // Older summaries may already include the original review cue. A later doubt still needs to be shown, and so does
  // what a marker asks of the editor when the sentence leaves it out: nothing else on the card says it.
  const asks = edit.marker && edit.check && !said(edit.summary, edit.check);
  if (edit.summary && edit.check && (edit.recheck || asks)) return `${edit.summary.replace(/[.!?]*$/, ".")} ${edit.check.replace(/[.!?]*$/, ".")}`;
  if (edit.summary) return edit.summary;
  return edit.check ? `${edit.label.replace(/[.!?]+$/, "")}. ${edit.check}` : edit.label;
}

/** Whether a sentence already says a few words, whatever their case, spacing and closing stop. */
function said(sentence: string | undefined, words: string) {
  const plain = (text: string) => text.toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
  return !!sentence && plain(sentence).includes(plain(words));
}

/**
 * Where an edit sits on the timeline, drawn for what it did. A removal has no frames left, so a line marks its join.
 * Footage put back reads as added. Anything else keeps its footage, so After plays it: it's outlined and named, never
 * hatched like removed footage.
 */
export function editFocus(edit: ThreadEdit, duration: number): ProgressFocus | undefined {
  const word = editKindWord(edit);
  // A marker at a point took nothing out, so it isn't drawn or named as a cut.
  if (edit.at !== undefined) return focusAround({ start: edit.at, end: edit.at }, duration, word ?? (edit.marker ? undefined : "Cut"),
    edit.marker ? { tone: "kept" } : undefined);
  const restored = edit.kind === "restore";
  return focusAround(edit.range, duration, restored ? `Added · ${lengthLabel(edit.range.end - edit.range.start)}` : word,
    { tone: restored ? "added" : "kept" });
}

/** A transcript word as a join reads it: where it sounds in its recording, and whether the transcript ends a sentence on it. */
export interface SaidWord { text: string; start: number; end: number;
  /** The transcript closes a sentence here: the word ends in a full stop, question or exclamation mark, or is the last of its segment. */
  endsSentence?: boolean;
  /** The word's index in its transcript, when the list given isn't the whole transcript in its own order. */
  index?: number }

/** What plays either side of one join that took words out of a sentence, for whoever decides whether it still reads as a thought. */
export interface FragmentEvidence {
  /** The words the edit plays up to the join, and from it on: as many as `FRAGMENT_CONTEXT_WORDS` of the piece on that side. */
  before: string;
  after: string;
  /** The words the join took out: how many, the first of them and the last. */
  removed: number;
  removedStart: string;
  removedEnd: string;
  /** The side whose words belong to a sentence the join took the rest of: `out` began one, `in` finishes one. */
  split: Array<"out" | "in">;
  /** The last word played before the join and the first after it: their `index`, or their place in `words`. */
  lastWord: number;
  firstWord: number;
}

/** Words of context given either side of a join, and of what it removed. */
export const FRAGMENT_CONTEXT_WORDS = 10;
/**
 * A join that swaps one saying for its twin is the sentence as it was said: the played words up to it end as the
 * removed words end ("the new model from ‖ [DeepSeek, uh, the new model from] DeepSeek flew"), or the played words
 * after it begin as the removed words begin. One shared word is no twin: "and" starts half the sentences in a
 * recording, and matched a removed lead-in to the leftover clause that needed it.
 */
export const TWIN_WORDS = 2;

const ENDS_SENTENCE = /[.?!。？！…]["'”’)\]]*$/u;
/** Whether a transcript word closes a sentence by its own punctuation. */
export const closesSentence = (text: string) => ENDS_SENTENCE.test(text.trim());
const token = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}']/gu, "");

/**
 * What one join plays, when it took words out of a sentence: the piece before it ends at `out` in the recording and
 * the piece after it begins at `in`, later. `from` and `to` bound the two pieces, so the words given are the ones
 * those pieces play.
 *
 * A first pass left a "Do" in front of a sentence it had cut the rest of, "it gives me more" with nothing after it,
 * and "nine. ‖ actually able to name them all" without the clause that began it: eleven such joins in a 20-minute
 * edit, each with its words playing whole, so the check that hears clipped words passed them (2026-11-16). Whether
 * a join reads as a thought takes the sentence to tell. This only locates the joins where the transcript says a
 * sentence was divided, and gives the words: the model decides.
 *
 * Nothing for a join that took no words out (a pause), one whose two sides each stand at a sentence's edge, or one
 * that swaps a saying for its twin (`TWIN_WORDS`).
 */
export function joinFragment(words: readonly SaidWord[], out: number, inn: number, from = -Infinity, to = Infinity): FragmentEvidence | undefined {
  if (!(inn > out)) return undefined;
  const middle = (w: SaidWord) => (w.start + w.end) / 2;
  // `words` are in the order they sound, by their middles. The first one the join removes, and the first one played after it.
  let lo = 0, hi = words.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (middle(words[mid]!) < out) lo = mid + 1; else hi = mid; }
  const firstRemoved = lo;
  hi = words.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (middle(words[mid]!) < inn) lo = mid + 1; else hi = mid; }
  const firstKept = lo;
  if (firstKept === firstRemoved) return undefined;
  const lastKept = firstRemoved - 1;
  const played = (i: number) => i >= 0 && i < words.length && middle(words[i]!) >= from && middle(words[i]!) < to;
  const split: FragmentEvidence["split"] = [];
  // The sentence the last played word is in runs on into what was removed.
  if (played(lastKept) && !words[lastKept]!.endsSentence) split.push("out");
  // The first played word carries on a sentence that began in what was removed.
  if (played(firstKept) && !words[firstKept - 1]!.endsSentence) split.push("in");
  if (!split.length) return undefined;
  const same = (a: number, b: number) => { const t = token(words[a]!.text); return !!t && t === token(words[b]!.text); };
  let tail = 0, head = 0;
  while (played(lastKept - tail) && firstKept - 1 - tail >= firstRemoved && same(lastKept - tail, firstKept - 1 - tail)) tail++;
  while (played(firstKept + head) && firstRemoved + head < firstKept && same(firstKept + head, firstRemoved + head)) head++;
  if (tail >= TWIN_WORDS || head >= TWIN_WORDS) return undefined;
  const text = (a: number, b: number) => words.slice(Math.max(0, a), Math.max(0, b)).map(w => w.text.trim()).filter(Boolean).join(" ");
  let beforeFrom = lastKept + 1, afterTo = firstKept;
  while (beforeFrom > 0 && lastKept + 1 - beforeFrom < FRAGMENT_CONTEXT_WORDS && played(beforeFrom - 1)) beforeFrom--;
  while (afterTo < words.length && afterTo - firstKept < FRAGMENT_CONTEXT_WORDS && played(afterTo)) afterTo++;
  const removed = firstKept - firstRemoved;
  return { before: text(beforeFrom, lastKept + 1), after: text(firstKept, afterTo), removed,
    removedStart: text(firstRemoved, Math.min(firstKept, firstRemoved + FRAGMENT_CONTEXT_WORDS)),
    removedEnd: removed > FRAGMENT_CONTEXT_WORDS ? text(Math.max(firstRemoved + FRAGMENT_CONTEXT_WORDS, firstKept - FRAGMENT_CONTEXT_WORDS), firstKept) : "",
    split, lastWord: words[lastKept]?.index ?? lastKept, firstWord: words[firstKept]?.index ?? firstKept };
}

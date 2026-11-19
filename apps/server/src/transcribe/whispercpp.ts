import { readFile, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, win32 } from "node:path";
import { z } from "zod/v3";
import { normalizeTranscriptToken } from "@scarlet/shared";
import { newId, type TranscriptSegment, type TranscriptWord } from "@scarlet/timeline";
import { extractWav, run } from "../render/ffmpeg.js";
import { decodedRecording } from "../services/recordingAudio.js";
import { SAMPLE_RATE } from "./ctcAlign.js";
import type { TranscribeInput, TranscribeResult, TranscriptionProvider } from "./index.js";

const offsets = z.object({ from: z.number().finite(), to: z.number().finite() });
const whisperOutput = z.object({
  result: z.object({
    language: z.string().optional(),
    // Older adapters may already use this optional field for their own metadata.
    model: z.string().trim().min(1).optional().catch(undefined),
  }).optional(),
  transcription: z.array(z.object({
    offsets, text: z.string(),
    tokens: z.array(z.object({ text: z.string(), offsets: offsets.optional(), p: z.number().finite().optional() })).optional(),
  })),
});
type WhisperJson = z.infer<typeof whisperOutput>;

function adapterModelLabel(name?: string) {
  if (!name || name.includes("://")) return undefined;
  // Preserve registry IDs such as owner/checkpoint. A filesystem path only contributes its filename.
  return /^[\w-][\w.-]*\/[\w.-]+$/.test(name) ? name : win32.basename(name);
}

/** A successful adapter process must explicitly report silence with an empty transcription array. */
function readOutput(source: string): WhisperJson {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new Error("The local transcription adapter returned invalid JSON. Check its output format."); }
  const result = whisperOutput.safeParse(value);
  if (!result.success) {
    const field = result.error.issues[0]?.path.join(".") || "root";
    throw new Error(`The local transcription adapter returned an invalid field (${field}). Check its whisper.cpp JSON output format.`);
  }
  return result.data;
}

/**
 * whisper-cli uses 4 threads unless told otherwise. On a 24-thread Core Ultra 9, 8 threads transcribed
 * 10 minutes of dialogue about 10% faster than 4 (median of six runs) and a 52-minute recording 7% faster
 * (165 s against 178 s), while 16 took nearly three times as long: past the performance cores, efficiency
 * cores hold every step back. Same rule as the word aligner's ONNX session. A different thread count sums
 * in a different order, which can tip Whisper's close calls: the 52-minute transcripts differed in about
 * 3% of words, each an equally plausible reading, while the 10-minute ones matched exactly.
 */
export function whisperThreads(cores = availableParallelism()) {
  return Math.min(cores, cores >= 16 ? 8 : 4);
}

/**
 * Whether the bundled build runs on the GPU while the aligner, filler and speaker models run on the CPU. That is the
 * Apple silicon build, which uses Metal; ONNX Runtime has no GPU path for these models there. On Windows the GPU
 * build shares the GPU with DirectML, so Whisper keeps its turn among the other models.
 */
export function bundledWhisperOnGpu(platform: string = process.platform, arch: string = process.arch) {
  return platform === "darwin" && arch === "arm64";
}

/** GPU builds that failed a run the CPU build then finished. Each falls back to the CPU build until the engine restarts. */
const failedGpu = new Set<string>();

/** Save roughly two minutes per turn. Look for a pause either side before cutting the next WAV. */
const CHUNK_SECONDS = 120;
/**
 * Each window is a new process that loads its model again. For the CrisperWhisper adapter that is a Python start, a
 * torch import and its weights moved to the GPU, so it takes ten-minute windows: an hour is 6 loads rather than 30,
 * and a quit still keeps all but the window under way. It reads a whole recording in one run as well, so a longer
 * window is nothing it hasn't done.
 */
const CRISPER_CHUNK_SECONDS = 600;
const SEARCH_SECONDS = 4;
/**
 * Seconds each window reads past both ends of the stretch it writes. Whisper given audio that stops mid-sentence
 * finishes the sentence itself: a window that ended in the quarter-second pause after "…is that it is" read "it is
 * insane.", and ended 40 ms later "it is incredible.", where the speaker said "it is a fine model" (2026-11-18). The
 * aligner squeezed the made-up word into the pause, and a pass cut the real words around it as an abandoned wording.
 * Read on past the seam, Whisper hears how the sentence goes, and the words either side of a seam come from windows
 * that heard what came before and after them.
 */
const SEAM_CONTEXT = 8;
/** Seconds two windows' times for one word may differ by and still be the same word said once. */
const SAME_WORD_SECONDS = 1;

/** Where a window that starts at `start` ends: the quietest 200 ms within a few seconds of `seconds` later. */
export async function chunkEnd(audio: Awaited<ReturnType<typeof decodedRecording>>, start: number, duration: number, seconds: number) {
  const target = start + seconds;
  if (target + SEARCH_SECONDS >= duration) return duration;
  const from = target - SEARCH_SECONDS;
  const pcm = await audio.pcm(from, target + SEARCH_SECONDS);
  // The middle of the lowest-energy 200 ms makes a natural break in speech. When several windows
  // are silent, choose the one nearest the target. Avoid a fixed split in the middle of a word.
  const width = SAMPLE_RATE / 5;
  const step = SAMPLE_RATE / 50;
  let best = target, bestEnergy = Infinity;
  for (let at = 0; at + width <= pcm.length; at += step) {
    let energy = 0;
    for (let i = at; i < at + width; i++) energy += pcm[i]! ** 2;
    const middle = from + (at + width / 2) / SAMPLE_RATE;
    if (energy < bestEnergy || (energy === bestEnergy && Math.abs(middle - target) < Math.abs(best - target))) {
      bestEnergy = energy;
      best = middle;
    }
  }
  return best;
}

/** Local whisper.cpp: `whisper-cli -m model -f wav -ojf -of prefix`. */
export class WhisperCppProvider implements TranscriptionProvider {
  readonly name = "whispercpp";
  constructor(private readonly opts: {
    binary: string; model?: string | ((signal?: AbortSignal) => Promise<string>); language?: string;
    crisperScript?: string;
    beforeRun?: () => void;
    /** Tried first. A run that fails there, for example without a Vulkan driver, runs again on `binary`. */
    gpuBinary?: string;
    log?: (message: string) => void;
  }) {}

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    if (input.dialogueWindow) {
      return this.transcribeWav(input.path, input.tmpDir, input.signal, input.language, input.dialogueWindow.prompt);
    }
    const wav = input.keepWavAt ?? join(input.tmpDir, newId("wcpp") + ".wav");
    try {
      await extractWav(input.path, wav, { signal: input.signal });
      if (input.checkpoint) return await this.transcribeChunks(wav, input, input.checkpoint);
      return await this.transcribeWav(wav, input.tmpDir, input.signal, input.language, undefined, input.onProgress);
    } finally { if (!input.keepWavAt) await rm(wav, { force: true }); }
  }

  private async transcribeChunks(wav: string, input: TranscribeInput, checkpoint: NonNullable<TranscribeInput["checkpoint"]>): Promise<TranscribeResult> {
    const audio = await decodedRecording(wav);
    const duration = audio.samples / SAMPLE_RATE;
    const { onProgress } = input;
    const result = { ...checkpoint.result, segments: [...checkpoint.result.segments] };
    const part = join(input.tmpDir, newId("wcpp") + ".wav");
    const keep = (through: number, segments: TranscriptSegment[]) => {
      checkpoint.save(through, { language: result.language, modelLabel: result.modelLabel, segments }, through / duration);
      result.segments.push(...segments);
    };
    try {
      /** The words of the window before, from the last save on, until the next window says where it hands over. */
      let held: { segments: TranscriptSegment[]; seam: number } | undefined;
      for (let from = checkpoint.through; from < duration;) {
        input.signal?.throwIfAborted();
        const seam = await chunkEnd(audio, from, duration, this.opts.crisperScript ? CRISPER_CHUNK_SECONDS : CHUNK_SECONDS);
        const readFrom = Math.max(0, from - SEAM_CONTEXT), readTo = Math.min(duration, seam + SEAM_CONTEXT);
        const whole = readFrom === 0 && readTo === duration;
        if (!whole) await audio.writeWindow(part, readFrom, readTo);
        const selectedLanguage = input.language || this.opts.language;
        const language = selectedLanguage && selectedLanguage !== "auto" ? selectedLanguage : result.language;
        const chunk = await this.transcribeWav(whole ? wav : part, input.tmpDir, input.signal, language, undefined,
          onProgress && (fraction => onProgress((from + (seam - from) * fraction) / duration)));
        input.signal?.throwIfAborted();
        // Whisper's 10 ms times can round past the last sample of a window. Keep its words inside the
        // audio it heard and place them on the original recording's clock.
        const at = (seconds: number) => Math.min(readTo, Math.max(readFrom, readFrom + seconds));
        let segments = whole ? chunk.segments : chunk.segments.map(s => ({ ...s, start: at(s.start), end: at(s.end),
          words: s.words.map(w => ({ ...w, start: at(w.start), end: at(w.end) })) }));
        result.language ??= chunk.language;
        result.modelLabel ??= chunk.modelLabel;
        if (held) {
          const joined = seamWindows(held.segments, segments, held.seam);
          keep(joined.through, joined.before);
          segments = joined.after;
        } else if (from > 0) {
          // A resumed run: the saved words reach `from`, and this window's words before it are theirs.
          segments = sideOfSeam(segments, from).after;
        }
        held = { segments, seam };
        onProgress?.(seam / duration);
        from = seam;
      }
      if (held) keep(duration, held.segments);
      return result;
    } finally { await rm(part, { force: true }); }
  }

  async transcribeWav(wav: string, tmpDir: string, signal?: AbortSignal, language?: string, prompt?: string, onProgress?: (fraction: number) => void) {
    // Fetch the model before either build runs. A download that fails is nothing the GPU did: it is thrown as it is,
    // and no build runs.
    const model = typeof this.opts.model === "function" ? await this.opts.model(signal) : this.opts.model;
    const gpu = this.opts.gpuBinary;
    if (gpu && !failedGpu.has(gpu)) {
      try {
        return await this.runWhisper(gpu, model, wav, tmpDir, signal, language, prompt, onProgress);
      } catch (error) {
        signal?.throwIfAborted();
        this.opts.log?.(`[whisper] A run failed on the GPU build and runs again on the CPU build: ${(error as Error).message}`);
        // Only the same run finishing on the CPU build shows the failure was the GPU's. Audio whisper-cli can't read,
        // a full disk or a missing program fails there too: that error is thrown, and the next run tries the GPU again.
        const result = await this.runWhisper(this.opts.binary, model, wav, tmpDir, signal, language, prompt, onProgress);
        failedGpu.add(gpu);
        this.opts.log?.("[whisper] That run finished on the CPU build, so transcription uses the CPU until Scarlet restarts.");
        return result;
      }
    }
    return this.runWhisper(this.opts.binary, model, wav, tmpDir, signal, language, prompt, onProgress);
  }

  private async runWhisper(binary: string, model: string | undefined, wav: string, tmpDir: string, signal?: AbortSignal, language?: string, prompt?: string,
    onProgress?: (fraction: number) => void) {
    const base = join(tmpDir, newId("wcpp"));
    try {
      const args = this.opts.crisperScript ? ["-I", "-B", this.opts.crisperScript] : [];
      if (model) args.push("-m", model);
      args.push("-f", wav, "-ojf", "-of", base, "-np", "-l", language || this.opts.language || "auto", "-t", String(whisperThreads()));
      // Conditioning on earlier text can lock long recordings into repeating one sentence for minutes.
      // A prompt is part of that text context, so prompted dialogue windows keep it.
      if (prompt) args.push("--prompt", prompt);
      else args.push("-mc", "0");
      if (onProgress) args.push("-pp");
      const onStderrLine = (line: string) => {
        if (this.opts.crisperScript && /^crisperwhisper (?:device = (?:mps|cuda|cpu)|fallback = (?:mps|cuda))$/.test(line)) {
          this.opts.log?.(`[transcribe] ${line}`);
        }
        const percent = /progress\s*=\s*(\d+)%/.exec(line)?.[1];
        if (percent) onProgress?.(Math.min(1, Number(percent) / 100));
      };
      this.opts.beforeRun?.();
      await run(binary, args, { signal, onStderrLine: onProgress || this.opts.crisperScript ? onStderrLine : undefined });
      const json = readOutput(await readFile(base + ".json", "utf8"));
      const modelLabel = adapterModelLabel(json.result?.model);
      return { language: json.result?.language, segments: parseWhisperJson(json), ...(modelLabel && { modelLabel }) };
    } finally { await rm(base + ".json", { force: true }); }
  }
}

export function parseWhisperJson(json: Partial<WhisperJson>): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  const segments = json.transcription ?? [];
  for (const [index, seg] of segments.entries()) {
    const start = seg.offsets.from / 1000;
    const end = seg.offsets.to / 1000;
    const words: TranscriptWord[] = [];
    for (const tok of seg.tokens ?? []) {
      const text = tok.text;
      if (!tok.offsets || !text || /^\[_.*\]$/.test(text) || /^<\|.*\|>$/.test(text)) continue;
      const ws = tok.offsets.from / 1000;
      const we = tok.offsets.to / 1000;
      const prev = words[words.length - 1];
      // Sub-word pieces (no leading space) attach to the previous word.
      if (prev && !text.startsWith(" ")) {
        prev.text += text.trim();
        prev.end = Math.max(prev.end, we);
        continue;
      }
      words.push({ text: text.trim(), start: ws, end: Math.max(ws, we), confidence: tok.p });
    }
    const segment = { id: newId("seg"), start, end: Math.max(start, end), text: seg.text.trim(), words: words.filter((w) => w.text) };
    if (index === segments.length - 1 && repeatsTail(out.at(-1), segment)) continue;
    out.push(segment);
  }
  return out;
}

/** Words in the longest copy of a line's end that repeatsTail takes for Whisper's. */
const TAIL_COPY_WORDS = 4;

/**
 * Whisper can write the end of a line again over the quiet at the end of the audio it reads: "…coming in behind it at
 * $3.26." and then "$3.26.", two seconds after it was said. The aligner placed the copy on the price's sound and pulled
 * the words before it early. A last segment that is only the last few words of the one before, after it ends, is that
 * copy. A speaker who says them again mid-recording is in the middle of a window, so it stays.
 */
function repeatsTail(before: TranscriptSegment | undefined, segment: TranscriptSegment) {
  if (!before || !segment.words.length || segment.words.length > TAIL_COPY_WORDS || segment.start < before.end) return false;
  const said = (words: TranscriptWord[]) => words.map(w => normalizeTranscriptToken(w.text)).filter(Boolean);
  const copy = said(segment.words), last = said(before.words).slice(-copy.length);
  return copy.length > 0 && last.length === copy.length && copy.every((w, i) => w === last[i]);
}

const midpoint = (w: TranscriptWord) => (w.start + w.end) / 2;
type Placed = { segment: number; word: TranscriptWord };
const placed = (segments: readonly TranscriptSegment[]): Placed[] =>
  segments.flatMap((s, segment) => s.words.map(word => ({ segment, word })));

/** The segments with only the words `kept` holds; a segment with no words stays on the side its middle is on. */
function keepWords(segments: readonly TranscriptSegment[], kept: ReadonlySet<TranscriptWord>, side: (time: number) => boolean) {
  const out: TranscriptSegment[] = [];
  for (const segment of segments) {
    if (!segment.words.length) {
      if (side((segment.start + segment.end) / 2)) out.push(segment);
      continue;
    }
    const words = segment.words.filter(w => kept.has(w));
    if (!words.length) continue;
    if (words.length === segment.words.length) { out.push(segment); continue; }
    out.push({ ...segment, text: words.map(w => w.text).join(" "),
      start: words[0] === segment.words[0] ? segment.start : words[0]!.start,
      end: words.at(-1) === segment.words.at(-1) ? segment.end : words.at(-1)!.end, words });
  }
  return out;
}

/** Words split by where their middle falls: before `seam` or from it on. */
export function sideOfSeam(segments: readonly TranscriptSegment[], seam: number) {
  const words = placed(segments).map(p => p.word);
  return {
    before: keepWords(segments, new Set(words.filter(w => midpoint(w) < seam)), t => t < seam),
    after: keepWords(segments, new Set(words.filter(w => midpoint(w) >= seam)), t => t >= seam),
  };
}

/**
 * Where two overlapping windows hand over. Each read the seam with audio either side, so where both readings have a
 * word near it, the earlier window's words run to that word and the later window's go on after it: nothing is written
 * twice or left out, whatever times each gave. With no word in common near the seam (quiet, or two different readings
 * of a garbled stretch), each keeps the words whose middle is on its own side. `through` is where the earlier words end.
 */
export function seamWindows(before: readonly TranscriptSegment[], after: readonly TranscriptSegment[], seam: number) {
  const a = placed(before).filter(p => midpoint(p.word) >= seam - SEAM_CONTEXT);
  const b = placed(after).filter(p => midpoint(p.word) < seam + SEAM_CONTEXT);
  const ta = a.map(p => normalizeTranscriptToken(p.word.text)), tb = b.map(p => normalizeTranscriptToken(p.word.text));
  // Longest run of words both readings have in order, from the end, so the walk below goes forward.
  const n = a.length, m = b.length, lcs = new Uint16Array((n + 1) * (m + 1)), at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[at(i, j)] = ta[i] && ta[i] === tb[j] ? lcs[at(i + 1, j + 1)]! + 1 : Math.max(lcs[at(i + 1, j)]!, lcs[at(i, j + 1)]!);
  }
  let best: { i: number; j: number; off: number } | undefined;
  for (let i = 0, j = 0; i < n && j < m;) {
    if (ta[i] && ta[i] === tb[j] && lcs[at(i, j)] === lcs[at(i + 1, j + 1)]! + 1) {
      const wa = a[i]!.word, wb = b[j]!.word;
      const off = Math.abs((midpoint(wa) + midpoint(wb)) / 2 - seam);
      if (Math.abs(midpoint(wa) - midpoint(wb)) <= SAME_WORD_SECONDS && (!best || off < best.off)) best = { i, j, off };
      i++; j++;
    } else if (lcs[at(i + 1, j)]! >= lcs[at(i, j + 1)]!) i++;
    else j++;
  }
  if (!best) return { before: sideOfSeam(before, seam).before, after: sideOfSeam(after, seam).after, through: seam };
  const last = a[best.i]!.word, first = b[best.j]!.word;
  const wordsA = placed(before).map(p => p.word), wordsB = placed(after).map(p => p.word);
  const keptA = new Set(wordsA.slice(0, wordsA.indexOf(last) + 1)), keptB = new Set(wordsB.slice(wordsB.indexOf(first) + 1));
  const through = last.end;
  return { before: keepWords(before, keptA, t => t < through), after: keepWords(after, keptB, t => t >= through), through };
}

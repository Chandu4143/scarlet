import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { PictureMark, PictureMarkKind } from "@scarlet/shared";
import { player } from "../../lib/player";
import { usePlayerStore } from "../../stores/player";
import { usePictureMarksStore, type MarkedFrame } from "../../stores/pictureMarks";
import { Icon } from "../ui/primitives";

/** The marks on a frame, drawn over whatever shows it: the picture on the player, or its small copy by the message box. */
export function MarksDrawing({ marks, live }: { marks: readonly PictureMark[]; live?: PictureMark }) {
  const all = live ? [...marks, live] : marks;
  // One mark needs no number. With several, each has its own, so the words can say which.
  const numbered = all.length > 1;
  return <>
    <svg className="picture-marks-lines" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
      {all.map((mark, i) => mark.kind === "box"
        ? <rect key={i} x={mark.box.x} y={mark.box.y} width={mark.box.w} height={mark.box.h} vectorEffect="non-scaling-stroke" />
        : mark.kind === "draw" && mark.points && <polyline key={i} points={mark.points.map(p => p.join(",")).join(" ")} vectorEffect="non-scaling-stroke" />)}
    </svg>
    {all.map((mark, i) => mark.kind === "point"
      ? <span key={i} className="picture-mark-point" style={{ left: `${mark.box.x * 100}%`, top: `${mark.box.y * 100}%` }}>{numbered ? i + 1 : ""}</span>
      : numbered && <span key={i} className="picture-mark-number" style={{ left: `${mark.box.x * 100}%`, top: `${mark.box.y * 100}%` }}>{i + 1}</span>)}
  </>;
}

const TOOLS: { tool: PictureMarkKind; label: string; key: string; icon: "pencil" | "box" | "point" }[] = [
  { tool: "draw", label: "Draw", key: "D", icon: "pencil" },
  { tool: "box", label: "Box", key: "B", icon: "box" },
  { tool: "point", label: "Point", key: "P", icon: "point" },
];

/** How far apart, in fractions of the frame, the points kept along a line drawn by hand are. */
const STEP = 0.004;
const clamp = (n: number) => Math.min(1, Math.max(0, n));
const round = (n: number) => Math.round(n * 1e4) / 1e4;

function boxOf(points: [number, number][]) {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x: round(x), y: round(y), w: round(Math.max(...xs) - x), h: round(Math.max(...ys) - y) };
}

/** A line keeps at most 200 points, as the engine takes them, evenly picked along it. */
function thin(points: [number, number][]): [number, number][] {
  if (points.length <= 200) return points;
  return Array.from({ length: 200 }, (_, i) => points[Math.round(i * (points.length - 1) / 199)]!);
}

/**
 * The editor's marks on the picture. M (or a tool over the picture) pauses the video and lets them draw on
 * the frame: a line by hand, a box or a point. The marks ride on the next message, as a file dropped on the box does,
 * and show on the picture whenever the player rests on their frame.
 */
export function PictureMarks({ projectId, version, mediaId, fps }: { projectId: string; version?: string; mediaId?: string; fps: number }) {
  const frame = usePictureMarksStore(s => s.byProject[projectId]);
  const marking = usePictureMarksStore(s => s.marking === projectId);
  const tool = usePictureMarksStore(s => s.tool);
  const playing = usePlayerStore(s => s.playing);
  const onFrame = usePlayerStore(s => !!frame && Math.abs(s.time - frame.time) < 0.5 / Math.max(1, fps));
  const sameVideo = !!frame && frame.version === version && frame.mediaId === mediaId;
  const [live, setLive] = useState<PictureMark>();
  const drawing = useRef<{ start: [number, number]; points: [number, number][]; id: number }>(undefined);
  const surface = useRef<HTMLDivElement>(null);

  // Playing on, or another video under the player, ends the marking. The marks stay with the message.
  useEffect(() => { if (marking && (playing || !sameVideo)) usePictureMarksStore.getState().stop(); }, [marking, playing, sameVideo]);
  useEffect(() => () => { if (usePictureMarksStore.getState().marking === projectId) usePictureMarksStore.getState().stop(); }, [projectId]);

  // While marking, its keys come first, unless the editor is typing: Esc leaves, ⌘Z takes the last mark off, D B P pick the tool.
  useEffect(() => {
    if (!marking) return;
    const key = (e: KeyboardEvent) => {
      const typing = e.target instanceof Element && !!e.target.closest("input, textarea, select, [contenteditable='true']");
      if (typing || e.isComposing) return;
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      const store = usePictureMarksStore.getState();
      const pick = plain && TOOLS.find(t => t.key.toLowerCase() === e.key.toLowerCase());
      if (e.key === "Escape" && plain) store.stop();
      else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") store.undo(projectId);
      else if (pick) store.setTool(pick.tool);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [marking, projectId]);

  if (!frame || !sameVideo || !(marking || (onFrame && !playing && frame.marks.length))) return null;

  const at = (e: ReactPointerEvent): [number, number] => {
    const box = surface.current!.getBoundingClientRect();
    return [round(clamp((e.clientX - box.left) / box.width)), round(clamp((e.clientY - box.top) / box.height))];
  };
  const shape = (start: [number, number], points: [number, number][]): PictureMark | undefined => {
    const end = points[points.length - 1]!;
    if (tool === "point") return { kind: "point", box: { x: end[0], y: end[1], w: 0, h: 0 } };
    const bounds = boxOf(tool === "box" ? [start, end] : points);
    // A press that hardly moved puts a point there.
    if (bounds.w < 0.01 && bounds.h < 0.01) return { kind: "point", box: { x: start[0], y: start[1], w: 0, h: 0 } };
    return tool === "box" ? { kind: "box", box: bounds } : { kind: "draw", box: bounds, points: thin(points) };
  };

  return <div className="video-surface picture-marks" data-marking={marking || undefined}>
    <div ref={surface} className="video-frame picture-marks-frame"
      onPointerDown={marking ? e => {
        if (e.button !== 0) return;
        e.preventDefault();
        // The line follows the pointer off the picture, and ends where it is let go.
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* a pointer already gone */ }
        const start = at(e);
        drawing.current = { start, points: [start], id: e.pointerId };
        setLive(shape(start, [start]));
      } : undefined}
      onPointerMove={marking ? e => {
        const line = drawing.current;
        if (!line || line.id !== e.pointerId) return;
        const point = at(e);
        const last = line.points[line.points.length - 1]!;
        if (Math.hypot(point[0] - last[0], point[1] - last[1]) < STEP) return;
        line.points.push(point);
        setLive(shape(line.start, line.points));
      } : undefined}
      onPointerUp={marking ? e => {
        const line = drawing.current;
        if (!line || line.id !== e.pointerId) return;
        drawing.current = undefined;
        setLive(undefined);
        const mark = shape(line.start, [...line.points, at(e)]);
        if (mark) usePictureMarksStore.getState().add(projectId, mark);
      } : undefined}
      onPointerCancel={() => { drawing.current = undefined; setLive(undefined); }}>
      <MarksDrawing marks={frame.marks} live={live} />
    </div>
  </div>;
}

/**
 * The marking tools, always over the top left of the picture. A tool pressed while the video plays pauses it and marks
 * the frame under the playhead; the lit tool pressed again ends the marking.
 */
export function PictureMarkTools({ projectId, enabled, onStart }: { projectId: string; enabled: boolean; onStart: () => void }) {
  const marking = usePictureMarksStore(s => s.marking === projectId);
  const tool = usePictureMarksStore(s => s.tool);
  const count = usePictureMarksStore(s => s.byProject[projectId]?.marks.length ?? 0);
  const store = usePictureMarksStore.getState();
  const pick = (next: PictureMarkKind) => {
    if (marking && tool === next) return store.stop();
    store.setTool(next);
    if (!marking) onStart();
  };
  return <div className="video-surface picture-mark-bar">
    <div className="video-frame">
      <div className="picture-mark-tools" role="toolbar" aria-label="Mark the picture" onPointerDown={e => e.stopPropagation()}>
        {TOOLS.map(t => <button key={t.tool} type="button" className="picture-mark-tool" aria-pressed={marking && tool === t.tool} disabled={!enabled}
          aria-label={t.label} title={`${t.label} (${t.key})`} onClick={e => { if (e.detail) e.currentTarget.blur(); pick(t.tool); }}><Icon name={t.icon} size={15} /></button>)}
        <i className="picture-mark-sep" aria-hidden="true" />
        <button type="button" className="picture-mark-tool" aria-label="Undo" title="Undo (⌘Z)" disabled={!count} onClick={() => store.undo(projectId)}><Icon name="undo" size={15} /></button>
        <button type="button" className="picture-mark-tool" aria-label="Clear marks" title="Clear marks" disabled={!count} onClick={() => store.clear(projectId)}><Icon name="x" size={15} /></button>
      </div>
    </div>
  </div>;
}

/** Mark the frame under the playhead, or go back to the frame already marked. M, or a tool over the picture. */
export function toggleMarking(projectId: string, at: Omit<MarkedFrame, "marks">) {
  const store = usePictureMarksStore.getState();
  if (store.marking === projectId) return store.stop();
  player.pause();
  const frame = store.start(projectId, at);
  if (Math.abs(frame.time - at.time) > 1e-6) player.seek(frame.time, true);
}

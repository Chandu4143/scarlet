// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { player } from "../../lib/player";
import { usePictureMarksStore } from "../../stores/pictureMarks";
import { usePlayerStore } from "../../stores/player";
import { PictureMarkTools, PictureMarks, toggleMarking } from "./PictureMarks";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  usePlayerStore.setState({ time: 7, playing: false });
  usePictureMarksStore.setState({ marking: null, tool: "draw", byProject: {} });
  vi.spyOn(player, "pause").mockImplementation(() => {});
  vi.spyOn(player, "seek").mockImplementation(() => {});
  // The picture is 400 by 200 at the page's top left.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON() {} } as DOMRect);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const start = () => toggleMarking("prj", { time: usePlayerStore.getState().time, version: "v1" });
const show = () => act(async () => root.render(<>
  <PictureMarks projectId="prj" version="v1" fps={25} />
  <PictureMarkTools projectId="prj" enabled onStart={start} />
</>));
const press = (type: string, x: number, y: number) => act(async () => {
  const frame = container.querySelector(".picture-marks-frame")!;
  frame.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0 }));
});
const marks = () => usePictureMarksStore.getState().byProject.prj?.marks ?? [];

it("draws a line, a box and a point on the frame, in fractions of the picture, and numbers them once there are several", async () => {
  await show();
  expect(container.querySelector(".picture-marks")).toBeNull();
  // The tools are always over the picture, with no time beside them.
  expect(container.querySelector(".picture-mark-tools")?.textContent).toBe("");
  expect(container.querySelector('[aria-label="Draw"]')?.getAttribute("aria-pressed")).toBe("false");
  await act(async () => toggleMarking("prj", { time: 7, version: "v1", picture: "frame://7" }));
  expect(player.pause).toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Draw"]')?.getAttribute("aria-pressed")).toBe("true");
  await press("pointerdown", 200, 60);
  await press("pointermove", 240, 100);
  await press("pointermove", 200, 140);
  await press("pointermove", 160, 100);
  await press("pointerup", 200, 62);
  expect(marks()).toHaveLength(1);
  expect(marks()[0]).toMatchObject({ kind: "draw", box: { x: 0.4, y: 0.3, w: 0.2, h: 0.4 } });
  expect(container.querySelector(".picture-mark-number")).toBeNull();

  await act(async () => (container.querySelector('[aria-label="Box"]') as HTMLButtonElement).click());
  await press("pointerdown", 20, 20);
  await press("pointermove", 100, 80);
  await press("pointerup", 100, 80);
  expect(marks()[1]).toEqual({ kind: "box", box: { x: 0.05, y: 0.1, w: 0.2, h: 0.3 } });

  // A press that hardly moves puts a point there, whatever the tool.
  await press("pointerdown", 360, 40);
  await press("pointerup", 361, 40);
  expect(marks()[2]).toEqual({ kind: "point", box: { x: 0.9, y: 0.2, w: 0, h: 0 } });
  expect(Array.from(container.querySelectorAll(".picture-mark-number, .picture-mark-point"), n => n.textContent)).toEqual(["1", "2", "3"]);
});

it("leaves marking on Esc or when the video plays on, and keeps the marks for the message", async () => {
  await show();
  await act(async () => toggleMarking("prj", { time: 7, version: "v1" }));
  await act(async () => (container.querySelector('[aria-label="Point"]') as HTMLButtonElement).click());
  await press("pointerdown", 100, 100);
  await press("pointerup", 100, 100);
  // ⌘Z takes the last mark off, D B P pick the tool.
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true })); });
  expect(usePictureMarksStore.getState().tool).toBe("box");
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(usePictureMarksStore.getState().marking).toBeNull();
  // Resting on the marked frame, the marks show, and the picture doesn't take the pointer.
  expect(container.querySelector(".picture-marks:not([data-marking]) .picture-mark-point")).not.toBeNull();
  await act(async () => usePlayerStore.setState({ playing: true }));
  expect(container.querySelector(".picture-marks")).toBeNull();
  expect(marks()).toHaveLength(1);
  // Marking again starts on the frame that holds the marks.
  await act(async () => usePlayerStore.setState({ playing: false, time: 12 }));
  await act(async () => toggleMarking("prj", { time: 12, version: "v1" }));
  expect(player.seek).toHaveBeenCalledWith(7, true);
  await act(async () => usePlayerStore.setState({ time: 7 }));
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true })); });
  expect(marks()).toHaveLength(0);
});

it("starts marking from a tool over the picture, and ends it when the lit tool is pressed again", async () => {
  await show();
  const tool = (name: string) => container.querySelector(`[aria-label="${name}"]`) as HTMLButtonElement;
  expect(tool("Undo").disabled).toBe(true);
  await act(async () => tool("Box").click());
  expect(player.pause).toHaveBeenCalled();
  expect(usePictureMarksStore.getState()).toMatchObject({ marking: "prj", tool: "box" });
  await press("pointerdown", 20, 20);
  await press("pointermove", 100, 80);
  await press("pointerup", 100, 80);
  expect(tool("Undo").disabled).toBe(false);
  await act(async () => tool("Box").click());
  expect(usePictureMarksStore.getState().marking).toBeNull();
  expect(marks()).toHaveLength(1);
  await act(async () => tool("Clear marks").click());
  expect(marks()).toHaveLength(0);
});

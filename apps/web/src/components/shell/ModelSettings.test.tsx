// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { buildDb } from "../../lib/mock/fixtures";
import { useHostsStore } from "../../stores/hosts";
import { useModelPreferences } from "../../stores/modelPicker";
import { ModelSettings } from "./ModelSettings";

it("renders each model on one line and places disabled models below active ones", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const oldHosts = useHostsStore.getState();
  const oldPrefs = useModelPreferences.getState();
  const host = buildDb().hosts[0]!;
  useHostsStore.setState({
    hosts: [{
      ...host,
      online: true,
      agents: [{
        id: "claude",
        installed: true,
        models: ["opus", "fable[1m]", "sonnet", "haiku"],
        modelLabels: {
          opus: "Opus 5.5",
          "fable[1m]": "Fable 5.2",
          sonnet: "Sonnet 5.5",
          haiku: "Haiku 5.5",
        },
      }],
    }],
  });
  useModelPreferences.setState({ hidden: ["claude:opus", "claude:sonnet"], favorites: [] });

  const container = document.createElement("div");
  const root = createRoot(container);
  const rows = () => [...container.querySelectorAll("li")];
  const labels = () => rows().map(li => li.querySelector("span")!.textContent);
  const toggle = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="Show Claude Code · ${label} in selector"]`)!;

  try {
    await act(() => root.render(<MemoryRouter><ModelSettings /></MemoryRouter>));

    // Active models appear first in catalog order, disabled models below them in catalog order.
    expect(labels()).toEqual(["Fable 5.2", "Haiku 5.5", "Opus 5.5", "Sonnet 5.5"]);

    // Label and raw model id share a single flex row.
    const textRow = rows()[0]!.querySelector("div")!;
    expect(textRow.className).toContain("flex");
    expect([...textRow.children].map(el => el.textContent)).toEqual(["Fable 5.2", "fable[1m]"]);

    // Turning off an active model moves it below the remaining active models.
    await act(() => toggle("Fable 5.2").click());
    expect(labels()).toEqual(["Haiku 5.5", "Opus 5.5", "Fable 5.2", "Sonnet 5.5"]);

    // Turning a disabled model back on moves it back up with the active models.
    await act(() => toggle("Opus 5.5").click());
    expect(labels()).toEqual(["Opus 5.5", "Haiku 5.5", "Fable 5.2", "Sonnet 5.5"]);
  } finally {
    await act(() => root.unmount());
    useHostsStore.setState(oldHosts, true);
    useModelPreferences.setState(oldPrefs, true);
    vi.unstubAllGlobals();
  }
});

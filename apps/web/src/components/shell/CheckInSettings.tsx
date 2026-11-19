import { useEffect, useState } from "react";
import type { CheckIn } from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";
import { PreferenceSelect } from "../ui/PreferenceSelect";
import { Icon, InlineError } from "../ui/primitives";

const steps: { value: CheckIn; label: string; brings: string }[] = [
  { value: "less", label: "Less", brings: "Only the cuts Scarlet calls a guess." },
  { value: "balanced", label: "Balanced", brings: "Cuts Scarlet thinks are probably right but couldn’t settle, and its guesses." },
  { value: "more", label: "More", brings: "Every cut Scarlet isn’t certain of." },
];

/**
 * How much Scarlet checks with the editor. Scarlet says how sure it is of each cut as it makes it; this picks how far
 * down that scale the editor is asked to look. The same for every project, saved as soon as it is chosen.
 */
export function CheckInSettings() {
  const [value, setValue] = useState<CheckIn | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void api.settings().then(r => { if (current) setValue(r.settings.checkIn); }).catch(e => { if (current) setError(errorMessage(e)); });
    return () => { current = false; };
  }, []);
  if (!value) return error ? <InlineError>{error}</InlineError> : null;
  const choose = async (next: CheckIn) => {
    const previous = value;
    setValue(next);
    setError("");
    setBusy(true);
    try {
      setValue((await api.updateSettings({ checkIn: next })).settings.checkIn);
    } catch (e) {
      setValue(previous);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card transcription-preferences check-in-preferences" aria-labelledby="check-in-heading">
      <div className="transcription-header">
        <div className="transcription-heading">
          <span className="transcription-glyph"><Icon name="review" size={22} /></span>
          <div>
            <h2 id="check-in-heading">Checking with you</h2>
            <p>How many of the cuts Scarlet isn’t sure of it asks you to check.</p>
          </div>
        </div>
        <div className="min-w-0">
          <label className="label" htmlFor="check-in">Ask me to check</label>
          <PreferenceSelect id="check-in" value={value} disabled={busy} options={steps} onChange={next => void choose(next)} />
        </div>
      </div>
      <p className="transcription-status text-muted">{steps.find(step => step.value === value)!.brings} They go into the video either way and wait in For you until you keep them.</p>
      {error && <InlineError>{error}</InlineError>}
    </section>
  );
}

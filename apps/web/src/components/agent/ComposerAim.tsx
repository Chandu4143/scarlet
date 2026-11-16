import { useEffect, useState } from "react";
import { useUiStore } from "../../stores/ui";
import { Icon } from "../ui/primitives";

/** One thing the message is about: a cut, edit, moment, or marked stretch. */
export interface AimItem {
  key: string;
  name: string;
  clearLabel: string;
  onClear(): void;
}

/** An edit point: two clips meeting at a line. */
function EditPoint({ className }: { className?: string }) {
  return <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true"><path d="M8 1.5v13" /><path d="M3 4.5h3.5v7H3M13 4.5H9.5v7H13" /></svg>;
}

export function ComposerAim({ items, cue, onClick, disabled, disabledReason }: {
  items: AimItem[]; cue: number; onClick(): void; disabled?: boolean; disabledReason?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const setLit = useUiStore(s => s.setAimLit);
  useEffect(() => {
    setLit(hovered || focused);
    return () => setLit(false);
  }, [hovered, focused, setLit]);

  return <span className="composer-aim" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}>
    <button type="button" className="composer-aim-icon" aria-label={`About ${items.map(item => item.name).join(" and ")}`} onClick={onClick}>
      <EditPoint />
      {cue > 0 && <EditPoint key={cue} className="composer-aim-sheen" />}
    </button>
    {items.map(item => <button key={item.key} type="button" className="composer-aim-clear" disabled={disabled}
      title={item.clearLabel} aria-label={item.clearLabel} aria-description={disabled ? disabledReason : undefined} onClick={item.onClear}>
      <Icon name="x" size={10} />
    </button>)}
  </span>;
}

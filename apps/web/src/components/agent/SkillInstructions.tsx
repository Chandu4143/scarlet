import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { GraphicTemplateSummary, Skill } from "@scarlet/shared";
import { isComposing } from "../../lib/hotkeys";
import { useSkillsStore } from "../../stores/skills";
import { templatePreview, templateTokens, useTemplatesStore } from "../../stores/templates";
import { MAKE_TEMPLATE } from "./SkillCommandInput";
import { templateDetail, templateMatches, TemplateMenu, TransitionPicture } from "./TemplateMenu";

/** A `$template` or `/skill` the library has, where it is in the text. Words the library has no template or skill for stay plain. */
export function keywordSpans(text: string, templates: readonly Pick<GraphicTemplateSummary, "name">[], skills: readonly Pick<Skill, "name">[]) {
  const names = { $: new Set(templates.map(t => t.name)), "/": new Set(skills.map(s => s.name)) };
  return Array.from(text.matchAll(/(^|[^\w$/])([$/])([a-z0-9][a-z0-9-]*)/gi), m => {
    const sign = m[2] as "$" | "/", name = m[3]!;
    const start = m.index + m[1]!.length;
    return names[sign].has(name) ? { start, end: start + 1 + name.length, sign, name } : undefined;
  }).filter(k => !!k);
}

/** The text with each keyword in a faint fill, so the editor can tell a template or skill of theirs from plain words. */
export function MarkedKeywords({ text, templates, skills }: { text: string; templates?: readonly GraphicTemplateSummary[]; skills?: readonly Skill[] }) {
  const libraryTemplates = useTemplatesStore(s => s.templates);
  const librarySkills = useSkillsStore(s => s.skills);
  const parts: ReactNode[] = [];
  let at = 0;
  for (const k of keywordSpans(text, templates ?? libraryTemplates, skills ?? librarySkills)) {
    parts.push(text.slice(at, k.start), <span key={k.start} className="skill-keyword">{text.slice(k.start, k.end)}</span>);
    at = k.end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/** What a keyword is, as its hover note says it: its picture, its name and what kind of thing it is. */
function KeywordNote({ keyword, templates, skills }: { keyword: { sign: "$" | "/"; name: string }; templates: readonly GraphicTemplateSummary[]; skills: readonly Skill[] }) {
  if (keyword.sign === "/") {
    const skill = skills.find(s => s.name === keyword.name);
    return <><span className="skill-keyword-words"><span>/{keyword.name}</span><small>Skill{skill?.description ? ` · ${skill.description}` : ""}</small></span></>;
  }
  const template = templates.find(t => t.name === keyword.name);
  if (!template) return null;
  const transition = template.kind === "transition" && template.transition;
  return <>
    <span className="composer-template-thumb" aria-hidden="true">
      {transition ? <TransitionPicture transition={transition} /> : <img src={templatePreview(template)} alt="" loading="lazy" />}
    </span>
    <span className="skill-keyword-words"><span>{template.title}</span>
      <small>{transition ? "Transition" : "Graphic"}{templateDetail(template) ? ` · ${templateDetail(template)}` : ""}</small></span>
  </>;
}

interface Props {
  value: string;
  onChange(value: string): void;
  readOnly?: boolean;
  placeholder?: string;
  describedBy?: string;
  className: string;
}

/**
 * A skill's instructions, as the editor writes them. A `$template` or `/skill` of theirs has a faint fill and says what
 * it is on hover, and `$` lists the templates at the cursor, as the message box does, to put one's name in.
 */
export function SkillInstructions({ value, onChange, readOnly, placeholder, describedBy, className }: Props) {
  const box = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const caretMark = useRef<HTMLSpanElement>(null);
  const activeRow = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const templates = useTemplatesStore(s => s.templates);
  const templateStatus = useTemplatesStore(s => s.status);
  const loadTemplates = useTemplatesStore(s => s.load);
  const skills = useSkillsStore(s => s.skills);
  const skillStatus = useSkillsStore(s => s.status);
  const loadSkills = useSkillsStore(s => s.load);
  const [caret, setCaret] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [index, setIndex] = useState<number | "create">(0);
  const [hover, setHover] = useState<{ sign: "$" | "/"; name: string; left: number; top: number } | null>(null);
  const [place, setPlace] = useState<CSSProperties>();

  // Keywords are known by the library's templates and skills, so both are read as the page opens.
  useEffect(() => { void loadTemplates(); }, [loadTemplates]);
  useEffect(() => { if (skillStatus === "idle") void loadSkills(); }, [skillStatus, loadSkills]);

  const token = caret === null ? undefined : templateTokens(value).find(t => t.start < caret && caret <= t.end);
  const open = focused && !dismissed && !readOnly && !!token;
  const query = token && caret !== null ? value.slice(token.start + 1, caret).toLowerCase() : "";
  const rows = open ? templateMatches(templates, query) : [];
  const activeIndex = index === "create" ? rows.length : Math.min(index, rows.length - 1);
  const active = index === "create" ? undefined : rows[activeIndex];

  useEffect(() => { activeRow.current?.scrollIntoView?.({ block: "nearest" }); }, [active?.id]);
  // The list opens at the cursor: above it when there is room there, below it otherwise.
  useLayoutEffect(() => {
    const mark = caretMark.current, field = box.current;
    if (!open || !mark || !field) return setPlace(undefined);
    const top = mark.offsetTop - field.scrollTop, left = Math.max(8, Math.min(mark.offsetLeft - 6, field.clientWidth - 408));
    setPlace(top > 320 ? { inset: "auto", left, bottom: field.clientHeight - top + 4, width: 400 } : { inset: "auto", left, top: top + 24, width: 400 });
  }, [open, caret, value]);

  const syncCaret = (field: HTMLTextAreaElement) => {
    const next = field.selectionStart === field.selectionEnd ? field.selectionStart : null;
    if (next !== caret) { setIndex(0); setDismissed(false); setCaret(next); }
  };

  /** Put `words` in the place of the `$…` being typed, with a space after them, and the cursor after that. */
  function replaceToken(words: string) {
    const field = box.current;
    if (!field || !token) return;
    const suffix = value.slice(token.end), prefix = value.slice(0, token.start) + words;
    const next = prefix + (suffix || words.endsWith(" ") ? "" : " ") + suffix;
    const position = words.endsWith(" ") ? prefix.length : prefix.length + 1;
    flushSync(() => onChange(next));
    field.focus();
    field.setSelectionRange(position, position);
    setCaret(position);
  }
  const choose = (row: GraphicTemplateSummary) => replaceToken("$" + row.name);
  const make = () => { setIndex(0); setDismissed(true); replaceToken(MAKE_TEMPLATE); };

  // The text drawn under the field: the same words, with each keyword's fill, and a mark where the cursor is so the
  // list can open there.
  const marked: ReactNode[] = [];
  let at = 0;
  const cut = (to: number) => {
    if (open && caret !== null && caret >= at && caret <= to) {
      marked.push(value.slice(at, caret), <span key="caret" ref={caretMark} className="skill-instructions-caret" />);
      at = caret;
    }
    marked.push(value.slice(at, to));
    at = to;
  };
  for (const k of keywordSpans(value, templates, skills)) {
    cut(k.start);
    marked.push(<span key={k.start} className={`skill-keyword${hover?.name === k.name && hover.sign === k.sign ? " is-hover" : ""}`} data-keyword={k.sign + k.name}>{value.slice(k.start, k.end)}</span>);
    at = k.end;
  }
  cut(value.length);

  /** The keyword under the pointer, from the text drawn under the field. */
  function pointAt(x: number, y: number) {
    for (const el of backdrop.current?.querySelectorAll<HTMLElement>("[data-keyword]") ?? []) {
      for (const r of el.getClientRects()) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          const word = el.dataset.keyword!, outer = backdrop.current!.parentElement!.getBoundingClientRect();
          return { sign: word[0] as "$" | "/", name: word.slice(1), left: r.left - outer.left, top: r.top - outer.top };
        }
      }
    }
    return null;
  }

  return <div className="skill-instructions">
    <div ref={backdrop} className={`${className} skill-instructions-text`} aria-hidden="true">{marked}{"​"}</div>
    <textarea ref={box} className={`${className} skill-instructions-field`} value={value} readOnly={readOnly} placeholder={placeholder}
      aria-label="Skill markdown" aria-describedby={describedBy} spellCheck={false}
      aria-autocomplete="list" aria-haspopup="listbox" aria-controls={open ? listId : undefined}
      aria-activedescendant={open ? (index === "create" ? `${listId}-create-action` : active && `${listId}-template-${active.name}`) : undefined}
      onScroll={e => { if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop; setHover(null); }}
      onSelect={e => syncCaret(e.currentTarget)}
      onFocus={e => { syncCaret(e.currentTarget); setFocused(true); setDismissed(false); }}
      onBlur={() => setFocused(false)}
      onMouseMove={e => {
        const next = pointAt(e.clientX, e.clientY);
        if (next?.name !== hover?.name || next?.sign !== hover?.sign) setHover(next);
      }}
      onMouseLeave={() => setHover(null)}
      onChange={e => { syncCaret(e.currentTarget); setIndex(0); setDismissed(false); onChange(e.target.value); }}
      onKeyDown={e => {
        if (isComposing(e) || !open || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDismissed(true); return; }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const count = rows.length + 1, next = (activeIndex + (e.key === "ArrowDown" ? 1 : -1) + count) % count;
          setIndex(next === rows.length ? "create" : next);
          return;
        }
        if (e.key === "Enter" || (e.key === "Tab" && (active || index === "create"))) {
          if (index === "create") { e.preventDefault(); if (!e.repeat) make(); }
          else if (active) { e.preventDefault(); choose(active); }
        }
      }} />
    {open && <TemplateMenu listId={listId} rows={rows} active={active} makeActive={index === "create"} activeRow={activeRow} status={templateStatus} query={query}
      empty={!templates.length} style={place} onHover={row => setIndex(rows.indexOf(row))} onChoose={choose} onMake={make} onRetry={() => void loadTemplates()} />}
    {hover && !open && <div className="skill-keyword-note" role="tooltip" style={{ left: hover.left - 6, top: hover.top - 6 }}>
      <KeywordNote keyword={hover} templates={templates} skills={skills} />
    </div>}
  </div>;
}

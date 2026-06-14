import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";

// Editor-local renderer: a plain markdown-it instance for previewing blocks.
// Server-side rendering (halu: links, ref resolution, containers) stays the
// source of truth for saved articles; this only needs to look right while
// editing, so links render inert and raw HTML stays escaped.
const md = new MarkdownIt({ html: false, linkify: false });

/**
 * Split a markdown document into editable blocks on blank lines, keeping
 * fenced code blocks (which may contain blank lines) intact.
 */
export function splitMarkdownBlocks(value: string): string[] {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1];
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
    }
    if (fence === null && line.trim() === "") {
      if (current.length) {
        blocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

export function joinMarkdownBlocks(blocks: string[]): string {
  return blocks.filter((b) => b.trim() !== "").join("\n\n");
}

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Extra class on the outer box (so existing textarea styling hooks apply). */
  className?: string;
  /** Rows hint for the per-block textarea minimum height. */
  minRows?: number;
}

/**
 * Partial-WYSIWYG markdown editor. Blocks render as markdown; clicking a
 * block destructures it into its raw source in a textarea (spell-check on).
 * Blur re-renders the block. A footer toggle switches the whole document to
 * one plain textarea for bulk edits.
 */
export function MarkdownEditor({ value, onChange, disabled, placeholder, className, minRows = 2 }: MarkdownEditorProps) {
  const [blocks, setBlocks] = useState<string[]>(() => splitMarkdownBlocks(value));
  const [active, setActive] = useState<number | null>(null);
  const [rawMode, setRawMode] = useState(false);
  // Last value we emitted — distinguishes our own onChange round-trip from an
  // external reset (e.g. the parent loading different content).
  const lastEmitted = useRef(value);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      setBlocks(splitMarkdownBlocks(value));
      setActive(null);
    }
  }, [value]);

  const emit = useCallback((next: string[]) => {
    setBlocks(next);
    const joined = joinMarkdownBlocks(next);
    lastEmitted.current = joined;
    onChange(joined);
  }, [onChange]);

  const autoSize = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, []);

  // Focus + size the textarea when a block becomes active.
  useEffect(() => {
    if (active === null) return;
    const el = textareaRef.current;
    if (!el) return;
    autoSize(el);
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [active, autoSize]);

  const commitActive = useCallback(() => {
    if (active === null) return;
    // The edited source may now contain blank lines — re-split it into
    // multiple blocks; an emptied block disappears.
    const next = [...blocks];
    next.splice(active, 1, ...splitMarkdownBlocks(blocks[active] ?? ""));
    emit(next);
    setActive(null);
  }, [active, blocks, emit]);

  const updateActive = useCallback((text: string) => {
    if (active === null) return;
    const next = [...blocks];
    next[active] = text;
    emit(next);
  }, [active, blocks, emit]);

  const addBlock = useCallback(() => {
    if (disabled) return;
    setBlocks((prev) => [...prev, ""]);
    setActive(blocks.length);
  }, [disabled, blocks.length]);

  const renderedBlocks = useMemo(
    () => blocks.map((b, i) => (i === active ? "" : md.render(b))),
    [blocks, active],
  );

  if (rawMode) {
    return (
      <div className={`mdedit${className ? ` ${className}` : ""}`}>
        <textarea
          className="mdedit-raw-textarea"
          value={value}
          onChange={(e) => {
            const next = e.target.value;
            lastEmitted.current = next;
            setBlocks(splitMarkdownBlocks(next));
            onChange(next);
          }}
          spellCheck
          disabled={disabled}
          placeholder={placeholder}
          rows={Math.max(minRows, 8)}
        />
        <div className="mdedit-footer">
          <button
            type="button"
            className="mdedit-mode-btn"
            onClick={() => { setBlocks(splitMarkdownBlocks(value)); setRawMode(false); }}
          >
            Rendered blocks
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`mdedit${disabled ? " mdedit--disabled" : ""}${className ? ` ${className}` : ""}`}>
      <div className="mdedit-blocks">
        {blocks.map((block, i) =>
          i === active ? (
            <textarea
              key={i}
              ref={textareaRef}
              className="mdedit-textarea"
              value={block}
              spellCheck
              placeholder={placeholder}
              disabled={disabled}
              rows={Math.max(minRows, block.split("\n").length)}
              onChange={(e) => { updateActive(e.target.value); autoSize(e.target); }}
              onBlur={commitActive}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  commitActive();
                }
              }}
            />
          ) : (
            <div
              key={i}
              className="mdedit-block"
              title="Click to edit this block"
              onClick={(e) => {
                if (disabled) return;
                // Links inside rendered markdown activate the block, never navigate.
                e.preventDefault();
                commitActive();
                setActive(i);
              }}
              dangerouslySetInnerHTML={{ __html: renderedBlocks[i] }}
            />
          ),
        )}
        {!disabled && (
          <div className="mdedit-add" onClick={addBlock}>
            {blocks.length === 0 ? (placeholder ?? "Click to start writing…") : "+ add text"}
          </div>
        )}
      </div>
      <div className="mdedit-footer">
        <span className="mdedit-hint">Click a block to edit its markdown</span>
        <button type="button" className="mdedit-mode-btn" onClick={() => { commitActive(); setRawMode(true); }}>
          Raw text
        </button>
      </div>
    </div>
  );
}

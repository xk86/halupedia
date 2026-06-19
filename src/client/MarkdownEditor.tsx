import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "prosekit/basic/style.css";
import { defineBasicExtension } from "prosekit/basic";
import { createEditor, definePasteHandler } from "prosekit/core";
import { definePlaceholder } from "@prosekit/extensions/placeholder";
import { defineReadonly } from "@prosekit/extensions/readonly";
import { ProseKit, useDocChange, useExtension } from "prosekit/react";
import type { Editor } from "prosekit/core";
import { htmlToMarkdown, markdownToHtml } from "./markdown/mdBridge";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Extra class on the outer box (so existing textarea styling hooks apply). */
  className?: string;
  /** Rows hint for the raw-source textarea minimum height. */
  minRows?: number;
}

/**
 * WYSIWYG markdown editor built on ProseKit (ProseMirror). The document is
 * edited as rich text; markdown is the storage format, round-tripped through
 * HTML on load and change. Typing markdown syntax (e.g. `## `, `**bold**`)
 * converts inline via ProseKit's input rules, and pasting a block of markdown
 * is parsed into rich content. A footer toggle drops to a raw-markdown textarea
 * for bulk edits or syntax this editor can't model.
 */
export function MarkdownEditor(props: MarkdownEditorProps) {
  const { value } = props;
  // Created once; external value changes are applied via setContent in Inner.
  const editor = useMemo<Editor>(
    () =>
      createEditor({
        extension: defineBasicExtension(),
        defaultContent: value ? markdownToHtml(value) : undefined,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <ProseKit editor={editor}>
      <Inner editor={editor} {...props} />
    </ProseKit>
  );
}

function Inner({
  editor,
  value,
  onChange,
  disabled,
  placeholder,
  className,
  minRows = 2,
}: MarkdownEditorProps & { editor: Editor }) {
  const [rawMode, setRawMode] = useState(false);
  // Canonical markdown the editor currently holds — distinguishes our own
  // change round-trip from an external reset (parent loading new content).
  const lastMd = useRef(value);

  // Editor doc -> markdown. Conversion is async (remark/rehype), so we serialize
  // through a token to drop stale results when edits arrive faster than convert.
  const convertToken = useRef(0);
  const emit = useCallback(() => {
    const token = ++convertToken.current;
    const html = editor.getDocHTML();
    void htmlToMarkdown(html).then((next) => {
      if (token !== convertToken.current) return;
      if (next === lastMd.current) return;
      lastMd.current = next;
      onChange(next);
    });
  }, [editor, onChange]);

  useDocChange(emit, { editor });

  // External value -> editor doc. Only fires for genuine external resets, never
  // for our own emitted changes (which already match lastMd).
  useEffect(() => {
    if (value === lastMd.current) return;
    lastMd.current = value;
    editor.setContent(value ? markdownToHtml(value) : "<p></p>", "end");
  }, [editor, value]);

  // Disabled <-> readonly, applied reactively.
  useExtension(
    useMemo(() => (disabled ? defineReadonly() : null), [disabled]),
    { editor },
  );

  useExtension(
    useMemo(
      () => (placeholder ? definePlaceholder({ placeholder }) : null),
      [placeholder],
    ),
    { editor },
  );

  // Paste a block of raw markdown -> parse it into rich content. Only intercept
  // plain-text pastes that actually look like markdown; rich HTML and ordinary
  // prose fall through to ProseMirror's default handling.
  useExtension(
    useMemo(
      () =>
        definePasteHandler((view, event) => {
          const data = event.clipboardData;
          if (!data) return false;
          const html = data.getData("text/html");
          if (html) return false;
          const text = data.getData("text/plain");
          if (!text || !looksLikeMarkdown(text)) return false;
          return view.pasteHTML(markdownToHtml(text));
        }),
      [],
    ),
    { editor },
  );

  if (rawMode) {
    return (
      <div className={`mdedit${className ? ` ${className}` : ""}`}>
        <textarea
          className="mdedit-raw-textarea"
          value={value}
          onChange={(e) => {
            lastMd.current = e.target.value;
            onChange(e.target.value);
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
            onClick={() => setRawMode(false)}
          >
            Rich text
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`mdedit${disabled ? " mdedit--disabled" : ""}${className ? ` ${className}` : ""}`}
    >
      <div ref={editor.mount} className="mdedit-pm" />
      <div className="mdedit-footer">
        <span className="mdedit-hint">
          Type or paste markdown — it renders as you write
        </span>
        <button
          type="button"
          className="mdedit-mode-btn"
          onClick={() => setRawMode(true)}
        >
          Raw markdown
        </button>
      </div>
    </div>
  );
}

/** Conservative test: does this plain-text paste contain markdown syntax? */
function looksLikeMarkdown(text: string): boolean {
  return (
    /^#{1,6}\s/m.test(text) || // heading
    /\*\*[^*]+\*\*|__[^_]+__/.test(text) || // bold
    /(^|\s)[*_][^*_\s][^*_]*[*_](\s|$)/.test(text) || // emphasis
    /\[[^\]]+\]\([^)]+\)/.test(text) || // link
    /^\s*[-*+]\s/m.test(text) || // bullet list
    /^\s*\d+\.\s/m.test(text) || // ordered list
    /^>\s/m.test(text) || // blockquote
    /```|~~~/.test(text) || // fenced code
    /\n\s*\n/.test(text) // multiple paragraphs
  );
}

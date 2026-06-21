import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "prosekit/basic/style.css";
import { defineBasicExtension } from "prosekit/basic";
import { createEditor, definePasteHandler } from "prosekit/core";
import type { Editor } from "prosekit/core";
import { definePlaceholder } from "@prosekit/extensions/placeholder";
import { defineReadonly } from "@prosekit/extensions/readonly";
import {
  ProseKit,
  useDocChange,
  useEditorDerivedValue,
  useExtension,
} from "prosekit/react";
import {
  InlinePopoverPopup,
  InlinePopoverPositioner,
  InlinePopoverRoot,
} from "prosekit/react/inline-popover";
import {
  BoldIcon,
  CodeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  StrikethroughIcon,
  type LucideIcon,
} from "lucide-react";
import {
  ArticleSearchDropdown,
  SEARCH_INPUT,
  type Suggestion,
} from "./ArticleSearchDropdown";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
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
  /**
   * Cap the plain-text editor's auto-grow at this many rows; past it the
   * textarea scrolls instead of growing the page. Omit for unbounded growth.
   */
  maxRows?: number;
  /**
   * Edit the value as literal plain text instead of WYSIWYG markdown. Used for
   * prompts and other non-markdown text: the rich editor would round-trip the
   * content through markdown (escaping `_`, reflowing JSON/`{{vars}}`, forcing
   * block structure) and corrupt it. In this mode the value passes through
   * verbatim — what you type is exactly what's stored.
   */
  plainText?: boolean;
}

type LinkScheme = "ref" | "halu" | "url";
type HeadingLevel = 1 | 2 | 3;

const HEADING_LEVELS: readonly HeadingLevel[] = [1, 2, 3];
const HEADING_ICONS: Record<HeadingLevel, LucideIcon> = {
  1: Heading1Icon,
  2: Heading2Icon,
  3: Heading3Icon,
};

interface LinkDraft {
  scheme: LinkScheme;
  slug: string;
  /** Visible text to insert when there's no selection (e.g. a picked title). */
  text: string;
}

/**
 * WYSIWYG markdown editor built on ProseKit (ProseMirror). The document is
 * edited as rich text; markdown is the storage format, round-tripped through
 * HTML on load and change. A top toolbar reflects the active block/marks and
 * surfaces the active link's target or a heading's markdown; selecting text
 * raises an inline popover; the link tool searches existing articles. A footer
 * toggle drops to a raw markdown textarea for bulk edits.
 */
export function MarkdownEditor(props: MarkdownEditorProps) {
  if (props.plainText) return <PlainTextEditor {...props} />;
  return <RichMarkdownEditor {...props} />;
}

/**
 * Plain-text editor: an auto-growing textarea wearing the same `.mdedit` chrome
 * as the rich editor, so prompts edit inline with no toolbar, no block model,
 * and no markdown round-trip. The stored value is exactly the typed text.
 */
function PlainTextEditor({
  value,
  onChange,
  disabled,
  placeholder,
  className,
  minRows = 4,
  maxRows,
}: MarkdownEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const grow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    let target = el.scrollHeight;
    if (maxRows) {
      const cs = getComputedStyle(el);
      const line =
        parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20;
      const pad =
        parseFloat(cs.paddingTop || "0") + parseFloat(cs.paddingBottom || "0");
      const max = Math.round(line * maxRows + pad);
      if (target > max) target = max;
      el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
    }
    el.style.height = `${target}px`;
  }, [maxRows]);

  // Re-fit when the value changes externally (load, reset, revert).
  useEffect(grow, [grow, value]);

  return (
    <div
      className={`mdedit mdedit--plain${disabled ? " mdedit--disabled" : ""}${className ? ` ${className}` : ""}`}
    >
      <textarea
        ref={ref}
        className="mdedit-plain"
        value={value}
        spellCheck={false}
        disabled={disabled}
        placeholder={placeholder}
        rows={minRows}
        onChange={(e) => {
          onChange(e.target.value);
          grow();
        }}
      />
    </div>
  );
}

function RichMarkdownEditor(props: MarkdownEditorProps) {
  const { value } = props;
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
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const lastMd = useRef(value);
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

  // External value -> editor doc (only on genuine external resets).
  useEffect(() => {
    if (value === lastMd.current) return;
    lastMd.current = value;
    editor.setContent(value ? markdownToHtml(value) : "<p></p>", "end");
  }, [editor, value]);

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
  useExtension(
    useMemo(
      () =>
        definePasteHandler((view, event) => {
          const data = event.clipboardData;
          if (!data) return false;
          if (data.getData("text/html")) return false;
          const text = data.getData("text/plain");
          if (!text || !looksLikeMarkdown(text)) return false;
          return view.pasteHTML(markdownToHtml(text));
        }),
      [],
    ),
    { editor },
  );

  const openLinkEditor = useCallback(() => {
    setLinkDraft(linkDraftFromSelection(editor));
  }, [editor]);

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
      {!disabled && (
        <Toolbar
          editor={editor}
          linkDraft={linkDraft}
          onOpenLink={openLinkEditor}
          onCloseLink={() => setLinkDraft(null)}
        />
      )}
      <div ref={editor.mount} className="mdedit-pm" />
      {!disabled && (
        <SelectionPopover editor={editor} onEditLink={openLinkEditor} />
      )}
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

// ---------------------------------------------------------------------------
// Toolbar + active-state readout
// ---------------------------------------------------------------------------

interface ToolbarState {
  bold: { active: boolean; can: boolean };
  italic: { active: boolean; can: boolean };
  code: { active: boolean; can: boolean };
  strike: { active: boolean; can: boolean };
  bulletList: boolean;
  orderedList: boolean;
  blockquote: boolean;
  headings: Array<{ level: HeadingLevel; active: boolean }>;
  context: ContextInfo;
}

type ContextInfo =
  | { kind: "heading"; level: number; markdown: string }
  | { kind: "link"; href: string }
  | { kind: "code" }
  | null;

function getToolbarState(editor: Editor): ToolbarState {
  const m = editor.marks as Record<string, { isActive: (a?: any) => boolean }>;
  const n = editor.nodes as Record<string, { isActive: (a?: any) => boolean }>;
  const c = editor.commands as Record<
    string,
    { canExec: (...a: any) => boolean }
  >;
  const mark = (name: string, attrs?: any) => Boolean(m[name]?.isActive(attrs));
  const node = (name: string, attrs?: any) => Boolean(n[name]?.isActive(attrs));

  return {
    bold: { active: mark("bold"), can: Boolean(c.toggleBold?.canExec()) },
    italic: { active: mark("italic"), can: Boolean(c.toggleItalic?.canExec()) },
    code: { active: mark("code"), can: Boolean(c.toggleCode?.canExec()) },
    strike: { active: mark("strike"), can: Boolean(c.toggleStrike?.canExec()) },
    bulletList: node("list", { kind: "bullet" }),
    orderedList: node("list", { kind: "ordered" }),
    blockquote: node("blockquote"),
    headings: HEADING_LEVELS.map((level) => ({
      level,
      active: node("heading", { level }),
    })),
    context: activeContext(editor),
  };
}

function Toolbar({
  editor,
  linkDraft,
  onOpenLink,
  onCloseLink,
}: {
  editor: Editor;
  linkDraft: LinkDraft | null;
  onOpenLink: () => void;
  onCloseLink: () => void;
}) {
  const s = useEditorDerivedValue(getToolbarState, { editor });
  const cmd = editor.commands as Record<string, (...a: any) => void>;

  return (
    <div className="mdedit-toolbar">
      <div className="mdedit-tool-group">
        {s.headings.map(({ level, active }) => {
          const HeadingIcon = HEADING_ICONS[level];
          return (
            <button
              key={level}
              type="button"
              className={`mdedit-tool${active ? " mdedit-tool--active" : ""}`}
              aria-label={`Heading ${level}`}
              title={`Heading ${level}`}
              onClick={() => cmd.toggleHeading?.({ level })}
            >
              <HeadingIcon aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <span className="mdedit-tool-sep" />
      <div className="mdedit-tool-group">
        <ToolButton
          icon={BoldIcon}
          title="Bold"
          state={s.bold}
          onClick={() => cmd.toggleBold?.()}
        />
        <ToolButton
          icon={ItalicIcon}
          title="Italic"
          state={s.italic}
          onClick={() => cmd.toggleItalic?.()}
        />
        <ToolButton
          icon={StrikethroughIcon}
          title="Strikethrough"
          state={s.strike}
          onClick={() => cmd.toggleStrike?.()}
        />
        <ToolButton
          icon={CodeIcon}
          title="Inline code"
          state={s.code}
          onClick={() => cmd.toggleCode?.()}
        />
        <Popover
          open={linkDraft !== null}
          onOpenChange={(open) => (open ? onOpenLink() : onCloseLink())}
        >
          <PopoverTrigger
            type="button"
            className={`mdedit-tool${linkDraft || s.context?.kind === "link" ? " mdedit-tool--active" : ""}`}
            aria-label="Link to an article or URL"
            title="Link to an article or URL"
          >
            <LinkIcon aria-hidden="true" />
          </PopoverTrigger>
          {linkDraft && (
            <PopoverContent
              align="start"
              sideOffset={6}
              className="w-[22rem] max-w-[90vw] gap-2 p-2.5"
            >
              <LinkPopoverBody
                editor={editor}
                initial={linkDraft}
                onClose={onCloseLink}
              />
            </PopoverContent>
          )}
        </Popover>
      </div>
      <span className="mdedit-tool-sep" />
      <div className="mdedit-tool-group">
        <button
          type="button"
          className={`mdedit-tool${s.bulletList ? " mdedit-tool--active" : ""}`}
          aria-label="Bullet list"
          title="Bullet list"
          onClick={() => cmd.toggleList?.({ kind: "bullet" })}
        >
          <ListIcon aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`mdedit-tool${s.orderedList ? " mdedit-tool--active" : ""}`}
          aria-label="Numbered list"
          title="Numbered list"
          onClick={() => cmd.toggleList?.({ kind: "ordered" })}
        >
          <ListOrderedIcon aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`mdedit-tool${s.blockquote ? " mdedit-tool--active" : ""}`}
          aria-label="Quote"
          title="Quote"
          onClick={() => cmd.toggleBlockquote?.()}
        >
          <QuoteIcon aria-hidden="true" />
        </button>
      </div>
      <span className="mdedit-tool-spacer" />
      <ContextReadout context={s.context} />
    </div>
  );
}

function ToolButton({
  icon: Icon,
  title,
  state,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  state: { active: boolean; can: boolean };
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`mdedit-tool${state.active ? " mdedit-tool--active" : ""}`}
      aria-label={title}
      title={title}
      disabled={!state.can}
      onClick={onClick}
    >
      <Icon aria-hidden="true" />
    </button>
  );
}

function ContextReadout({ context }: { context: ContextInfo }) {
  if (!context) {
    return (
      <span className="mdedit-context mdedit-context--muted">Paragraph</span>
    );
  }
  if (context.kind === "heading") {
    return (
      <span className="mdedit-context" title={`Heading ${context.level}`}>
        <span className="mdedit-context-target">{context.markdown}</span>
      </span>
    );
  }
  if (context.kind === "link") {
    return (
      <span className="mdedit-context">
        Link
        <span className="mdedit-context-target">{context.href}</span>
      </span>
    );
  }
  return <span className="mdedit-context">Code</span>;
}

// ---------------------------------------------------------------------------
// Selection inline popover ("a little simple edit thing that shows what it is")
// ---------------------------------------------------------------------------

// ProseKit's <InlinePopoverPopup> does NOT forward `className` to its host
// element, so the toolbar surface is styled on an inner wrapper. Base UI / shadcn
// tokens only (dark popover surface = primary, so it reads over the parchment
// body); no bespoke CSS.
// No Preflight in this project, so a bare <button> keeps its UA chrome (grey
// fill, black border) — zero it explicitly with border-0 bg-transparent.
const BUBBLE_BTN =
  "inline-flex h-7 min-w-7 cursor-pointer items-center justify-center gap-1 rounded-md border-0 bg-transparent px-2 text-sm text-primary-foreground hover:bg-primary-foreground/15";

function SelectionPopover({
  editor,
  onEditLink,
}: {
  editor: Editor;
  onEditLink: () => void;
}) {
  const s = useEditorDerivedValue(getToolbarState, { editor });
  const cmd = editor.commands as Record<string, (...a: any) => void>;

  return (
    <InlinePopoverRoot>
      <InlinePopoverPositioner>
        <InlinePopoverPopup>
          <div className="flex items-center gap-0.5 rounded-md bg-primary p-1 text-primary-foreground shadow-md ring-1 ring-primary-foreground/15">
            <span className="max-w-[16rem] truncate px-1.5 font-mono text-[0.7rem] text-primary-foreground/70">
              {selectionLabel(s)}
            </span>
            <span className="mx-0.5 h-4 w-px bg-primary-foreground/25" />
            <button
              type="button"
              className={cn(BUBBLE_BTN, s.bold.active && "bg-accent")}
              style={{ fontWeight: 700 }}
              title="Bold"
              onClick={() => cmd.toggleBold?.()}
            >
              B
            </button>
            <button
              type="button"
              className={cn(BUBBLE_BTN, s.italic.active && "bg-accent")}
              style={{ fontStyle: "italic" }}
              title="Italic"
              onClick={() => cmd.toggleItalic?.()}
            >
              I
            </button>
            <button
              type="button"
              className={cn(BUBBLE_BTN, s.code.active && "bg-accent")}
              style={{ fontFamily: "var(--mono)" }}
              title="Inline code"
              onClick={() => cmd.toggleCode?.()}
            >
              {"<>"}
            </button>
            <button
              type="button"
              className={cn(
                BUBBLE_BTN,
                s.context?.kind === "link" && "bg-accent",
              )}
              title={s.context?.kind === "link" ? "Edit link" : "Add link"}
              onClick={onEditLink}
            >
              🔗 {s.context?.kind === "link" ? "Edit link" : "Link"}
            </button>
          </div>
        </InlinePopoverPopup>
      </InlinePopoverPositioner>
    </InlinePopoverRoot>
  );
}

function selectionLabel(s: ToolbarState): string {
  if (s.context?.kind === "link") return `Link → ${s.context.href}`;
  if (s.context?.kind === "heading") return s.context.markdown;
  const marks = [
    s.bold.active && "Bold",
    s.italic.active && "Italic",
    s.code.active && "Code",
    s.strike.active && "Strike",
  ].filter(Boolean);
  return marks.length ? marks.join(" + ") : "Text";
}

// ---------------------------------------------------------------------------
// Link editor — article search + scheme + slug
// ---------------------------------------------------------------------------

const SCHEMES: Array<{ id: LinkScheme; label: string }> = [
  { id: "ref", label: "ref:" },
  { id: "halu", label: "halu:" },
  { id: "url", label: "url" },
];

function LinkPopoverBody({
  editor,
  initial,
  onClose,
}: {
  editor: Editor;
  initial: LinkDraft;
  onClose: () => void;
}) {
  const [scheme, setScheme] = useState<LinkScheme>(initial.scheme);
  const [slug, setSlug] = useState(initial.slug);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  // Focus the active field without scrolling: a native autoFocus on a portaled
  // popup fires before it's positioned and yanks the page to the top.
  useEffect(() => {
    rootRef.current?.querySelector("input")?.focus({ preventScroll: true });
  }, [scheme]);

  const apply = useCallback(
    (over?: Partial<LinkDraft>) => {
      const sc = over?.scheme ?? scheme;
      const raw = (over?.slug ?? slug).trim();
      if (!raw) return;
      const href = sc === "url" ? raw : `${sc}:${slugify(raw)}`;
      applyLink(editor, href, over?.text ?? initial.text);
      onClose();
    },
    [editor, scheme, slug, initial.text, onClose],
  );

  const pick = useCallback(
    (s: Suggestion) =>
      apply({
        scheme: scheme === "url" ? "ref" : scheme,
        slug: s.slug,
        text: initial.text || s.title,
      }),
    [apply, scheme, initial.text],
  );

  return (
    <div ref={rootRef} className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <div className="mdedit-tool-group">
          {SCHEMES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`mdedit-tool${scheme === s.id ? " mdedit-tool--active" : ""}`}
              onClick={() => setScheme(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        {scheme === "url" ? (
          <input
            className={SEARCH_INPUT}
            value={slug}
            placeholder="https://…"
            onChange={(e) => setSlug(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") apply();
              if (e.key === "Escape") onClose();
            }}
          />
        ) : (
          <ArticleSearchDropdown
            query={query}
            onQueryChange={setQuery}
            onPick={pick}
            placeholder="Search an article to link…"
            wrapClassName="flex-1"
          />
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="min-w-[3rem] font-mono text-[0.78rem] text-accent">
          {scheme === "url" ? "target" : `${scheme}:`}
        </span>
        <input
          className={SEARCH_INPUT}
          value={slug}
          placeholder={scheme === "url" ? "https://…" : "slug"}
          onChange={(e) => setSlug(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply();
            if (e.key === "Escape") onClose();
          }}
        />
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <button type="button" className="mdedit-mode-btn" onClick={() => apply()}>
          Apply
        </button>
        <button
          type="button"
          className="mdedit-mode-btn"
          onClick={() => {
            (editor.commands as Record<string, () => void>).removeLink?.();
            onClose();
          }}
        >
          Remove
        </button>
        <button type="button" className="mdedit-mode-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProseMirror state helpers
// ---------------------------------------------------------------------------

function activeContext(editor: Editor): ContextInfo {
  const href = activeLinkHref(editor);
  if (href) return { kind: "link", href };
  const heading = activeHeading(editor);
  if (heading) return { kind: "heading", ...heading };
  const marks = editor.marks as Record<string, { isActive: () => boolean }>;
  if (marks.code?.isActive()) return { kind: "code" };
  return null;
}

function activeLinkHref(editor: Editor): string | null {
  const { state } = editor;
  const linkType = state.schema.marks.link;
  if (!linkType) return null;
  const { selection } = state;
  if (selection.empty) {
    const $pos = selection.$from;
    const marks = state.storedMarks ?? $pos.marks();
    const stored = marks.find((mk) => mk.type === linkType);
    if (stored) return String(stored.attrs.href ?? "");
    const around = ($pos.nodeBefore ?? $pos.nodeAfter)?.marks.find(
      (mk) => mk.type === linkType,
    );
    return around ? String(around.attrs.href ?? "") : null;
  }
  let href: string | null = null;
  state.doc.nodesBetween(selection.from, selection.to, (node) => {
    const mk = node.marks.find((x) => x.type === linkType);
    if (mk) href = String(mk.attrs.href ?? "");
  });
  return href;
}

function activeHeading(
  editor: Editor,
): { level: number; markdown: string } | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "heading") {
      const level = Number(node.attrs.level ?? 1);
      return { level, markdown: `${"#".repeat(level)} ${node.textContent}` };
    }
  }
  return null;
}

function selectedText(editor: Editor): string {
  const { state } = editor;
  const { from, to, empty } = state.selection;
  return empty ? "" : state.doc.textBetween(from, to, " ");
}

function linkDraftFromSelection(editor: Editor): LinkDraft {
  const text = selectedText(editor);
  const href = activeLinkHref(editor);
  if (href) return { ...parseHref(href), text };
  return { scheme: "ref", slug: "", text };
}

function parseHref(href: string): { scheme: LinkScheme; slug: string } {
  if (href.startsWith("ref:")) return { scheme: "ref", slug: href.slice(4) };
  if (href.startsWith("halu:")) {
    // halu links may carry a `halu:slug hint` suffix — keep just the slug.
    return { scheme: "halu", slug: href.slice(5).split(/["' ]/)[0] };
  }
  return { scheme: "url", slug: href };
}

/** Apply a link: re-mark an existing link, wrap a selection, or insert text. */
function applyLink(editor: Editor, href: string, text: string): void {
  const view = editor.view;
  const state = view.state;
  const linkType = state.schema.marks.link;
  const cmd = editor.commands as Record<
    string,
    ((a?: any) => void) & { canExec?: (a?: any) => boolean }
  >;

  if (!state.selection.empty) {
    cmd.addLink?.({ href });
  } else if (cmd.expandLink?.canExec?.()) {
    // Caret inside an existing link — select the whole link, then re-mark.
    cmd.expandLink();
    cmd.addLink?.({ href });
  } else if (text && linkType) {
    const from = state.selection.from;
    const tr = state.tr.insertText(text, from);
    tr.addMark(from, from + text.length, linkType.create({ href }));
    view.dispatch(tr);
  }
  view.focus();
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/** Conservative test: does this plain-text paste contain markdown syntax? */
//TODO Find some way to do this without uh....... doing whatever the fuck this is bc what is this? lol. like use a library, even if it's simple.
function looksLikeMarkdown(text: string): boolean {
  return (
    /^#{1,6}\s/m.test(text) ||
    /\*\*[^*]+\*\*|__[^_]+__/.test(text) ||
    /(^|\s)[*_][^*_\s][^*_]*[*_](\s|$)/.test(text) ||
    /\[[^\]]+\]\([^)]+\)/.test(text) ||
    /^\s*[-*+]\s/m.test(text) ||
    /^\s*\d+\.\s/m.test(text) ||
    /^>\s/m.test(text) ||
    /```|~~~/.test(text) ||
    /\n\s*\n/.test(text)
  );
}

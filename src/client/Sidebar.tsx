import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { InfoboxData, HeadlineMedia } from "@/types";

// Compact field styling for the dense sidebar infobox editor — shrinks the
// shadcn Input/Textarea defaults (height, padding, font) to sidebar scale.
const EDIT_LABEL =
  "mt-[0.4rem] mb-[0.15rem] block text-[0.72rem] font-semibold uppercase tracking-[0.04em] text-ink-fade";
const EDIT_FIELD =
  "h-auto max-h-32 min-h-[1.6rem] rounded-[3px] px-[0.4rem] py-[0.3rem] text-[0.72rem] shadow-none";
const ROW_FIELD =
  "h-auto max-h-28 min-h-[1.5rem] min-w-0 rounded-[2px] px-[0.3rem] py-[0.2rem] text-[0.72rem] shadow-none";
// Small square delete (×) button used per section/row.
const DEL_BTN = "size-5 shrink-0 p-0 text-[0.75rem] hover:text-danger";

// The sticky right-rail shell. Desktop: spans both content rows in column 2 and
// pins to the viewport bottom. Mobile (<=680px): collapses into the single
// column above the article. Shared by every sidebar render branch.
const SIDEBAR =
  "sticky bottom-4 col-[2] row-[1/span_2] flex flex-col gap-[1.4rem] self-start font-serif text-ink max-[680px]:static max-[680px]:col-[1] max-[680px]:row-[1] max-[680px]:max-w-[50dvw] max-[680px]:justify-self-center max-[680px]:border-t max-[680px]:border-rule";

interface SidebarRevision {
  id: number;
  articleSlug: string;
  infoboxJson: string;
  caption: string;
  operation: string;
  changedAt: number;
}

interface SidebarProps {
  articleSlug: string | null;
  articleTitle: string;
  infobox: InfoboxData | null;
  headlineMedia: HeadlineMedia | null;
  /** Render the top-10 most-referenced articles list (homepage). */
  showTopArticles?: boolean;
  onNavigate: (slug: string) => void;
  onNavigateToMedia: (imageSlug: string) => void;
  onArticleUpdate?: (articleSlug: string) => void;
}

interface TopArticle {
  slug: string;
  title: string;
  inboundCount: number;
}

/** Top-10 most-referenced articles — shown in the side pane on the homepage. */
function TopArticlesPanel({
  onNavigate,
}: {
  onNavigate: (slug: string) => void;
}) {
  const [topArticles, setTopArticles] = useState<TopArticle[]>([]);

  useEffect(() => {
    fetch("/api/top-articles?limit=10")
      .then((r) => r.json())
      .then((d) =>
        setTopArticles((d as { articles: TopArticle[] }).articles ?? []),
      )
      .catch(() => {});
  }, []);

  if (topArticles.length === 0) return null;
  return (
    <section className="w-full border border-panel-border bg-panel-surface p-[0.85rem]">
      <h2 className="m-0 mb-3 font-mono text-base tracking-[0.08em] text-ink-soft uppercase">
        Top articles
      </h2>
      <ol className="m-0 flex w-full list-none flex-col gap-[0.15rem] p-0">
        {topArticles.map((a, i) => (
          <li
            key={a.slug}
            className="flex w-full items-baseline gap-2 py-[0.12rem] text-[0.9rem] [border-bottom:1px_solid_var(--rule)] last:border-b-0"
          >
            <span className="w-min min-w-[0.5rem] shrink-0 text-right font-mono text-[0.72rem] text-ink-fade">
              {i + 1}
            </span>
            <a
              className="w-1/2 flex-1 [overflow-wrap:break-word]"
              href={`/wiki/${a.title.replace(/\s+/g, "_")}`}
              onClick={(e) => {
                e.preventDefault();
                onNavigate(a.title);
              }}
            >
              {a.title}
            </a>
            <span className="shrink-0 font-mono text-[0.72rem] text-ink-fade">
              {a.inboundCount} {a.inboundCount === 1 ? "ref" : "refs"}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

type EditTab = "edit" | "ai" | "history";

interface DraftRow {
  label: string;
  value: string;
}
interface DraftGroup {
  label: string;
  rows: DraftRow[];
}
interface DraftState {
  title: string;
  subtitle: string;
  caption: string;
  groups: DraftGroup[];
}

function newGroup(): DraftGroup {
  return { label: "", rows: [{ label: "", value: "" }] };
}

function MarkdownField({
  value,
  onChange,
  disabled,
  placeholder,
  className = ROW_FIELD,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Textarea
      className={className}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      spellCheck={false}
      rows={1}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function InfoboxStructuredEditor({
  articleSlug,
  onSaved,
  onCancel,
}: {
  articleSlug: string;
  onSaved: (infobox: InfoboxData, caption: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/article/${encodeURIComponent(articleSlug)}/infobox`)
      .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then((data: { infobox: InfoboxData | null; caption: string }) => {
        const raw = data.infobox;
        setDraft({
          title: raw?.title ?? "",
          subtitle: raw?.subtitle ?? "",
          caption: data.caption,
          groups: raw?.groups.length
            ? raw.groups.map((g) => ({
                label: g.label,
                rows: g.rows.map((r) => ({ label: r.label, value: r.value })),
              }))
            : [newGroup()],
        });
        setLoading(false);
      })
      .catch(() => {
        setError("Failed to load infobox data");
        setLoading(false);
      });
  }, [articleSlug]);

  const upd = useCallback((fn: (d: DraftState) => DraftState) => {
    setDraft((d) => (d ? fn(d) : d));
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.title.trim()) {
      setError("Title is required");
      return;
    }
    const infobox: InfoboxData = {
      title: draft.title.trim(),
      subtitle: draft.subtitle.trim() || undefined,
      groups: draft.groups
        .map((g) => ({
          label: g.label.trim(),
          rows: g.rows.filter((r) => r.label.trim() || r.value.trim()),
        }))
        .filter((g) => g.rows.length > 0),
    };
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/article/${encodeURIComponent(articleSlug)}/infobox`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ infobox, caption: draft.caption }),
        },
      );
      const payload = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(payload?.error ?? `HTTP ${res.status}`);
      // Use server-returned pre-rendered values so the sidebar doesn't flash raw markdown.
      onSaved(payload.infobox ?? infobox, payload.caption ?? draft.caption);
    } catch (e: any) {
      setError(e.message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  }, [draft, articleSlug, onSaved]);

  if (loading)
    return <p className="my-2 text-[0.8rem] text-ink-fade">Loading…</p>;
  if (!draft) return null;

  return (
    <div className="text-[0.8rem]">
      <label className={EDIT_LABEL}>Title</label>
      <Input
        className={EDIT_FIELD}
        value={draft.title}
        disabled={busy}
        onChange={(e) => upd((d) => ({ ...d, title: e.target.value }))}
        placeholder="Display title…"
      />

      <label className={EDIT_LABEL}>Subtitle (optional · markdown)</label>
      <MarkdownField
        value={draft.subtitle}
        disabled={busy}
        placeholder="e.g. Chemical compound, 1923–1991…"
        className={EDIT_FIELD}
        onChange={(v) => upd((d) => ({ ...d, subtitle: v }))}
      />

      <label className={EDIT_LABEL}>Image caption (markdown)</label>
      <MarkdownField
        value={draft.caption}
        disabled={busy}
        placeholder="Caption for headline image…"
        className={EDIT_FIELD}
        onChange={(v) => upd((d) => ({ ...d, caption: v }))}
      />

      {draft.groups.map((group, gi) => (
        <div key={gi} className="mt-2 border-t border-rule pt-[0.35rem]">
          <div className="mb-[0.25rem] flex items-center gap-[0.2rem]">
            <Input
              className={cn(ROW_FIELD, "flex-1 font-semibold")}
              value={group.label}
              disabled={busy}
              placeholder="Section heading (optional)…"
              onChange={(e) =>
                upd((d) => {
                  const groups = d.groups.map((g, i) =>
                    i !== gi ? g : { ...g, label: e.target.value },
                  );
                  return { ...d, groups };
                })
              }
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className={DEL_BTN}
              disabled={busy}
              title="Delete section"
              onClick={() =>
                upd((d) => ({
                  ...d,
                  groups: d.groups.filter((_, i) => i !== gi),
                }))
              }
            >
              ×
            </Button>
          </div>

          {group.rows.map((row, ri) => (
            <div
              key={ri}
              className="mb-[0.2rem] grid grid-cols-[2fr_3fr_auto] items-start gap-[0.2rem]"
            >
              <Input
                className={ROW_FIELD}
                value={row.label}
                disabled={busy}
                placeholder="Field…"
                onChange={(e) =>
                  upd((d) => {
                    const groups = d.groups.map((g, i) =>
                      i !== gi
                        ? g
                        : {
                            ...g,
                            rows: g.rows.map((r, j) =>
                              j !== ri ? r : { ...r, label: e.target.value },
                            ),
                          },
                    );
                    return { ...d, groups };
                  })
                }
              />
              <MarkdownField
                value={row.value}
                disabled={busy}
                placeholder="Value (markdown ok)…"
                onChange={(v) =>
                  upd((d) => {
                    const groups = d.groups.map((g, i) =>
                      i !== gi
                        ? g
                        : {
                            ...g,
                            rows: g.rows.map((r, j) =>
                              j !== ri ? r : { ...r, value: v },
                            ),
                          },
                    );
                    return { ...d, groups };
                  })
                }
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className={DEL_BTN}
                disabled={busy}
                title="Delete row"
                onClick={() =>
                  upd((d) => {
                    const groups = d.groups.map((g, i) =>
                      i !== gi
                        ? g
                        : {
                            ...g,
                            rows: g.rows.filter((_, j) => j !== ri),
                          },
                    );
                    return { ...d, groups };
                  })
                }
              >
                ×
              </Button>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-[0.15rem] h-auto w-full border-dashed px-[0.4rem] py-[0.1rem] text-[0.68rem] font-normal"
            disabled={busy}
            onClick={() =>
              upd((d) => {
                const groups = d.groups.map((g, i) =>
                  i !== gi
                    ? g
                    : {
                        ...g,
                        rows: [...g.rows, { label: "", value: "" }],
                      },
                );
                return { ...d, groups };
              })
            }
          >
            + row
          </Button>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2 h-auto w-full border-dashed px-[0.5rem] py-[0.25rem] text-[0.72rem] font-normal"
        disabled={busy}
        onClick={() =>
          upd((d) => ({ ...d, groups: [...d.groups, newGroup()] }))
        }
      >
        + Add section
      </Button>

      {error && (
        <p className="my-[0.25rem] text-[0.75rem] text-danger">{error}</p>
      )}
      <div className="mt-2 flex gap-[0.4rem]">
        <Button
          type="button"
          size="sm"
          className="h-auto flex-1 py-[0.3rem] text-[0.75rem]"
          onClick={save}
          disabled={busy || !draft}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-auto flex-1 py-[0.3rem] text-[0.75rem]"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function InfoboxAiEditor({
  articleSlug,
  onSaved,
  onCancel,
}: {
  articleSlug: string;
  onSaved: (infobox: InfoboxData, caption: string) => void;
  onCancel: () => void;
}) {
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const regenerate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/article/${encodeURIComponent(articleSlug)}/infobox/regenerate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            instructions: instructions.trim() || undefined,
          }),
        },
      );
      const payload = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(payload?.error ?? `HTTP ${res.status}`);
      onSaved(payload.infobox, payload.caption ?? "");
    } catch (e: any) {
      setError(e.message ?? "Regeneration failed");
    } finally {
      setBusy(false);
    }
  }, [articleSlug, instructions, onSaved]);

  return (
    <div className="text-[0.8rem]">
      <label className={EDIT_LABEL}>Instructions (optional)</label>
      <Textarea
        className={cn(EDIT_FIELD, "max-h-none resize-y")}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        disabled={busy}
        rows={4}
        placeholder="e.g. Focus on the political background, include founding year…"
      />
      {error && (
        <p className="my-[0.25rem] text-[0.75rem] text-danger">{error}</p>
      )}
      <div className="mt-2 flex gap-[0.4rem]">
        <Button
          type="button"
          size="sm"
          className="h-auto flex-1 py-[0.3rem] text-[0.75rem]"
          onClick={regenerate}
          disabled={busy}
        >
          {busy ? "Generating…" : "Regenerate"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-auto flex-1 py-[0.3rem] text-[0.75rem]"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function InfoboxHistory({
  articleSlug,
  onRestored,
  onCancel,
}: {
  articleSlug: string;
  onRestored: (infobox: InfoboxData | null, caption: string) => void;
  onCancel: () => void;
}) {
  const [revisions, setRevisions] = useState<SidebarRevision[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/article/${encodeURIComponent(articleSlug)}/infobox/history`)
      .then((r) => r.json())
      .then((data: { revisions: SidebarRevision[] }) =>
        setRevisions(data.revisions),
      )
      .catch(() => setRevisions([]));
  }, [articleSlug]);

  const restore = useCallback(
    async (revisionId: number) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/article/${encodeURIComponent(articleSlug)}/infobox/restore`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ revisionId }),
          },
        );
        const payload = (await res.json().catch(() => ({}))) as any;
        if (!res.ok) throw new Error(payload?.error ?? `HTTP ${res.status}`);
        onRestored(payload.infobox, payload.caption ?? "");
      } catch (e: any) {
        setError(e.message ?? "Restore failed");
      } finally {
        setBusy(false);
      }
    },
    [articleSlug, onRestored],
  );

  if (!revisions)
    return <p className="my-2 text-[0.8rem] text-ink-fade">Loading…</p>;

  return (
    <div className="text-[0.8rem]">
      {error && (
        <p className="my-[0.25rem] text-[0.75rem] text-danger">{error}</p>
      )}
      {revisions.length === 0 ? (
        <p className="my-2 text-[0.8rem] text-ink-fade">
          No revision history yet.
        </p>
      ) : (
        <ul className="m-0 max-h-[180px] list-none overflow-y-auto p-0">
          {revisions.map((rev) => (
            <li
              key={rev.id}
              className="flex items-center gap-[0.4rem] border-b border-rule py-[0.25rem] text-[0.75rem]"
            >
              <span className="min-w-16 text-[0.65rem] font-semibold tracking-[0.04em] text-ink-fade uppercase">
                {rev.operation}
              </span>
              <span className="flex-1 text-ink-fade">
                {new Date(rev.changedAt).toLocaleString()}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-auto px-[0.4rem] py-[0.1rem] text-[0.7rem] font-normal text-accent"
                onClick={() => void restore(rev.id)}
                disabled={busy}
              >
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex gap-[0.4rem]">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-auto flex-1 py-[0.3rem] text-[0.75rem]"
          onClick={onCancel}
          disabled={busy}
        >
          Close
        </Button>
      </div>
    </div>
  );
}

const GENERATING_LABELS: Record<string, string> = {
  "llm.generate_see_also": "Suggesting related articles…",
  "llm.regenerate_summary": "Writing summary…",
  "llm.generate_infobox": "Building infobox…",
  "llm.generate_sidebar_caption": "Writing caption…",
};

// "Generating…" status label (with leading pulse dot) + its streamed partial.
const GENERATING_LABEL =
  "flex items-center gap-[0.4rem] text-[0.78rem] text-ink-fade italic";
const GENERATING_PARTIAL =
  "mt-[0.3rem] text-[0.78rem] text-ink-soft leading-[1.4] italic opacity-80";

export function Sidebar({
  articleSlug,
  infobox: infoboxProp,
  headlineMedia: headlineMediaProp,
  showTopArticles,
  onNavigate,
  onNavigateToMedia,
  onArticleUpdate,
}: SidebarProps) {
  // Live sidecar state — starts from props, updated by the /live stream.
  const [infobox, setInfobox] = useState<InfoboxData | null>(infoboxProp);
  const [headlineMedia, setHeadlineMedia] = useState<HeadlineMedia | null>(
    headlineMediaProp,
  );
  const [generatingNode, setGeneratingNode] = useState<string | null>(null);
  const [generatingPartial, setGeneratingPartial] = useState<string | null>(
    null,
  );
  const [editOpen, setEditOpen] = useState(false);
  const [editTab, setEditTab] = useState<EditTab>("edit");
  const liveRef = useRef<AbortController | null>(null);

  // Sync prop changes (navigation) into local state; close edit panel on navigation.
  useEffect(() => {
    setInfobox(infoboxProp);
    setEditOpen(false);
    setGeneratingNode(null);
    setGeneratingPartial(null);
  }, [infoboxProp]);
  useEffect(() => {
    setHeadlineMedia(headlineMediaProp);
  }, [headlineMediaProp]);

  // Subscribe to live sidecar updates for this article.
  useEffect(() => {
    if (!articleSlug) return;
    liveRef.current?.abort();
    const ac = new AbortController();
    liveRef.current = ac;

    (async () => {
      try {
        const res = await fetch(
          `/api/article/${encodeURIComponent(articleSlug)}/live`,
          {
            signal: ac.signal,
          },
        );
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done || ac.signal.aborted) break;
          buf += dec.decode(value, { stream: true });
          let nl = buf.indexOf("\n");
          while (nl >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            nl = buf.indexOf("\n");
            if (!line) continue;
            try {
              const event = JSON.parse(line) as
                | { type: "ready" }
                | { type: "infobox"; infobox: InfoboxData }
                | { type: "caption"; caption: string; mediaId: string }
                | { type: "article" }
                | { type: "generating"; node: string; partial?: string };
              if (event.type === "infobox") {
                setInfobox(event.infobox);
                setGeneratingNode(null);
                setGeneratingPartial(null);
              } else if (event.type === "caption") {
                setHeadlineMedia((prev) =>
                  prev && prev.mediaId === event.mediaId
                    ? { ...prev, caption: event.caption }
                    : prev,
                );
              } else if (event.type === "article" && articleSlug) {
                setGeneratingNode(null);
                setGeneratingPartial(null);
                onArticleUpdate?.(articleSlug);
              } else if (event.type === "generating") {
                setGeneratingNode(event.node);
                setGeneratingPartial(event.partial ?? null);
              }
            } catch {}
          }
        }
      } catch (e: any) {
        if (e?.name === "AbortError") return;
      }
    })();

    return () => {
      ac.abort();
    };
  }, [articleSlug]);

  // All hooks must come before any conditional early return (Rules of Hooks).
  const handleEditSaved = useCallback(
    (newInfobox: InfoboxData, newCaption: string) => {
      setInfobox(newInfobox);
      setHeadlineMedia((prev) =>
        prev && newCaption !== prev.caption
          ? { ...prev, caption: newCaption }
          : prev,
      );
      setEditOpen(false);
    },
    [],
  );

  const handleAiSaved = useCallback(
    (newInfobox: InfoboxData, newCaption: string) => {
      setInfobox(newInfobox);
      if (newCaption)
        setHeadlineMedia((prev) =>
          prev && newCaption !== prev.caption
            ? { ...prev, caption: newCaption }
            : prev,
        );
      setEditOpen(false);
    },
    [],
  );

  const handleRestored = useCallback(
    (newInfobox: InfoboxData | null, newCaption: string) => {
      if (newInfobox) setInfobox(newInfobox);
      if (newCaption)
        setHeadlineMedia((prev) =>
          prev ? { ...prev, caption: newCaption } : prev,
        );
      setEditOpen(false);
    },
    [],
  );

  const handleInternalLink = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const a = (e.target as HTMLElement).closest("a");
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("/wiki/")) {
        e.preventDefault();
        const seg = href.slice("/wiki/".length);
        onNavigate(decodeURIComponent(seg));
      }
    },
    [onNavigate],
  );

  const [mobileCollapsed, setMobileCollapsed] = useState(false);

  const hasContent = Boolean(articleSlug) && Boolean(infobox || headlineMedia);
  if (!hasContent) {
    if (showTopArticles) {
      return (
        <aside className={SIDEBAR} aria-label="Context">
          <TopArticlesPanel onNavigate={onNavigate} />
        </aside>
      );
    }
    if (!generatingNode)
      return <aside className={SIDEBAR} aria-label="Context" />;
    return (
      <aside className={SIDEBAR} aria-label="Context">
        <div className="px-[0.5rem] py-[0.6rem] [border-top:1px_solid_var(--rule-soft)]">
          <span className={GENERATING_LABEL}>
            <span className="inline-block size-[6px] animate-[sidebar-pulse_1.2s_ease-in-out_infinite] rounded-full bg-accent" />
            {GENERATING_LABELS[generatingNode] ?? "Generating…"}
          </span>
          {generatingPartial && (
            <p className={GENERATING_PARTIAL}>{generatingPartial}</p>
          )}
        </div>
      </aside>
    );
  }

  const title = infobox?.title ?? "";
  const subtitle = infobox?.subtitle ?? "";
  const groups = infobox?.groups ?? [];
  const caption = headlineMedia?.caption ?? "";

  return (
    <aside
      className={SIDEBAR}
      aria-label="Article info"
      onClick={handleInternalLink}
    >
      <button
        type="button"
        className="hidden w-full max-w-[67dvw] items-center justify-between border-0 border-b border-rule-soft bg-transparent px-[0.1rem] py-[0.65rem] text-left font-serif text-[0.9rem] font-semibold [overflow-wrap:break-word] [word-break:break-all] text-ink hover:text-accent max-[680px]:flex"
        onClick={(e) => {
          e.stopPropagation();
          setMobileCollapsed((v) => !v);
        }}
        aria-expanded={!mobileCollapsed}
      >
        <span>{title || "Article info"}</span>
        <span className="ml-2 shrink-0 text-[0.75rem] text-ink-fade">
          {mobileCollapsed ? "▸" : "▾"}
        </span>
      </button>
      <div className="infobox group/sb" data-collapsed={mobileCollapsed}>
        <div className="flex items-start justify-between gap-[0.25rem] bg-accent-wash-strong [border-bottom:1px_solid_var(--panel-border)]">
          {title && (
            <div
              className="infobox-title"
              dangerouslySetInnerHTML={{ __html: title }}
            />
          )}
          {articleSlug && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="mt-[0.1rem] size-6 shrink-0 bg-parchment p-0 text-[0.75rem] opacity-60 hover:opacity-100"
              title="Edit sidebar"
              onClick={(e) => {
                e.stopPropagation();
                setEditOpen((v) => !v);
                setEditTab("edit");
              }}
              aria-label="Edit sidebar"
            >
              ✏
            </Button>
          )}
        </div>
        {subtitle && (
          <div
            className="infobox-subtitle max-[680px]:group-data-[collapsed=true]/sb:hidden"
            dangerouslySetInnerHTML={{ __html: subtitle }}
          />
        )}

        {editOpen && articleSlug && (
          <div
            className="my-2 border-t border-rule pt-2 max-[680px]:group-data-[collapsed=true]/sb:hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <Tabs
              value={editTab}
              onValueChange={(v) => setEditTab(v as EditTab)}
            >
              <TabsList className="w-full">
                <TabsTrigger value="edit">Edit</TabsTrigger>
                <TabsTrigger value="ai">AI</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
              </TabsList>

              <TabsContent value="edit">
                <InfoboxStructuredEditor
                  articleSlug={articleSlug}
                  onSaved={handleEditSaved}
                  onCancel={() => setEditOpen(false)}
                />
              </TabsContent>
              <TabsContent value="ai">
                <InfoboxAiEditor
                  articleSlug={articleSlug}
                  onSaved={handleAiSaved}
                  onCancel={() => setEditOpen(false)}
                />
              </TabsContent>
              <TabsContent value="history">
                <InfoboxHistory
                  articleSlug={articleSlug}
                  onRestored={handleRestored}
                  onCancel={() => setEditOpen(false)}
                />
              </TabsContent>
            </Tabs>
          </div>
        )}

        {headlineMedia && (
          <>
            <a
              href={`/media/${encodeURIComponent(headlineMedia.mediaId)}`}
              className="infobox-image-link max-[680px]:group-data-[collapsed=true]/sb:hidden"
              onClick={(e) => {
                e.preventDefault();
                onNavigateToMedia(headlineMedia.mediaId);
              }}
            >
              <img
                src={`/api/media/${encodeURIComponent(headlineMedia.mediaId)}`}
                alt={caption || headlineMedia.mediaId}
                className="infobox-image"
              />
            </a>
            {caption && (
              <p
                className="infobox-caption max-[680px]:group-data-[collapsed=true]/sb:hidden"
                dangerouslySetInnerHTML={{ __html: caption }}
              />
            )}
          </>
        )}

        {groups.length > 0 && (
          <table className="infobox-table max-[680px]:group-data-[collapsed=true]/sb:hidden">
            {groups.map((group, gi) => (
              <tbody key={gi}>
                {group.label && (
                  <tr>
                    <th
                      className="infobox-group-header"
                      colSpan={2}
                      dangerouslySetInnerHTML={{ __html: group.label }}
                    />
                  </tr>
                )}
                {group.rows.map((row, ri) => (
                  <tr key={ri}>
                    <th
                      className="infobox-label"
                      dangerouslySetInnerHTML={{ __html: row.label }}
                    />
                    <td
                      className="infobox-value"
                      dangerouslySetInnerHTML={{ __html: row.value }}
                    />
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        )}
        {generatingNode && (
          <div className="px-[0.5rem] py-[0.4rem] [border-top:1px_solid_var(--rule-soft)]">
            <span className={GENERATING_LABEL}>
              <span className="inline-block size-[6px] animate-[sidebar-pulse_1.2s_ease-in-out_infinite] rounded-full bg-accent" />
              {GENERATING_LABELS[generatingNode] ?? "Updating…"}
            </span>
            {generatingPartial &&
              generatingNode === "llm.regenerate_summary" && (
                <p className={GENERATING_PARTIAL}>{generatingPartial}</p>
              )}
          </div>
        )}
      </div>
    </aside>
  );
}

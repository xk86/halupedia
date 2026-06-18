// ============================================================================
// DEAD CODE — DO NOT TOUCH (as of 2026-06-18)
// ----------------------------------------------------------------------------
// The comments feature is currently disabled: nothing imports or renders this
// component, and there is no live comments section in the app. It is left in
// place in case the feature is revived, but it is intentionally EXCLUDED from
// the ongoing Tailwind/shadcn migration. Do not spend effort migrating its
// styles or components until the feature is wired back in.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";

// Bare text-button used for "reply"/"expand"/"load more"; size is composed per
// use (the action links are 0.72rem, the load-more buttons 0.85rem).
const LINK_BTN =
  "cursor-pointer border-none bg-transparent p-0 font-mono uppercase tracking-[0.1em] text-ink-fade hover:text-accent";
// Comment thread <ol>: reset list chrome; the first item drops its top rule.
const LIST =
  "m-0 list-none p-0 [&>li:first-child]:border-t-0 [&>li:first-child]:pt-0";
// Load-more / expand button row.
const LOADMORE =
  "mt-[1.25rem] mb-[0.5rem] flex justify-center pt-[1rem] [border-top:1px_dotted_var(--rule)]";

/* -------------------------------------------------------------------------- */
/*  Types — kept in sync with src/worker/comments.ts                           */
/* -------------------------------------------------------------------------- */

export interface CommentUser {
  id: string;
  name: string;
  username: string;
}

export interface Comment {
  id: string;
  parent_id: string | null;
  user: CommentUser;
  body: string;
  created_at: number;
  score: number;
  voted: boolean;
  children: Comment[];
}

interface ThreadResponse {
  slug: string;
  total: number;
  roots_total: number;
  offset: number;
  limit: number;
  has_more: boolean;
  comments: Comment[];
  user: CommentUser | null;
}

const PAGE_SIZE = 50;

/** When a thread has more than this many root comments, the list is
 *  truncated to a preview on first render with an "Expand" button. This is
 *  purely client-side: the comments are already in `comments` state, we
 *  just don't render past `INITIAL_VISIBLE_ROOTS` until the reader asks.
 *  The expanded flag resets on full page reload (which is the intended UX
 *  — long threads should feel concise by default each visit). */
const INITIAL_VISIBLE_ROOTS = 5;

/* -------------------------------------------------------------------------- */
/*  Time formatting (HN-ish)                                                   */
/* -------------------------------------------------------------------------- */

function formatAge(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s} second${s === 1 ? "" : "s"} ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const y = Math.floor(d / 365);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}

/* -------------------------------------------------------------------------- */
/*  Tree mutation helpers (immutable)                                          */
/* -------------------------------------------------------------------------- */

function mapTree(
  list: Comment[],
  fn: (c: Comment) => Comment | null,
): Comment[] {
  const out: Comment[] = [];
  for (const c of list) {
    const mapped = fn(c);
    if (!mapped) continue;
    out.push({ ...mapped, children: mapTree(mapped.children, fn) });
  }
  return out;
}

/** Recursively walk a tree, insert `child` under `parentId` if found, and
 *  re-sort the children of that parent according to the active sort mode. */
function insertAndSort(
  node: Comment,
  parentId: string,
  child: Comment,
  sort: SortMode,
): Comment {
  if (node.id === parentId) {
    return { ...node, children: sortChildren([child, ...node.children], sort) };
  }
  return {
    ...node,
    children: node.children.map((c) => insertAndSort(c, parentId, child, sort)),
  };
}

type SortMode = "recommended" | "top" | "newest";

const SORT_LABELS: Record<SortMode, string> = {
  recommended: "Recommended",
  top: "Top",
  newest: "Newest",
};

/** Local re-sort for replies (children) — must match the server's logic in
 *  src/worker/comments.ts so a freshly-posted reply slots in correctly. */
function sortChildren(list: Comment[], sort: SortMode): Comment[] {
  const now = Date.now();
  const cmp = (a: Comment, b: Comment) => {
    if (sort === "newest") return b.created_at - a.created_at;
    if (sort === "top") return b.score - a.score || b.created_at - a.created_at;
    // recommended — must match src/worker/comments.ts compareDTO
    const ha =
      Math.sqrt(a.score) / Math.pow((now - a.created_at) / 3600000 + 2, 0.8);
    const hb =
      Math.sqrt(b.score) / Math.pow((now - b.created_at) / 3600000 + 2, 0.8);
    return hb - ha || b.created_at - a.created_at;
  };
  return [...list]
    .sort(cmp)
    .map((c) => ({ ...c, children: sortChildren(c.children, sort) }));
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                  */
/* -------------------------------------------------------------------------- */

interface Props {
  slug: string;
}

export function Comments({ slug }: Props) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [user, setUser] = useState<CommentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [serverTotal, setServerTotal] = useState(0);
  const [rootsTotal, setRootsTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [sort, setSort] = useState<SortMode>("recommended");
  // Client-side preview-vs-full toggle for long threads. Resets to false on
  // slug/sort change (see effect below) and on full page reload (state is
  // not persisted anywhere).
  const [expanded, setExpanded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /* ----- Fetch on slug or sort change ----- */
  useEffect(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    setComments([]);
    setReplyTo(null);
    setReplyDraft("");
    setCollapsed(new Set());
    setServerTotal(0);
    setRootsTotal(0);
    setHasMore(false);
    setExpanded(false);

    (async () => {
      try {
        const res = await fetch(
          `/api/comments/${encodeURIComponent(slug)}?offset=0&limit=${PAGE_SIZE}&sort=${sort}`,
          { signal: ctrl.signal, credentials: "same-origin" },
        );
        if (!res.ok) {
          const j: any = await res.json().catch(() => ({}));
          throw new Error(j?.error || `error ${res.status}`);
        }
        const data: ThreadResponse = await res.json();
        if (ctrl.signal.aborted) return;
        setComments(data.comments);
        setUser(data.user);
        setServerTotal(data.total);
        setRootsTotal(data.roots_total);
        setHasMore(data.has_more);
        setLoading(false);
      } catch (e: any) {
        if (ctrl.signal.aborted || e?.name === "AbortError") return;
        setError(e?.message || "failed to load comments");
        setLoading(false);
      }
    })();

    return () => ctrl.abort();
  }, [slug, sort]);

  /* ----- Load next page of root comments ----- */
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/comments/${encodeURIComponent(slug)}?offset=${comments.length}&limit=${PAGE_SIZE}&sort=${sort}`,
        { credentials: "same-origin" },
      );
      if (!res.ok) {
        const j: any = await res.json().catch(() => ({}));
        throw new Error(j?.error || `error ${res.status}`);
      }
      const data: ThreadResponse = await res.json();
      setComments((cur) => [...cur, ...data.comments]);
      setServerTotal(data.total);
      setRootsTotal(data.roots_total);
      setHasMore(data.has_more);
    } catch (e: any) {
      setError(e?.message || "failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }, [comments.length, hasMore, loadingMore, slug, sort]);

  /* ----- Submit a new top-level comment ----- */
  const submitTopLevel = useCallback(async () => {
    const body = draft.trim();
    if (!body || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/comments/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const j: any = await res.json().catch(() => ({}));
        throw new Error(j?.error || `error ${res.status}`);
      }
      const j: { comment: Comment; user: CommentUser } = await res.json();
      setUser(j.user);
      // Always prepend so the user sees their fresh post regardless of sort
      // mode. The server’s ranking will catch up on the next refresh.
      setComments((cur) => [j.comment, ...cur]);
      setServerTotal((n) => n + 1);
      setRootsTotal((n) => n + 1);
      setDraft("");
    } catch (e: any) {
      setError(e?.message || "failed to post");
    } finally {
      setSubmitting(false);
    }
  }, [draft, slug, submitting]);

  /* ----- Submit a reply ----- */
  const submitReply = useCallback(
    async (parentId: string) => {
      const body = replyDraft.trim();
      if (!body || submitting) return;
      setSubmitting(true);
      try {
        const res = await fetch(`/api/comments/${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ body, parent_id: parentId }),
        });
        if (!res.ok) {
          const j: any = await res.json().catch(() => ({}));
          throw new Error(j?.error || `error ${res.status}`);
        }
        const j: { comment: Comment; user: CommentUser } = await res.json();
        setUser(j.user);
        // Insert the reply in-place; re-sort only the affected subtree.
        setComments((cur) =>
          cur.map((root) => insertAndSort(root, parentId, j.comment, sort)),
        );
        setServerTotal((n) => n + 1);
        setReplyTo(null);
        setReplyDraft("");
      } catch (e: any) {
        setError(e?.message || "failed to post");
      } finally {
        setSubmitting(false);
      }
    },
    [replyDraft, slug, sort, submitting],
  );

  /* ----- Toggle vote ----- */
  const toggleVote = useCallback(async (id: string) => {
    // Optimistic update.
    setComments((cur) =>
      mapTree(cur, (c) => {
        if (c.id !== id) return c;
        const voted = !c.voted;
        return { ...c, voted, score: c.score + (voted ? 1 : -1) };
      }),
    );
    try {
      const res = await fetch(`/api/comments/${encodeURIComponent(id)}/vote`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`vote failed`);
      const j: { voted: boolean; score: number; user: CommentUser } =
        await res.json();
      setUser(j.user);
      setComments((cur) =>
        mapTree(cur, (c) =>
          c.id === id ? { ...c, voted: j.voted, score: j.score } : c,
        ),
      );
    } catch {
      // Roll back on failure.
      setComments((cur) =>
        mapTree(cur, (c) => {
          if (c.id !== id) return c;
          const voted = !c.voted;
          return { ...c, voted, score: c.score + (voted ? 1 : -1) };
        }),
      );
    }
  }, []);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <section
      className="mt-[3.5rem] pt-[1.5rem] [border-top:2px_solid_var(--rule)]"
      aria-label="Reader speculations"
    >
      <header className="mb-[1rem] flex flex-wrap items-baseline justify-between gap-x-[1rem] gap-y-[0.5rem]">
        <h2 className="m-0 font-serif text-[1.4rem] font-medium text-ink-soft">
          Reader speculations
        </h2>
        <span className="font-mono text-[0.78rem] tracking-[0.1em] text-ink-fade uppercase">
          {loading
            ? "—"
            : `${serverTotal} entr${serverTotal === 1 ? "y" : "ies"}`}
        </span>
        <div
          className="ml-auto inline-flex gap-[0.25rem] font-mono text-[0.75rem]"
          role="tablist"
          aria-label="Sort comments"
        >
          {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
            <button
              key={mode}
              role="tab"
              aria-selected={sort === mode}
              className={clsx(
                "rounded-[2px] bg-transparent px-[0.55rem] py-[0.15rem] font-[inherit] text-[length:inherit] tracking-[0.05em] uppercase [border:1px_solid_transparent] [transition:color_.15s,border-color_.15s,background_.15s]",
                sort === mode
                  ? "cursor-default [border-color:var(--ink-soft)] text-ink"
                  : "cursor-pointer text-ink-fade hover:[border-color:var(--rule)] hover:text-ink",
              )}
              onClick={() => setSort(mode)}
              disabled={loading || sort === mode}
            >
              {SORT_LABELS[mode]}
            </button>
          ))}
        </div>
      </header>

      {/* Identity strip — only shown after a user has been minted. */}
      {user && (
        <div className="mb-[0.8rem] flex flex-wrap items-baseline gap-[0.6rem] bg-blockquote-bg px-[0.8rem] py-[0.55rem] text-[0.92rem] [border-left:3px_solid_var(--accent)]">
          <span className="font-mono text-[0.72rem] tracking-[0.1em] text-ink-fade uppercase">
            Posting as
          </span>
          <span className="text-ink italic">{user.name}</span>
          <span className="font-mono text-[0.82rem] text-ink-fade">
            @{user.username}
          </span>
        </div>
      )}
      {!user && !loading && (
        <p className="m-0 mb-[0.8rem] font-mono text-[0.76rem] text-ink-fade">
          You have no name yet. One will be assigned to you on first comment;
          you cannot choose it.
        </p>
      )}

      {/* Top-level composer */}
      <CommentComposer
        value={draft}
        onChange={setDraft}
        onSubmit={submitTopLevel}
        submitting={submitting}
        placeholder="Add to the record. Speculation encouraged; citations optional."
        submitLabel="Submit entry"
      />

      {error && (
        <div className="mb-[1rem] bg-accent-wash px-[0.8rem] py-[0.6rem] font-mono text-[0.85rem] text-accent [border:1px_solid_var(--accent)]">
          {error}
        </div>
      )}

      {loading ? (
        <p className="my-[1rem] font-mono text-[0.85rem] text-ink-fade">
          Consulting the marginalia…
        </p>
      ) : comments.length === 0 ? (
        <p className="my-[1rem] font-mono text-[0.85rem] text-ink-fade">
          No reader has yet commented on this entry.
        </p>
      ) : (
        <>
          {(() => {
            const truncated =
              !expanded && comments.length > INITIAL_VISIBLE_ROOTS;
            const visible = truncated
              ? comments.slice(0, INITIAL_VISIBLE_ROOTS)
              : comments;
            const hiddenCount = comments.length - visible.length;
            return (
              <>
                <ol className={LIST}>
                  {visible.map((c) => (
                    <CommentNode
                      key={c.id}
                      comment={c}
                      depth={0}
                      replyTo={replyTo}
                      setReplyTo={setReplyTo}
                      replyDraft={replyDraft}
                      setReplyDraft={setReplyDraft}
                      submitReply={submitReply}
                      submitting={submitting}
                      toggleVote={toggleVote}
                      collapsed={collapsed}
                      toggleCollapse={toggleCollapse}
                    />
                  ))}
                </ol>
                {truncated && (
                  <div className={LOADMORE}>
                    <button
                      className={`${LINK_BTN} text-[0.85rem]`}
                      onClick={() => setExpanded(true)}
                    >
                      Expand ({hiddenCount} more
                      {hasMore ? " loaded" : ""})
                    </button>
                  </div>
                )}
              </>
            );
          })()}
          {hasMore &&
            (!expanded ? comments.length <= INITIAL_VISIBLE_ROOTS : true) && (
              <div className={LOADMORE}>
                <button
                  className={`${LINK_BTN} text-[0.85rem]`}
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore
                    ? "Fetching more marginalia…"
                    : `Load more (${rootsTotal - comments.length} remaining)`}
                </button>
              </div>
            )}
        </>
      )}
    </section>
  );
}

function countTotal(list: Comment[]): number {
  let n = 0;
  for (const c of list) n += 1 + countTotal(c.children);
  return n;
}

/* -------------------------------------------------------------------------- */
/*  Comment node                                                               */
/* -------------------------------------------------------------------------- */

interface NodeProps {
  comment: Comment;
  depth: number;
  replyTo: string | null;
  setReplyTo: (id: string | null) => void;
  replyDraft: string;
  setReplyDraft: (s: string) => void;
  submitReply: (parentId: string) => void;
  submitting: boolean;
  toggleVote: (id: string) => void;
  collapsed: Set<string>;
  toggleCollapse: (id: string) => void;
}

function CommentNode({
  comment,
  depth,
  replyTo,
  setReplyTo,
  replyDraft,
  setReplyDraft,
  submitReply,
  submitting,
  toggleVote,
  collapsed,
  toggleCollapse,
}: NodeProps) {
  const isCollapsed = collapsed.has(comment.id);
  const childCount = countTotal(comment.children);

  return (
    <li
      className="mt-0 mb-[0.9rem] pt-[0.55rem] [border-top:1px_dotted_var(--rule-soft)] max-[600px]:ml-0!"
      style={{ marginLeft: Math.min(depth, 8) * 14 }}
    >
      <div className="flex items-start gap-[0.55rem]">
        <button
          className={clsx(
            "shrink-0 cursor-pointer border-none bg-transparent px-[0.25rem] py-[0.1rem] leading-none [transition:color_120ms_ease,transform_120ms_ease] hover:[transform:translateY(-1px)] hover:text-accent",
            comment.voted ? "text-accent" : "text-ink-fade",
          )}
          onClick={() => toggleVote(comment.id)}
          aria-label={comment.voted ? "Remove upvote" : "Upvote"}
          aria-pressed={comment.voted}
          title={comment.voted ? "Retract upvote" : "Upvote"}
        >
          <span className="inline-block text-[0.95rem]" aria-hidden>
            ▲
          </span>
        </button>

        <div className="min-w-0 flex-1">
          <header className="mb-[0.25rem] flex flex-wrap items-baseline gap-[0.35rem] font-mono text-[0.74rem] text-ink-fade">
            <button
              className="cursor-pointer border-none bg-transparent px-[0.15rem] py-0 font-mono text-[0.74rem] text-ink-fade hover:text-accent"
              onClick={() => toggleCollapse(comment.id)}
              aria-expanded={!isCollapsed}
              title={isCollapsed ? "Expand" : "Collapse"}
            >
              [{isCollapsed ? "+" : "–"}]
            </button>
            <span
              className="font-serif text-[0.95rem] text-ink-soft italic"
              title={comment.user.name}
            >
              {comment.user.name}
            </span>
            <span className="text-ink-fade">@{comment.user.username}</span>
            <span className="opacity-50">·</span>
            <span className="tracking-[0.04em]">
              {comment.score} point{comment.score === 1 ? "" : "s"}
            </span>
            <span className="opacity-50">·</span>
            <span>{formatAge(comment.created_at)}</span>
            {isCollapsed && childCount > 0 && (
              <>
                <span className="opacity-50">·</span>
                <span className="italic">({childCount} hidden)</span>
              </>
            )}
          </header>

          {!isCollapsed && (
            <>
              <div className="text-[0.98rem] leading-[1.55] text-ink [&_p]:mx-0 [&_p]:mt-0 [&_p]:mb-[0.55rem] [&_p]:text-left [&_p]:[hyphens:none] [&_p:last-child]:mb-0">
                {renderBody(comment.body)}
              </div>
              <footer className="mt-[0.3rem] flex gap-[0.8rem]">
                <button
                  className={`${LINK_BTN} text-[0.72rem]`}
                  onClick={() =>
                    setReplyTo(replyTo === comment.id ? null : comment.id)
                  }
                >
                  {replyTo === comment.id ? "cancel" : "reply"}
                </button>
              </footer>

              {replyTo === comment.id && (
                <CommentComposer
                  value={replyDraft}
                  onChange={setReplyDraft}
                  onSubmit={() => submitReply(comment.id)}
                  submitting={submitting}
                  placeholder="A measured rejoinder…"
                  submitLabel="Submit reply"
                  compact
                />
              )}

              {comment.children.length > 0 && (
                <ol
                  className={clsx(
                    LIST,
                    "mt-[0.6rem] max-[600px]:pl-[0.6rem] max-[600px]:[border-left:1px_dotted_var(--rule)]",
                  )}
                >
                  {comment.children.map((child) => (
                    <CommentNode
                      key={child.id}
                      comment={child}
                      depth={depth + 1}
                      replyTo={replyTo}
                      setReplyTo={setReplyTo}
                      replyDraft={replyDraft}
                      setReplyDraft={setReplyDraft}
                      submitReply={submitReply}
                      submitting={submitting}
                      toggleVote={toggleVote}
                      collapsed={collapsed}
                      toggleCollapse={toggleCollapse}
                    />
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  );
}

/** Plain-text body renderer that preserves paragraphs and line breaks. */
function renderBody(body: string) {
  const paragraphs = body.split(/\n{2,}/);
  return paragraphs.map((p, i) => (
    <p key={i}>
      {p.split("\n").map((line, j, arr) => (
        <span key={j}>
          {line}
          {j < arr.length - 1 && <br />}
        </span>
      ))}
    </p>
  ));
}

/* -------------------------------------------------------------------------- */
/*  Composer                                                                   */
/* -------------------------------------------------------------------------- */

interface ComposerProps {
  value: string;
  onChange: (s: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  placeholder: string;
  submitLabel: string;
  compact?: boolean;
}

function CommentComposer({
  value,
  onChange,
  onSubmit,
  submitting,
  placeholder,
  submitLabel,
  compact,
}: ComposerProps) {
  const remaining = 2000 - value.length;
  return (
    <div
      className={clsx(
        "mx-0",
        compact ? "mt-[0.6rem] mb-[0.6rem]" : "mt-[0.5rem] mb-[1.5rem]",
      )}
    >
      <textarea
        className="min-h-[4.5rem] w-full resize-y rounded-[2px] bg-control-surface-soft px-[0.8rem] py-[0.65rem] font-serif text-[1rem] leading-[1.5] text-ink [border:1px_solid_var(--rule)] focus:[border-color:var(--accent)] focus:bg-input-surface-strong focus:outline-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={compact ? 3 : 4}
        maxLength={2000}
        disabled={submitting}
      />
      <div className="mt-[0.45rem] flex items-center justify-between gap-[0.75rem]">
        <span
          className={clsx(
            "font-mono text-[0.72rem] tracking-[0.04em]",
            remaining < 0 ? "text-accent" : "text-ink-fade",
          )}
          aria-live="polite"
        >
          {remaining} chars left
        </span>
        <button
          className="cursor-pointer rounded-[1px] bg-ink px-[0.95rem] py-[0.45rem] font-mono text-[0.78rem] tracking-[0.1em] text-parchment uppercase [border:1px_solid_var(--ink)] [transition:background_120ms_ease,color_120ms_ease] hover:not-disabled:[border-color:var(--accent)] hover:not-disabled:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
          onClick={onSubmit}
          disabled={submitting || value.trim().length === 0}
        >
          {submitting ? "Filing…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

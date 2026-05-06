import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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
  comments: Comment[];
  user: CommentUser | null;
}

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
  fn: (c: Comment) => Comment | null
): Comment[] {
  const out: Comment[] = [];
  for (const c of list) {
    const mapped = fn(c);
    if (!mapped) continue;
    out.push({ ...mapped, children: mapTree(mapped.children, fn) });
  }
  return out;
}

function insertChild(
  list: Comment[],
  parentId: string,
  child: Comment
): Comment[] {
  return list.map((c) => {
    if (c.id === parentId) {
      return { ...c, children: [child, ...c.children] };
    }
    return { ...c, children: insertChild(c.children, parentId, child) };
  });
}

function sortTree(list: Comment[]): Comment[] {
  const sorted = [...list].sort(
    (a, b) => b.score - a.score || a.created_at - b.created_at
  );
  return sorted.map((c) => ({ ...c, children: sortTree(c.children) }));
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
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  /* ----- Fetch on slug change ----- */
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

    (async () => {
      try {
        const res = await fetch(
          `/api/comments/${encodeURIComponent(slug)}`,
          { signal: ctrl.signal, credentials: "same-origin" }
        );
        if (!res.ok) {
          const j: any = await res.json().catch(() => ({}));
          throw new Error(j?.error || `error ${res.status}`);
        }
        const data: ThreadResponse = await res.json();
        if (ctrl.signal.aborted) return;
        setComments(data.comments);
        setUser(data.user);
        setLoading(false);
      } catch (e: any) {
        if (ctrl.signal.aborted || e?.name === "AbortError") return;
        setError(e?.message || "failed to load comments");
        setLoading(false);
      }
    })();

    return () => ctrl.abort();
  }, [slug]);

  const total = useMemo(() => countTotal(comments), [comments]);

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
      setComments((cur) => sortTree([j.comment, ...cur]));
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
        setComments((cur) => sortTree(insertChild(cur, parentId, j.comment)));
        setReplyTo(null);
        setReplyDraft("");
      } catch (e: any) {
        setError(e?.message || "failed to post");
      } finally {
        setSubmitting(false);
      }
    },
    [replyDraft, slug, submitting]
  );

  /* ----- Toggle vote ----- */
  const toggleVote = useCallback(async (id: string) => {
    // Optimistic update.
    setComments((cur) =>
      mapTree(cur, (c) => {
        if (c.id !== id) return c;
        const voted = !c.voted;
        return { ...c, voted, score: c.score + (voted ? 1 : -1) };
      })
    );
    try {
      const res = await fetch(
        `/api/comments/${encodeURIComponent(id)}/vote`,
        {
          method: "POST",
          credentials: "same-origin",
        }
      );
      if (!res.ok) throw new Error(`vote failed`);
      const j: { voted: boolean; score: number; user: CommentUser } =
        await res.json();
      setUser(j.user);
      setComments((cur) =>
        mapTree(cur, (c) =>
          c.id === id ? { ...c, voted: j.voted, score: j.score } : c
        )
      );
    } catch {
      // Roll back on failure.
      setComments((cur) =>
        mapTree(cur, (c) => {
          if (c.id !== id) return c;
          const voted = !c.voted;
          return { ...c, voted, score: c.score + (voted ? 1 : -1) };
        })
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
    <section className="comments" aria-label="Reader speculations">
      <header className="comments-header">
        <h2>Reader speculations</h2>
        <span className="comments-count">
          {loading ? "—" : `${total} entr${total === 1 ? "y" : "ies"}`}
        </span>
      </header>

      {/* Identity strip — only shown after a user has been minted. */}
      {user && (
        <div className="comments-identity">
          <span className="comments-identity-label">Posting as</span>
          <span className="comments-identity-name">{user.name}</span>
          <span className="comments-identity-handle">@{user.username}</span>
        </div>
      )}
      {!user && !loading && (
        <p className="comments-identity-hint">
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

      {error && <div className="comments-error">{error}</div>}

      {loading ? (
        <p className="comments-status">Consulting the marginalia…</p>
      ) : comments.length === 0 ? (
        <p className="comments-empty">
          No reader has yet commented on this entry.
        </p>
      ) : (
        <ol className="comments-list">
          {comments.map((c) => (
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
    <li className="comment" style={{ marginLeft: Math.min(depth, 8) * 14 }}>
      <div className="comment-row">
        <button
          className={`vote ${comment.voted ? "voted" : ""}`}
          onClick={() => toggleVote(comment.id)}
          aria-label={comment.voted ? "Remove upvote" : "Upvote"}
          aria-pressed={comment.voted}
          title={comment.voted ? "Retract upvote" : "Upvote"}
        >
          <span className="vote-arrow" aria-hidden>▲</span>
        </button>

        <div className="comment-body">
          <header className="comment-meta">
            <button
              className="comment-collapse"
              onClick={() => toggleCollapse(comment.id)}
              aria-expanded={!isCollapsed}
              title={isCollapsed ? "Expand" : "Collapse"}
            >
              [{isCollapsed ? "+" : "–"}]
            </button>
            <span className="comment-author" title={comment.user.name}>
              {comment.user.name}
            </span>
            <span className="comment-handle">@{comment.user.username}</span>
            <span className="sep">·</span>
            <span className="comment-score">
              {comment.score} point{comment.score === 1 ? "" : "s"}
            </span>
            <span className="sep">·</span>
            <span className="comment-age">{formatAge(comment.created_at)}</span>
            {isCollapsed && childCount > 0 && (
              <>
                <span className="sep">·</span>
                <span className="comment-collapsed-count">
                  ({childCount} hidden)
                </span>
              </>
            )}
          </header>

          {!isCollapsed && (
            <>
              <div className="comment-text">{renderBody(comment.body)}</div>
              <footer className="comment-actions">
                <button
                  className="comment-link"
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
                <ol className="comments-list nested">
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
    <div className={`comment-composer ${compact ? "compact" : ""}`}>
      <textarea
        className="comment-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={compact ? 3 : 4}
        maxLength={2000}
        disabled={submitting}
      />
      <div className="comment-composer-row">
        <span
          className={`comment-counter ${remaining < 0 ? "over" : ""}`}
          aria-live="polite"
        >
          {remaining} chars left
        </span>
        <button
          className="comment-submit"
          onClick={onSubmit}
          disabled={submitting || value.trim().length === 0}
        >
          {submitting ? "Filing…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

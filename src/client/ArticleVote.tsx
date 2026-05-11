/**
 * ArticleVote — small toolbar rendered just above the article body.
 *
 * Mirrors the comment-vote flow exactly: optimistic toggle, server returns
 * authoritative {voted, score}, rollback on failure. Identity is created
 * lazily on first vote (the server's ensureUser handles that).
 *
 * Hidden on:
 *   - non-article views (App passes a null slug)
 *   - the homepage ("halupedia")
 *   - while the article is still streaming (avoid a button-without-content)
 */

import { useEffect, useRef, useState } from "react";

interface Props {
  /** The current article slug, or null on /search and /all-entries. */
  slug: string | null;
  /** Called whenever the score changes successfully so the parent can
   *  refresh the "Top Folios" sidebar panel. */
  onVoted?: () => void;
}

interface MetaResponse {
  slug: string;
  score: number;
  voted: boolean;
}

interface VoteResponse {
  voted: boolean;
  score: number;
  user: { id: string; name: string; username: string };
}

const HOMEPAGE_SLUG = "halupedia";

export function ArticleVote({ slug, onVoted }: Props) {
  const [score, setScore] = useState<number | null>(null);
  const [voted, setVoted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guard against a stale fetch updating state for a slug the user has
  // already navigated away from.
  const reqIdRef = useRef(0);

  const isVotable = slug !== null && slug !== HOMEPAGE_SLUG;

  /* ----- Load the vote state on every slug change ----- */
  useEffect(() => {
    if (!isVotable || !slug) {
      setScore(null);
      setVoted(false);
      return;
    }
    const myReq = ++reqIdRef.current;
    setError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/articles/${encodeURIComponent(slug)}/meta`,
          { credentials: "same-origin" }
        );
        if (!res.ok) throw new Error(`error ${res.status}`);
        const j: MetaResponse = await res.json();
        if (reqIdRef.current !== myReq) return;
        setScore(j.score);
        setVoted(j.voted);
      } catch {
        // Soft-fail: render the button as score=0, voted=false so the user
        // can still upvote. The first POST will create the row anyway.
        if (reqIdRef.current !== myReq) return;
        setScore(0);
        setVoted(false);
      }
    })();
  }, [slug, isVotable]);

  if (!isVotable || !slug || score === null) return null;

  const onClick = async () => {
    if (pending) return;

    // Optimistic update.
    const nextVoted = !voted;
    const nextScore = Math.max(0, score + (nextVoted ? 1 : -1));
    setVoted(nextVoted);
    setScore(nextScore);
    setPending(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/articles/${encodeURIComponent(slug)}/vote`,
        { method: "POST", credentials: "same-origin" }
      );
      if (!res.ok) {
        const j: any = await res.json().catch(() => ({}));
        throw new Error(j?.error || `error ${res.status}`);
      }
      const j: VoteResponse = await res.json();
      setVoted(j.voted);
      setScore(j.score);
      onVoted?.();
    } catch (e: any) {
      // Roll back.
      setVoted(voted);
      setScore(score);
      setError(e?.message || "vote failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="article-vote" aria-label="Folio rating">
      <button
        type="button"
        className={`article-vote-btn${voted ? " voted" : ""}`}
        onClick={onClick}
        disabled={pending}
        aria-pressed={voted}
        title={
          voted ? "Retract endorsement" : "Endorse this folio"
        }
      >
        <span className="article-vote-arrow" aria-hidden>
          ▲
        </span>
        <span className="article-vote-count">{score}</span>
      </button>
      <span className="article-vote-label">
        {voted ? "Endorsed" : "Endorse"}
      </span>
      {error && (
        <span className="article-vote-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

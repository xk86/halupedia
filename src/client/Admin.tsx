/**
 * Admin panel — single-page React surface for the privileged operator.
 *
 * Auth model:
 *   - Operator accounts live in the D1 `admins` table (manually seeded).
 *     The username + SHA-512(password) row gates access — see
 *     src/worker/admin.ts for the verifier and the per-IP login throttle.
 *   - We POST credentials base64-encoded as HTTP Basic to /api/admin/check.
 *     A 200 response means the password is good; we stash the encoded
 *     header in sessionStorage so we can resend it on subsequent admin
 *     calls (without keeping the plaintext password around). sessionStorage
 *     (not localStorage) so closing the tab logs out.
 *   - Every admin API call carries `Authorization: Basic …`. A 401 anywhere
 *     drops us back to the login screen.
 *
 * The only privileged action wired up today is `ban`, which calls
 * /api/admin/ban. That endpoint comprehensively nukes a slug from
 * everywhere it could be lingering (KV, articles, article_votes,
 * article_moderation, comments, votes, the __total counter, AND the
 * live Presence DO's "Currently Being Consulted" list). See
 * src/worker/admin.ts for the breakdown.
 */

import { useCallback, useEffect, useState } from "react";

const AUTH_STORAGE_KEY = "halupedia_admin_auth";

function loadStoredAuth(): string | null {
  try {
    return window.sessionStorage.getItem(AUTH_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeAuth(header: string | null): void {
  try {
    if (header == null) {
      window.sessionStorage.removeItem(AUTH_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(AUTH_STORAGE_KEY, header);
    }
  } catch {
    /* private mode / quota — auth survives only in-memory for this session */
  }
}

/** Helper: every admin fetch must carry the Basic header. Returns the
 *  Response so callers can branch on status (and reset auth on 401). */
async function adminFetch(
  authHeader: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const headers = new Headers(init?.headers || {});
  headers.set("authorization", authHeader);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(path, { ...init, headers, credentials: "same-origin" });
}

interface BanResult {
  slug: string;
  was_cached: boolean;
  comments_deleted: number;
  votes_deleted: number;
  article_row_deleted: boolean;
  article_votes_deleted: number;
  presence_notified: boolean;
}

export function Admin() {
  // Initialize from sessionStorage so a page refresh inside the same tab
  // keeps you signed in. null = logged out; non-null = the Basic header
  // we should attach to admin calls.
  const [auth, setAuth] = useState<string | null>(() => loadStoredAuth());

  // Validate any stored auth once on mount. If the password rotated since
  // the last session, the stored header is stale — drop it.
  useEffect(() => {
    if (!auth) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await adminFetch(auth, "/api/admin/check", {
          method: "POST",
        });
        if (cancelled) return;
        if (res.status === 401) {
          storeAuth(null);
          setAuth(null);
        }
      } catch {
        /* network blip; keep the header optimistically */
      }
    })();
    return () => {
      cancelled = true;
    };
    // We intentionally only re-run this when `auth` flips between
    // null and non-null, not on every render.
  }, [auth]);

  const onLogout = useCallback(() => {
    storeAuth(null);
    setAuth(null);
  }, []);

  return (
    <section className="admin-panel" aria-label="Admin panel">
      <header className="admin-header">
        <h1>Admin</h1>
        {auth && (
          <button
            type="button"
            className="admin-logout"
            onClick={onLogout}
          >
            Log out
          </button>
        )}
      </header>

      {!auth ? (
        <LoginForm onSuccess={(h) => { storeAuth(h); setAuth(h); }} />
      ) : (
        <>
          <BanForm
            authHeader={auth}
            onAuthExpired={() => {
              storeAuth(null);
              setAuth(null);
            }}
          />
          <EnrichForm
            authHeader={auth}
            onAuthExpired={() => {
              storeAuth(null);
              setAuth(null);
            }}
          />
        </>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Login form                                                                 */
/* -------------------------------------------------------------------------- */

function LoginForm({ onSuccess }: { onSuccess: (authHeader: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!password) {
        setError("Password required.");
        return;
      }
      setSubmitting(true);
      setError(null);
      // btoa handles ASCII fine. The password is operator-set so we don't
      // need to worry about non-ASCII bytes in practice; if we ever did,
      // we'd switch to TextEncoder + manual base64.
      const header = `Basic ${btoa(`${username}:${password}`)}`;
      try {
        const res = await adminFetch(header, "/api/admin/check", {
          method: "POST",
        });
        if (res.status === 401) {
          setError("Wrong username or password.");
          return;
        }
        if (res.status === 429) {
          const j: any = await res.json().catch(() => ({}));
          setError(j?.error || "Too many attempts. Try again later.");
          return;
        }
        if (!res.ok) {
          setError(`Login failed (${res.status}).`);
          return;
        }
        onSuccess(header);
      } catch (err: any) {
        setError(err?.message || "Network error.");
      } finally {
        setSubmitting(false);
      }
    },
    [username, password, onSuccess]
  );

  return (
    <form className="admin-login" onSubmit={onSubmit}>
      <label className="admin-field">
        <span>Username</span>
        <input
          type="text"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={submitting}
          autoFocus
        />
      </label>
      <label className="admin-field">
        <span>Password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
        />
      </label>
      {error && <p className="admin-error">{error}</p>}
      <button type="submit" className="admin-submit" disabled={submitting}>
        {submitting ? "Checking…" : "Sign in"}
      </button>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/*  Ban form                                                                   */
/* -------------------------------------------------------------------------- */

function BanForm({
  authHeader,
  onAuthExpired,
}: {
  authHeader: string;
  onAuthExpired: () => void;
}) {
  const [slug, setSlug] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BanResult | null>(null);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const cleaned = slug.trim();
      if (!cleaned) {
        setError("Enter a slug.");
        return;
      }
      // Mild client-side confirmation. Server normalises again anyway.
      if (
        !window.confirm(
          `Ban "${cleaned}"?\n\nThis deletes the article HTML, all comments and votes for it, its score row, and removes it from the "Currently Being Consulted" panel for all live readers. The slug will be refused if regenerated.`
        )
      ) {
        return;
      }
      setSubmitting(true);
      setError(null);
      setResult(null);
      try {
        const res = await adminFetch(authHeader, "/api/admin/ban", {
          method: "POST",
          body: JSON.stringify({ slug: cleaned }),
        });
        if (res.status === 401) {
          onAuthExpired();
          return;
        }
        if (!res.ok) {
          const j: any = await res.json().catch(() => ({}));
          setError(j?.error || `Ban failed (${res.status}).`);
          return;
        }
        const j = (await res.json()) as BanResult;
        setResult(j);
        setSlug("");
      } catch (err: any) {
        setError(err?.message || "Network error.");
      } finally {
        setSubmitting(false);
      }
    },
    [slug, authHeader, onAuthExpired]
  );

  return (
    <div className="admin-section">
      <h2>Ban a slug</h2>
      <p className="admin-section-blurb">
        Comprehensive nuke. Wipes the article HTML, comments, votes, score
        row, and live-presence entry. The slug is added to the moderation
        ban list so any future regeneration request returns the redacted
        notice.
      </p>
      <form className="admin-ban-form" onSubmit={onSubmit}>
        <input
          type="text"
          className="admin-slug-input"
          placeholder="slug-to-ban or 'Original Title'"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          disabled={submitting}
          autoFocus
        />
        <button
          type="submit"
          className="admin-submit admin-submit-danger"
          disabled={submitting || !slug.trim()}
        >
          {submitting ? "Banning…" : "Ban"}
        </button>
      </form>
      {error && <p className="admin-error">{error}</p>}
      {result && <BanResultPanel result={result} />}
    </div>
  );
}

function BanResultPanel({ result }: { result: BanResult }) {
  return (
    <div className="admin-result">
      <p className="admin-result-headline">
        Banned <code>{result.slug}</code>.
      </p>
      <ul className="admin-result-list">
        <li>
          KV cache:{" "}
          <strong>{result.was_cached ? "deleted" : "was not present"}</strong>
        </li>
        <li>
          Top Folios row:{" "}
          <strong>
            {result.article_row_deleted ? "deleted" : "no row to delete"}
          </strong>{" "}
          ({result.article_votes_deleted} article votes removed)
        </li>
        <li>
          Comments: <strong>{result.comments_deleted} removed</strong>{" "}
          ({result.votes_deleted} comment votes removed)
        </li>
        <li>
          Live presence:{" "}
          <strong>
            {result.presence_notified
              ? "notified — sidebars refreshed"
              : "notify failed (DO unreachable?)"}
          </strong>
        </li>
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Enrich-with-images form                                                    */
/* -------------------------------------------------------------------------- */

interface ArticleCandidate {
  slug: string;
  title: string;
  score: number;
  has_images: boolean;
  missing: boolean;
}

interface EnrichResult {
  processed: number;
  enriched: number;
  images_added: number;
  results: Array<{
    slug: string;
    ok: boolean;
    images_added: number;
    skipped_reason?: string;
  }>;
}

function EnrichForm({
  authHeader,
  onAuthExpired,
}: {
  authHeader: string;
  onAuthExpired: () => void;
}) {
  const [minVotes, setMinVotes] = useState("5");
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<ArticleCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<EnrichResult | null>(null);

  const onSearch = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const n = parseInt(minVotes, 10);
      if (!Number.isFinite(n) || n < 0) {
        setError("Enter a non-negative number.");
        return;
      }
      setSearching(true);
      setError(null);
      setResult(null);
      try {
        const res = await adminFetch(
          authHeader,
          `/api/admin/articles-by-votes?min=${n}`
        );
        if (res.status === 401) {
          onAuthExpired();
          return;
        }
        if (!res.ok) {
          const j: any = await res.json().catch(() => ({}));
          setError(j?.error || `Search failed (${res.status}).`);
          return;
        }
        const j = (await res.json()) as {
          articles: ArticleCandidate[];
        };
        setCandidates(j.articles);
        // Pre-select everything that's enrichable (cached + no images yet).
        const next = new Set<string>();
        for (const a of j.articles) {
          if (!a.missing && !a.has_images) next.add(a.slug);
        }
        setSelected(next);
      } catch (err: any) {
        setError(err?.message || "Network error.");
      } finally {
        setSearching(false);
      }
    },
    [minVotes, authHeader, onAuthExpired]
  );

  const toggle = useCallback((slug: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  const onEnrich = useCallback(async () => {
    if (selected.size === 0) {
      setError("Select at least one article.");
      return;
    }
    if (
      !window.confirm(
        `Enrich ${selected.size} article(s) with images?\n\nFor each one, an LLM call will plan 2-4 images and our worker will insert <img> tags. Images themselves are generated lazily on first visit (subject to the daily cap).`
      )
    ) {
      return;
    }
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await adminFetch(authHeader, "/api/admin/enrich-images", {
        method: "POST",
        body: JSON.stringify({ slugs: [...selected] }),
      });
      if (res.status === 401) {
        onAuthExpired();
        return;
      }
      if (!res.ok) {
        const j: any = await res.json().catch(() => ({}));
        setError(j?.error || `Enrich failed (${res.status}).`);
        return;
      }
      const j = (await res.json()) as EnrichResult;
      setResult(j);
      // Refresh the candidate flags so already-enriched rows show that.
      setCandidates((prev) => {
        if (!prev) return prev;
        const okSlugs = new Set(
          j.results.filter((r) => r.ok).map((r) => r.slug)
        );
        return prev.map((c) =>
          okSlugs.has(c.slug) ? { ...c, has_images: true } : c
        );
      });
      setSelected(new Set());
    } catch (err: any) {
      setError(err?.message || "Network error.");
    } finally {
      setSubmitting(false);
    }
  }, [selected, authHeader, onAuthExpired]);

  return (
    <div className="admin-section">
      <h2>Enrich articles with images</h2>
      <p className="admin-section-blurb">
        Find articles with at least N upvotes, then run a plan-and-insert
        pass on the selected ones. The LLM only describes WHERE to put
        images and WHAT they should depict — the worker performs the
        actual byte-level HTML edits and verifies that nothing outside
        the new <code>&lt;img&gt;</code> tags changed. Images themselves
        are generated lazily the first time a visitor loads them.
      </p>
      <form className="admin-enrich-form" onSubmit={onSearch}>
        <label className="admin-field">
          <span>Minimum upvotes</span>
          <input
            type="number"
            min={0}
            value={minVotes}
            onChange={(e) => setMinVotes(e.target.value)}
            disabled={searching || submitting}
          />
        </label>
        <button type="submit" className="admin-submit" disabled={searching || submitting}>
          {searching ? "Searching…" : "Find articles"}
        </button>
      </form>

      {error && <p className="admin-error">{error}</p>}

      {candidates && candidates.length === 0 && (
        <p className="admin-empty">No articles meet that threshold.</p>
      )}

      {candidates && candidates.length > 0 && (
        <>
          <ul className="admin-candidates">
            {candidates.map((c) => {
              const disabled = c.missing || c.has_images;
              return (
                <li key={c.slug} className="admin-candidate">
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(c.slug)}
                      disabled={disabled || submitting}
                      onChange={() => toggle(c.slug)}
                    />
                    <span className="admin-candidate-title">{c.title}</span>
                    <code className="admin-candidate-slug">/{c.slug}</code>
                    <span className="admin-candidate-score">↑ {c.score}</span>
                    {c.has_images && (
                      <span className="admin-candidate-flag">already enriched</span>
                    )}
                    {c.missing && (
                      <span className="admin-candidate-flag admin-candidate-flag-warn">
                        missing from KV
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="admin-submit admin-submit-danger"
            onClick={onEnrich}
            disabled={submitting || selected.size === 0}
          >
            {submitting
              ? "Enriching…"
              : `Enrich ${selected.size} selected`}
          </button>
        </>
      )}

      {result && (
        <div className="admin-result">
          <p className="admin-result-headline">
            Enriched {result.enriched} / {result.processed} article(s) —{" "}
            <strong>{result.images_added}</strong> image rows created.
          </p>
          <ul className="admin-result-list">
            {result.results.map((r) => (
              <li key={r.slug}>
                <code>/{r.slug}</code>{" "}
                {r.ok ? (
                  <strong>+{r.images_added} images</strong>
                ) : (
                  <span className="admin-skipped">
                    skipped: {r.skipped_reason || "unknown"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

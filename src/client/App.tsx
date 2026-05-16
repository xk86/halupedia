import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Admin } from "./Admin";
import { AllEntries } from "./AllEntries";
import { SearchResults } from "./SearchResults";
import { Sidebar } from "./Sidebar";

type Route =
  | { kind: "home" }
  | { kind: "search"; query: string }
  | { kind: "index" }
  | { kind: "admin" }
  | { kind: "article"; slug: string };

interface BacklinkItem {
  slug: string;
  title: string;
  visibleLabel: string;
  hiddenHint: string;
  createdAt: number;
}

interface PageData {
  cached: boolean;
  canonicalPath?: string;
  redirectedFrom?: string;
  article: {
    slug: string;
    canonicalSlug: string;
    title: string;
    html: string;
    markdown: string;
    plain_text: string;
    generated_at: number;
  };
  backlinks: {
    existing: BacklinkItem[];
    unwritten: BacklinkItem[];
  };
}

interface LinkMenuState {
  text: string;
  x: number;
  y: number;
}

function stripLeadingH1(html: string): string {
  return html.replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>\s*/i, "");
}

function countInternalLinks(markdown: string): number {
  const matches = markdown.match(/\]\(halu:[^) "\t\r\n]+(?:\s+"[^"]*")?\)/g);
  return matches?.length ?? 0;
}

function parseRoute(): Route {
  const { pathname, search } = window.location;
  if (pathname === "/") return { kind: "home" };
  if (pathname === "/all-entries") return { kind: "index" };
  if (pathname === "/admin") return { kind: "admin" };
  if (pathname === "/search") {
    return { kind: "search", query: new URLSearchParams(search).get("q") ?? "" };
  }
  if (pathname.startsWith("/wiki/")) {
    return {
      kind: "article",
      slug: decodeURIComponent(pathname.slice("/wiki/".length)).replace(/^\/+|\/+$/g, ""),
    };
  }
  return { kind: "home" };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [page, setPage] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [headerSearchDraft, setHeaderSearchDraft] = useState("");
  const [linkMenu, setLinkMenu] = useState<LinkMenuState | null>(null);
  const [linkMenuBusy, setLinkMenuBusy] = useState(false);
  const [linkMenuError, setLinkMenuError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const articleRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onPop = () => {
      const next = parseRoute();
      setRoute(next);
      setHeaderSearchDraft(next.kind === "search" ? next.query : "");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (route.kind !== "article") {
      setPage(null);
      setLoading(false);
      setError(null);
      setLinkMenu(null);
      setLinkMenuError(null);
      setLinkMenuBusy(false);
      setEditOpen(false);
      setEditDraft("");
      setEditBusy(false);
      setEditError(null);
      document.title =
        route.kind === "search"
          ? route.query
            ? `Search: ${route.query} - Halupedia`
            : "Search - Halupedia"
          : route.kind === "admin"
          ? "Admin - Halupedia"
          : route.kind === "index"
          ? "All entries - Halupedia"
          : "Halupedia";
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setPage(null);
    setLinkMenu(null);
    setLinkMenuError(null);
    setLinkMenuBusy(false);
    setEditOpen(false);
    setEditDraft("");
    setEditBusy(false);
    setEditError(null);
    let streamedHtml = "";

    (async () => {
      try {
        const res = await fetch(`/api/page/${encodeURIComponent(route.slug)}`);
        if (!res.ok) {
          const body: any = await res.json().catch(() => ({}));
          throw new Error(body?.error || `error ${res.status}`);
        }
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/x-ndjson")) {
          const data: PageData = await res.json();
          if (cancelled) return;
          setPage(data);
          setLoading(false);
          if (data.canonicalPath && data.redirectedFrom && window.location.pathname !== data.canonicalPath) {
            window.history.replaceState({}, "", data.canonicalPath);
          }
          document.title = `${data.article.title} - Halupedia`;
          return;
        }

        if (!res.body) throw new Error("streaming response missing body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf("\n");
            if (!line) continue;
            const event = JSON.parse(line) as
              | { type: "start"; slug: string; cached: boolean }
              | { type: "progress"; html: string }
              | {
                  type: "done";
                  cached: boolean;
                  redirectedFrom?: string;
                  article: PageData["article"];
                  backlinks: PageData["backlinks"];
                  canonicalPath?: string;
                }
              | { type: "error"; message: string };
            if (cancelled) return;
            if (event.type === "progress") {
              streamedHtml = event.html;
              setPage((current) => ({
                cached: false,
                article: current?.article ?? {
                  slug: route.slug,
                  canonicalSlug: route.slug,
                  title: route.slug,
                  html: streamedHtml,
                  markdown: "",
                  plain_text: "",
                  generated_at: Date.now(),
                },
                backlinks: current?.backlinks ?? { existing: [], unwritten: [] },
              }));
              setPage((current) =>
                current
                  ? {
                      ...current,
                      article: {
                        ...current.article,
                        html: streamedHtml,
                      },
                    }
                  : current
              );
              setLoading(false);
            } else if (event.type === "done") {
              setPage({
                cached: event.cached,
                canonicalPath: event.canonicalPath,
                redirectedFrom: event.redirectedFrom,
                article: {
                  ...event.article,
                  html: event.article.html || streamedHtml,
                },
                backlinks: event.backlinks,
              });
              setLoading(false);
              if (event.canonicalPath && event.redirectedFrom && window.location.pathname !== event.canonicalPath) {
                window.history.replaceState({}, "", event.canonicalPath);
              }
              document.title = `${event.article.title} - Halupedia`;
            } else if (event.type === "error") {
              throw new Error(event.message);
            }
          }
        }
      } catch (err: any) {
        if (cancelled) return;
        console.error("[app] article_load_failed", err);
        setError(articleFailureMessage);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [route]);

  const navigateHome = useCallback(() => {
    window.history.pushState({}, "", "/");
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    setRoute({ kind: "home" });
  }, []);

  const navigateToArticle = useCallback((slugOrTitleSegment: string) => {
    const clean = slugOrTitleSegment.replace(/^\/+|\/+$/g, "");
    window.history.pushState({}, "", `/wiki/${clean}`);
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    setRoute({ kind: "article", slug: clean });
  }, []);

  const navigateToSearch = useCallback((query: string) => {
    const trimmed = query.trim();
    const url = trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : "/search";
    window.history.pushState({}, "", url);
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    setHeaderSearchDraft(trimmed);
    setRoute({ kind: "search", query: trimmed });
  }, []);

  const navigateToIndex = useCallback(() => {
    window.history.pushState({}, "", "/all-entries");
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    setRoute({ kind: "index" });
  }, []);

  const navigateToAdmin = useCallback(() => {
    window.history.pushState({}, "", "/admin");
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    setRoute({ kind: "admin" });
  }, []);

  const interceptArticleLinks = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const target = (e.target as HTMLElement).closest("a");
      if (!target) return;
      const href = target.getAttribute("href");
      if (!href?.startsWith("/wiki/")) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e as any).button === 1) return;
      e.preventDefault();
      navigateToArticle(href.slice("/wiki/".length));
    },
    [navigateToArticle]
  );

  const clearLinkSelection = useCallback(() => {
    setLinkMenu(null);
    setLinkMenuBusy(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
  }, []);

  const addLinkFromSelection = useCallback(async () => {
    if (!page?.article.slug || !linkMenu?.text || linkMenuBusy) return;
    setLinkMenuBusy(true);
    setLinkMenuError(null);
    try {
      const res = await fetch(`/api/article/${encodeURIComponent(page.article.slug)}/add-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selectedText: linkMenu.text }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `error ${res.status}`);
      setPage(payload as PageData);
      clearLinkSelection();
    } catch (err: any) {
      setLinkMenuError(err?.message || "Could not add a link there.");
      setLinkMenuBusy(false);
    }
  }, [page?.article.slug, linkMenu?.text, linkMenuBusy, clearLinkSelection]);

  const rewriteArticle = useCallback(async () => {
    if (!page?.article.slug || !editDraft.trim() || editBusy) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const res = await fetch(`/api/article/${encodeURIComponent(page.article.slug)}/rewrite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instructions: editDraft }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `error ${res.status}`);
      setPage(payload as PageData);
      setEditOpen(false);
      setEditDraft("");
      setEditBusy(false);
    } catch (err: any) {
      setEditError(err?.message || "Could not rewrite the article.");
      setEditBusy(false);
    }
  }, [page?.article.slug, editDraft, editBusy]);

  useEffect(() => {
    if (route.kind !== "article" || !page || loading) {
      setLinkMenu(null);
      return;
    }

    const syncSelection = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        setLinkMenu(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const articleEl = articleRef.current;
      if (!articleEl) {
        setLinkMenu(null);
        return;
      }
      const anchorNode =
        range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
          ? (range.commonAncestorContainer as Element)
          : range.commonAncestorContainer.parentElement;
      if (!anchorNode || !articleEl.contains(anchorNode) || anchorNode.closest("a")) {
        setLinkMenu(null);
        return;
      }
      const text = selection
        .toString()
        .replace(/\s+/g, " ")
        .trim();
      if (text.length < 2) {
        setLinkMenu(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) {
        setLinkMenu(null);
        return;
      }
      setLinkMenu({
        text,
        x: rect.left + rect.width / 2,
        y: Math.max(12, rect.top - 12),
      });
    };

    document.addEventListener("selectionchange", syncSelection);
    document.addEventListener("scroll", syncSelection, true);
    return () => {
      document.removeEventListener("selectionchange", syncSelection);
      document.removeEventListener("scroll", syncSelection, true);
    };
  }, [route.kind, page, loading]);

  const articleSlug = route.kind === "article" ? route.slug : null;
  const articleTitle = page?.article.title ?? "";
  const hasZeroLinks = page ? countInternalLinks(page.article.markdown) === 0 : false;

  const mainView = useMemo(() => {
    if (route.kind === "home") {
      return (
        <article className="article">
          <h1>Halupedia</h1>
          <p>
            A local fictional encyclopedia whose canon accumulates over time. Articles seed future articles through
            hidden link hints, and the backlink graph persists even when a target entry has not been written yet.
          </p>
          <p>
            Search for an existing entry, or click through to an unwritten one and let your local model draft it from
            prior references, optional retrieval context, and user-owned prompt templates.
          </p>
        </article>
      );
    }

    if (route.kind === "index") {
      return <AllEntries onNavigate={navigateToArticle} />;
    }

    if (route.kind === "admin") {
      return <Admin onNavigate={navigateToArticle} />;
    }

    if (route.kind === "search") {
      return <SearchResults q={route.query} onNavigate={navigateToArticle} onSearch={navigateToSearch} />;
    }

    if (loading) {
      return (
        <div className="status">
          <span className="dot" />
          <span>Generating article and resolving canon...</span>
        </div>
      );
    }

    if (error) {
      return <div className="error">{articleFailureMessage}</div>;
    }

    if (!page) return null;

    return (
      <>
        {page.redirectedFrom ? (
          <div className="status">
            <span>Redirected from {page.redirectedFrom.replace(/^\/wiki\//, "").replace(/_/g, " ")}</span>
          </div>
        ) : null}
        {!page.cached && (
          <div className="status">
            <span className="dot" />
            <span>Fresh generation from local canon.</span>
          </div>
        )}
        {hasZeroLinks ? (
          <div className="linkless-notice">
            This article has no links. Expand it by highlighting text.
          </div>
        ) : null}
        <div className="article-title-row">
          <h1>{page.article.title}</h1>
          <button
            type="button"
            className="article-edit-button"
            onClick={() => {
              setEditOpen(true);
              setEditError(null);
            }}
            aria-label="Edit article"
            title="Edit article"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25Zm14.71-9.04a1.003 1.003 0 0 0 0-1.42l-2.5-2.5a1.003 1.003 0 0 0-1.42 0l-1.96 1.96 3.75 3.75 2.13-1.79Z" />
            </svg>
          </button>
        </div>
        <article ref={articleRef} className="article" onClick={interceptArticleLinks}>
          <div dangerouslySetInnerHTML={{ __html: stripLeadingH1(page.article.html) }} />
        </article>
      </>
    );
  }, [route, loading, error, page, navigateToArticle, navigateToSearch, interceptArticleLinks]);

  return (
    <div className="site">
      <header className="site-header">
        <a
          href="/"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            navigateHome();
          }}
        >
          Halupedia
        </a>

        <nav className="nav">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigateHome();
            }}
          >
            Home
          </a>
          <a
            href="/all-entries"
            onClick={(e) => {
              e.preventDefault();
              navigateToIndex();
            }}
          >
            All entries
          </a>
          <a
            href="/search"
            onClick={(e) => {
              e.preventDefault();
              navigateToSearch("");
            }}
          >
            Search
          </a>
          <a
            href="/admin"
            onClick={(e) => {
              e.preventDefault();
              navigateToAdmin();
            }}
          >
            Admin
          </a>
        </nav>

        <form
          className="header-search"
          onSubmit={(e) => {
            e.preventDefault();
            navigateToSearch(headerSearchDraft);
          }}
        >
          <input
            type="search"
            className="header-search-input"
            placeholder="Search the register..."
            value={headerSearchDraft}
            onChange={(e) => setHeaderSearchDraft(e.target.value)}
          />
          <button type="submit" className="header-search-submit" disabled={!headerSearchDraft.trim()}>
            Search
          </button>
        </form>
      </header>

      <section className="layout">
        <main className="layout-main">{mainView}</main>
        <Sidebar
          articleSlug={articleSlug}
          articleTitle={articleTitle}
          backlinks={page?.backlinks ?? null}
          onNavigate={navigateToArticle}
        />
      </section>

      {linkMenu ? (
        <div
          className="selection-link-menu"
          style={{ left: linkMenu.x, top: linkMenu.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button type="button" className="selection-link-button" onClick={addLinkFromSelection} disabled={linkMenuBusy}>
            {linkMenuBusy ? "Adding..." : "Add a link here"}
          </button>
          <button type="button" className="selection-link-dismiss" onClick={clearLinkSelection} disabled={linkMenuBusy}>
            Dismiss
          </button>
        </div>
      ) : null}

      {linkMenuError ? <div className="selection-link-error">{linkMenuError}</div> : null}

      {editOpen ? (
        <div className="edit-modal-backdrop" onClick={() => (!editBusy ? setEditOpen(false) : undefined)}>
          <div className="edit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="edit-modal-header">
              <h2>Edit Article</h2>
              <button type="button" className="edit-modal-close" onClick={() => setEditOpen(false)} disabled={editBusy}>
                Close
              </button>
            </div>
            <p className="edit-modal-note">Add a sentence or short paragraph of rewrite instructions. This may break links.</p>
            <textarea
              className="edit-modal-textarea"
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              placeholder="Example: Emphasize the city's municipal weather bureau history and make the prose drier."
              rows={7}
              disabled={editBusy}
            />
            {editError ? <div className="edit-modal-error">{editError}</div> : null}
            <div className="edit-modal-actions">
              <button type="button" className="edit-modal-submit" onClick={rewriteArticle} disabled={editBusy || !editDraft.trim()}>
                {editBusy ? "Rewriting..." : "Rewrite article"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <footer className="site-footer">Local-first fictional canon engine</footer>
    </div>
  );
}
  const articleFailureMessage =
    "This article could not be generated right now. Adjust prompts or retry from the admin panel.";

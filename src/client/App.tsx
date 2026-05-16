import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Admin } from "./Admin";
import { AllEntries } from "./AllEntries";
import { SearchResults } from "./SearchResults";
import { Sidebar } from "./Sidebar";
import { toWikiSegment } from "./wikiPath";

type Route =
  | { kind: "home" }
  | { kind: "search"; query: string }
  | { kind: "index" }
  | { kind: "admin" }
  | { kind: "article"; slug: string }
  | { kind: "history"; slug: string };

interface BacklinkItem {
  slug: string;
  title: string;
  visibleLabel: string;
  hiddenHint: string;
  summaryMarkdown?: string;
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
    summaryMarkdown?: string;
    plain_text: string;
    generated_at: number;
  };
  sections?: ArticleSection[];
  backlinks: {
    existing: BacklinkItem[];
    unwritten: BacklinkItem[];
  };
  refreshChanged?: boolean;
}

interface ArticleSection {
  id: string;
  title: string;
}

interface ArticleRevision {
  id: number;
  title: string;
  html: string;
  markdown: string;
  summaryMarkdown: string;
  generatedAt: number;
  createdAt: number;
  operation: string;
  instructions: string;
  revertedFromRevisionId: number | null;
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

function titleFromSegment(segment: string): string {
  return decodeURIComponent(segment)
    .replace(/^\/+|\/+$/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

type ThemeMode = "auto" | "dark";

function initialThemeMode(): ThemeMode {
  try {
    return window.localStorage.getItem("halupedia-theme") === "dark" ? "dark" : "auto";
  } catch {
    return "auto";
  }
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
    const wikiPath = decodeURIComponent(pathname.slice("/wiki/".length)).replace(/^\/+|\/+$/g, "");
    if (wikiPath.endsWith("/history")) {
      return {
        kind: "history",
        slug: wikiPath.replace(/\/history$/, ""),
      };
    }
    return {
      kind: "article",
      slug: wikiPath,
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
  const [searchSuggestOpen, setSearchSuggestOpen] = useState(false);
  const [linkMenu, setLinkMenu] = useState<LinkMenuState | null>(null);
  const [linkMenuBusy, setLinkMenuBusy] = useState(false);
  const [linkMenuError, setLinkMenuError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [editSectionId, setEditSectionId] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<ArticleRevision[]>([]);
  const [selectedRevision, setSelectedRevision] = useState<ArticleRevision | null>(null);
  const [restoreConfirmRevision, setRestoreConfirmRevision] = useState<ArticleRevision | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [revertingId, setRevertingId] = useState<number | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => initialThemeMode());
  const articleRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (themeMode === "dark") {
      document.documentElement.dataset.theme = "dark";
    } else {
      delete document.documentElement.dataset.theme;
    }
    try {
      if (themeMode === "dark") window.localStorage.setItem("halupedia-theme", "dark");
      else window.localStorage.removeItem("halupedia-theme");
    } catch {
      // Ignore storage failures; the visible theme toggle still works.
    }
  }, [themeMode]);

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
    if (route.kind !== "article" && route.kind !== "history") {
      setPage(null);
      setLoading(false);
      setError(null);
      setLinkMenu(null);
      setLinkMenuError(null);
      setLinkMenuBusy(false);
      setEditOpen(false);
      setEditDraft("");
      setEditSectionId("");
      setEditBusy(false);
      setEditError(null);
      setHistoryOpen(false);
      setHistoryLoading(false);
      setHistoryLoaded(false);
      setHistoryError(null);
      setRevisions([]);
      setSelectedRevision(null);
      setRestoreConfirmRevision(null);
      setRestoreMessage(null);
      setRevertingId(null);
      setRefreshBusy(false);
      setRefreshMessage(null);
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
    setEditSectionId("");
    setEditBusy(false);
    setEditError(null);
    setHistoryOpen(false);
    setHistoryLoading(false);
    setHistoryLoaded(false);
    setHistoryError(null);
    setRevisions([]);
    setSelectedRevision(null);
    setRestoreConfirmRevision(null);
    setRestoreMessage(null);
    setRevertingId(null);
    setRefreshBusy(false);
    setRefreshMessage(null);
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
              | { type: "progress"; html: string; markdown?: string }
              | {
                  type: "done";
                  cached: boolean;
                  redirectedFrom?: string;
                  article: PageData["article"];
                  sections?: ArticleSection[];
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
                  title: titleFromSegment(route.slug),
                  html: streamedHtml,
                  markdown: event.markdown ?? "",
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
                        markdown: event.markdown ?? current.article.markdown,
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
                sections: event.sections,
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

  const navigateToHistory = useCallback((slugOrTitleSegment: string) => {
    const clean = slugOrTitleSegment.replace(/^\/+|\/+$/g, "");
    window.history.pushState({}, "", `/wiki/${clean}/history`);
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    setRoute({ kind: "history", slug: clean });
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
    const previousPage = page;
    setEditBusy(true);
    setEditError(null);
    try {
      const res = await fetch(`/api/article/${encodeURIComponent(page.article.slug)}/rewrite?stream=1`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/x-ndjson" },
        body: JSON.stringify({ instructions: editDraft, sectionId: editSectionId || undefined }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.error || `error ${res.status}`);
      }
      if (!res.body) throw new Error("streaming response missing body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamedHtml = "";
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
            | { type: "progress"; html: string; markdown?: string }
            | ({ type: "done" } & PageData)
            | { type: "error"; message: string };
          if (event.type === "progress") {
            streamedHtml = event.html;
            setPage((current) =>
              current
                ? {
                    ...current,
                    cached: false,
                    article: {
                      ...current.article,
                      html: streamedHtml,
                      markdown: event.markdown ?? current.article.markdown,
                    },
                  }
                : current
            );
          } else if (event.type === "done") {
            setPage({
              cached: event.cached,
              canonicalPath: event.canonicalPath,
              redirectedFrom: event.redirectedFrom,
              article: {
                ...event.article,
                html: event.article.html || streamedHtml,
              },
              sections: event.sections,
              backlinks: event.backlinks,
            });
          } else if (event.type === "error") {
            throw new Error(event.message);
          }
        }
      }
      setEditDraft("");
      setEditSectionId("");
      setEditBusy(false);
      setHistoryOpen(false);
      setRevisions([]);
      setHistoryLoaded(false);
    } catch (err: any) {
      setPage(previousPage);
      setEditError(err?.message || "Could not rewrite the article.");
      setEditBusy(false);
    }
  }, [page, editDraft, editSectionId, editBusy]);

  const refreshContext = useCallback(async () => {
    if (!page?.article.slug || refreshBusy) return;
    setRefreshBusy(true);
    setRefreshMessage("Refreshing with retrieved context...");
    try {
      const res = await fetch(`/api/article/${encodeURIComponent(page.article.slug)}/refresh-context`, {
        method: "POST",
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `error ${res.status}`);
      setPage(payload as PageData);
      setRefreshMessage(payload.refreshChanged ? "References refreshed." : "References already up to date.");
      setHistoryOpen(false);
      setRevisions([]);
      setHistoryLoaded(false);
    } catch (err: any) {
      setRefreshMessage(err?.message || "Could not refresh references.");
      console.error("[app] refresh_context_failed", err);
    } finally {
      setRefreshBusy(false);
    }
  }, [page?.article.slug, refreshBusy]);

  const fetchHistory = useCallback(async () => {
    if (!page?.article.slug || historyLoading) return;
    if (historyLoaded) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res = await fetch(`/api/article/${encodeURIComponent(page.article.slug)}/history`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 404) {
          setRevisions([]);
          setHistoryLoaded(true);
          return;
        }
        throw new Error(payload?.error || `error ${res.status}`);
      }
      setRevisions(payload.revisions ?? []);
      setHistoryLoaded(true);
    } catch (err: any) {
      setHistoryError(err?.message || "Could not load history.");
      setHistoryLoaded(true);
    } finally {
      setHistoryLoading(false);
    }
  }, [page?.article.slug, historyLoading, historyLoaded]);

  const loadHistory = useCallback(async () => {
    if (!page?.article.slug) return;
    navigateToHistory(page.article.title.replace(/\s+/g, "_"));
  }, [page?.article.slug, page?.article.title, navigateToHistory]);

  const revertToRevision = useCallback(async (revisionId: number) => {
    if (!page?.article.slug || revertingId) return;
    setRevertingId(revisionId);
    setHistoryError(null);
    try {
      const res = await fetch(`/api/article/${encodeURIComponent(page.article.slug)}/revert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionId }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `error ${res.status}`);
      setPage(payload as PageData);
      setRevisions([]);
      setHistoryLoaded(false);
      setSelectedRevision(null);
      setRestoreConfirmRevision(null);
      setRestoreMessage("Version restored.");
      setHistoryOpen(false);
    } catch (err: any) {
      setHistoryError(err?.message || "Could not revert that revision.");
    } finally {
      setRevertingId(null);
    }
  }, [page?.article.slug, revertingId]);

  useEffect(() => {
    if (route.kind === "history" && page && !historyLoading && !historyLoaded && !historyError) {
      void fetchHistory();
    }
  }, [route.kind, page, historyLoading, historyLoaded, historyError, fetchHistory]);

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

  const articleSlug = route.kind === "article" || route.kind === "history" ? route.slug : null;
  const articleTitle = page?.article.title ?? "";
  const hasZeroLinks = page ? countInternalLinks(page.article.markdown) === 0 : false;
  const historyEmpty = (historyOpen || route.kind === "history") && !historyLoading && !historyError && revisions.length === 0;

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

    if (route.kind === "history") {
      return (
        <>
          {restoreMessage ? <div className="status">{restoreMessage}</div> : null}
          <div className="history-page-header">
            <h1>History: {page.article.title}</h1>
            <button type="button" className="edit-modal-close" onClick={() => navigateToArticle(page.article.title.replace(/\s+/g, "_"))}>
              Current article
            </button>
          </div>
          <section className="history-panel history-panel-page" aria-label="Edit history">
            <div className="history-panel-header">
              <h2>Revisions</h2>
              {historyLoading ? <span>Loading...</span> : null}
            </div>
            {historyError ? <div className="edit-modal-error">{historyError}</div> : null}
            {historyEmpty ? <p className="history-empty">No edit history yet.</p> : null}
            <ol className="history-list">
              {revisions.map((revision) => (
                <li key={revision.id} className={selectedRevision?.id === revision.id ? "selected" : undefined}>
                  <div>
                    <strong>{revision.operation}</strong>
                    <time>{new Date(revision.createdAt).toLocaleString()}</time>
                    {revision.instructions ? <p>{revision.instructions}</p> : null}
                    {revision.summaryMarkdown ? <p className="history-summary">{revision.summaryMarkdown}</p> : null}
                  </div>
                  <button type="button" onClick={() => {
                    setSelectedRevision(revision);
                    setRestoreConfirmRevision(null);
                    setRestoreMessage(null);
                  }}>
                    View revision {revision.id}
                  </button>
                </li>
              ))}
            </ol>
          </section>
          {selectedRevision ? (
            <>
              <div className="old-revision-notice">
                <strong>You are viewing an old revision.</strong>
                <span>This preview does not change the current article.</span>
              </div>
              <div className="history-restore-row">
                <button
                  type="button"
                  className="danger-restore-button"
                  onClick={() => setRestoreConfirmRevision(selectedRevision)}
                  disabled={revertingId !== null}
                >
                  Restore this version
                </button>
                {restoreConfirmRevision?.id === selectedRevision.id ? (
                  <div className="restore-confirm" role="dialog" aria-label="Confirm restore">
                    <strong>Restore this old revision?</strong>
                    <div>
                      <button type="button" onClick={() => revertToRevision(selectedRevision.id)} disabled={revertingId !== null}>
                        {revertingId === selectedRevision.id ? "Restoring..." : "Yes, restore"}
                      </button>
                      <button type="button" onClick={() => setRestoreConfirmRevision(null)} disabled={revertingId !== null}>
                        No
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
              <article className="article old-revision-preview">
                <div dangerouslySetInnerHTML={{ __html: stripLeadingH1(selectedRevision.html) }} />
              </article>
            </>
          ) : null}
        </>
      );
    }

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
        {refreshMessage ? <div className="status">{refreshMessage}</div> : null}
        <div className="article-title-row">
          <h1>{page.article.title}</h1>
          <button
            type="button"
            className="article-edit-button"
            onClick={refreshContext}
            disabled={refreshBusy}
            aria-label="Refresh with retrieved context"
            title="Refresh with retrieved context"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.76-4.24L13 11h8V3l-3.3 3.3Z" />
            </svg>
          </button>
          <button
            type="button"
            className="article-edit-button"
            onClick={loadHistory}
            aria-label="View history"
            title="View history"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M13 3a9 9 0 1 1-8.95 10H2l3-3.2L8 13H6.06A7 7 0 1 0 13 5a6.95 6.95 0 0 0-4.95 2.05L6.63 5.63A8.94 8.94 0 0 1 13 3Zm-1 4h2v5.15l3.2 1.9-1 1.72-4.2-2.5V7Z" />
            </svg>
          </button>
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
        {editOpen ? (
          <section className="edit-tray" aria-label="Edit article">
            <div className="edit-tray-row">
              <label>
                Section
                <select value={editSectionId} onChange={(e) => setEditSectionId(e.target.value)} disabled={editBusy}>
                  <option value="">Entire article</option>
                  {(page.sections ?? []).map((section) => (
                    <option key={section.id} value={section.id}>
                      {section.title}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="edit-modal-close" onClick={() => setEditOpen(false)} disabled={editBusy}>
                Close
              </button>
            </div>
            <textarea
              className="edit-modal-textarea"
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              placeholder="Describe your changes."
              rows={4}
              disabled={editBusy}
            />
            {editError ? <div className="edit-modal-error">{editError}</div> : null}
            <div className="edit-modal-actions">
              <button type="button" className="edit-modal-submit" onClick={rewriteArticle} disabled={editBusy || !editDraft.trim()}>
                {editBusy ? "Rewriting..." : "Apply edit"}
              </button>
            </div>
          </section>
        ) : null}
        {historyOpen ? (
          <section className="history-panel" aria-label="Edit history">
            <div className="history-panel-header">
              <h2>History</h2>
              {historyLoading ? <span>Loading...</span> : null}
            </div>
            {historyError ? <div className="edit-modal-error">{historyError}</div> : null}
            {historyEmpty ? <p className="history-empty">No edit history yet.</p> : null}
            <ol className="history-list">
              {revisions.map((revision) => (
                <li key={revision.id}>
                  <div>
                    <strong>{revision.operation}</strong>
                    <time>{new Date(revision.createdAt).toLocaleString()}</time>
                    {revision.instructions ? <p>{revision.instructions}</p> : null}
                    {revision.summaryMarkdown ? <p className="history-summary">{revision.summaryMarkdown}</p> : null}
                  </div>
                  <button type="button" onClick={() => revertToRevision(revision.id)} disabled={revertingId !== null}>
                    {revertingId === revision.id ? "Reverting..." : "Revert"}
                  </button>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        <article ref={articleRef} className="article" onClick={interceptArticleLinks}>
          <div dangerouslySetInnerHTML={{ __html: stripLeadingH1(page.article.html) }} />
        </article>
      </>
    );
  }, [route, loading, error, page, navigateToArticle, navigateToSearch, interceptArticleLinks, refreshContext, refreshBusy, refreshMessage, loadHistory, editOpen, editSectionId, editBusy, editDraft, editError, rewriteArticle, historyOpen, historyLoading, historyLoaded, historyError, historyEmpty, revisions, selectedRevision, restoreConfirmRevision, restoreMessage, revertingId, revertToRevision]);

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

        <button
          type="button"
          className="theme-toggle"
          aria-label={themeMode === "dark" ? "Use automatic theme" : "Use night mode"}
          title={themeMode === "dark" ? "Use automatic theme" : "Use night mode"}
          onClick={() => setThemeMode((mode) => (mode === "dark" ? "auto" : "dark"))}
        >
          {themeMode === "dark" ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V5a1 1 0 0 1 1-1Zm0 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7-5h-2a1 1 0 1 0 0 2h2a1 1 0 1 0 0-2ZM7 12a1 1 0 0 0-1-1H4a1 1 0 1 0 0 2h2a1 1 0 0 0 1-1Zm9.95-6.36a1 1 0 0 1 1.41 1.41l-1.41 1.41a1 1 0 1 1-1.41-1.41l1.41-1.41ZM8.46 16.95a1 1 0 0 0-1.41-1.41l-1.41 1.41a1 1 0 0 0 1.41 1.41l1.41-1.41Zm9.9 0a1 1 0 0 0-1.41-1.41l-1.41 1.41a1 1 0 0 0 1.41 1.41l1.41-1.41ZM8.46 7.05 7.05 5.64a1 1 0 0 0-1.41 1.41l1.41 1.41a1 1 0 0 0 1.41-1.41ZM12 17a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1Z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M21 14.6A8.1 8.1 0 0 1 9.4 3a7.9 7.9 0 1 0 11.6 11.6Z" />
            </svg>
          )}
        </button>

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
            if (headerSearchDraft.trim()) {
              navigateToArticle(toWikiSegment(headerSearchDraft.trim()));
              setHeaderSearchDraft("");
            }
          }}
        >
          <div className="header-search-wrap">
            <input
              type="search"
              className="header-search-input"
              placeholder="Search the register..."
              value={headerSearchDraft}
              onChange={(e) => setHeaderSearchDraft(e.target.value)}
              onFocus={() => setSearchSuggestOpen(true)}
              onBlur={() => setTimeout(() => setSearchSuggestOpen(false), 150)}
            />
            {searchSuggestOpen && headerSearchDraft.trim() && (
              <ul className="header-search-suggest">
                <li>
                  <button
                    type="button"
                    className="header-search-suggest-item"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      navigateToArticle(toWikiSegment(headerSearchDraft.trim()));
                      setHeaderSearchDraft("");
                      setSearchSuggestOpen(false);
                    }}
                  >
                    Go to: <strong>{headerSearchDraft.trim()}</strong>
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    className="header-search-suggest-item"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      navigateToSearch(headerSearchDraft);
                      setSearchSuggestOpen(false);
                    }}
                  >
                    Search: <strong>{headerSearchDraft.trim()}</strong>
                  </button>
                </li>
              </ul>
            )}
          </div>
          <button type="submit" className="header-search-submit">
            Go
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

      <footer className="site-footer">Local-first fictional canon engine</footer>
    </div>
  );
}
  const articleFailureMessage =
    "This article could not be generated right now. Adjust prompts or retry from the admin panel.";

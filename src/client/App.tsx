import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import clsx from "clsx";
import {
  CopyIcon,
  HistoryIcon,
  LockIcon,
  MoonIcon,
  PencilIcon,
  RefreshCwIcon,
  SunIcon,
  UnlockIcon,
} from "lucide-react";
import { Admin } from "./Admin";
import { AllEntries } from "./AllEntries";
import { GraphView } from "./GraphView";
import { HeadlineImagePanel } from "./HeadlineImagePanel";
import { Homepage } from "./Homepage";
import { MediaPage } from "./MediaPage";
import { MediaListPage } from "./MediaListPage";
import { SearchResults } from "./SearchResults";
import { Settings } from "./Settings";
import { Sidebar } from "./Sidebar";
import { MarkdownEditor } from "./MarkdownEditor";
import { ArticleSearchDropdown } from "./ArticleSearchDropdown";
import { ArticleProse, articleProseClasses } from "./article/ArticleProse";
import { ArticleBacklinks } from "./article/ArticleBacklinks";
import { ArticleBody } from "./article/ArticleBody";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { renderInlineHtml } from "./summaryHtml";
import {
  applyThemeSettings,
  loadThemeSettings,
  persistThemeSettings,
  resolveThemeMode,
  type ThemeSettings,
} from "./theme";
import { articleInputToWikiSegment, toWikiSegment } from "./wikiPath";
import {
  slugify,
  normalizeCanonicalTitle,
  wikiSegmentToRequestedTitle,
} from "../server/slug";

type Route =
  | { kind: "home" }
  | { kind: "search"; query: string }
  | { kind: "index" }
  | { kind: "admin" }
  | { kind: "settings" }
  | { kind: "random" }
  | { kind: "graph" }
  | { kind: "article"; slug: string; title?: string }
  | { kind: "disambiguation"; slug: string }
  | { kind: "media"; imageSlug: string }
  | { kind: "media-list" };

interface BacklinkItem {
  slug: string;
  title: string;
  visibleLabel: string;
  hiddenHint: string;
  summaryMarkdown?: string;
  createdAt: number;
}

import type { InfoboxData, HeadlineMedia } from "@/types";

interface PageData {
  cached: boolean;
  canonicalPath?: string;
  redirectedFrom?: string;
  article: {
    slug: string;
    canonicalSlug: string;
    title: string;
    displayTitle?: string;
    html: string;
    markdown: string;
    summaryMarkdown?: string;
    plain_text: string;
    generated_at: number;
  };
  infobox?: InfoboxData | null;
  headlineMedia?: HeadlineMedia | null;
  sections?: ArticleSection[];
  backlinks: {
    existing: BacklinkItem[];
    unwritten: BacklinkItem[];
  };
  referenceStatus?: {
    missing: Array<{ slug: string; title: string }>;
    unformatted?: Array<{ slug: string; title: string }>;
    hasReferencesSection?: boolean;
  };
  refreshChanged?: boolean;
  statusMessage?: string;
  isProtected?: boolean;
  protectedSections?: string[];
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
  // Remove the first h1 regardless of position — an infobox <aside> may
  // now precede it, so a start-of-string anchor no longer works.
  return html.replace(/<h1[^>]*>[\s\S]*?<\/h1>\s*/i, "");
}

const articleFailureMessage =
  "This article could not be generated right now. Adjust prompts or retry from the admin panel.";

function systemPrefersDark(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function initialThemeSettings(): ThemeSettings {
  return loadThemeSettings();
}

function persistTheme(settings: ThemeSettings): void {
  try {
    persistThemeSettings(settings);
  } catch {
    // Storage can be disabled. The in-memory theme still remains usable.
  }
}

function parseRoute(): Route {
  const { pathname, search } = window.location;
  if (pathname === "/") return { kind: "home" };
  if (pathname === "/Random" || pathname === "/random")
    return { kind: "random" };
  if (pathname === "/all-entries") return { kind: "index" };
  if (pathname === "/admin") return { kind: "admin" };
  if (pathname === "/settings") return { kind: "settings" };
  if (pathname === "/graph") return { kind: "graph" };
  if (pathname === "/search") {
    return {
      kind: "search",
      query: new URLSearchParams(search).get("q") ?? "",
    };
  }
  if (pathname === "/media") return { kind: "media-list" };
  if (pathname.startsWith("/media/")) {
    return {
      kind: "media",
      imageSlug: decodeURIComponent(pathname.slice("/media/".length)),
    };
  }
  if (pathname.startsWith("/wiki/")) {
    // Strip the legacy /history suffix BEFORE toWikiSegment — the segment
    // normalizer removes slashes, so checking afterwards would mangle the
    // slug into "Article_urlhistory". History now renders in-page, so old
    // history URLs simply land on the article.
    const rawPath = decodeURIComponent(pathname.slice("/wiki/".length))
      .replace(/^\/+|\/+$/g, "")
      .replace(/\/history$/, "");
    // Same ordering constraint: ":" and "/" don't survive toWikiSegment, so
    // the disambiguation prefix must be detected on the raw path.
    if (rawPath.startsWith("Special:Disambiguation/")) {
      return {
        kind: "disambiguation",
        slug: toWikiSegment(rawPath.slice("Special:Disambiguation/".length)),
      };
    }
    const wikiPath = toWikiSegment(rawPath);
    return {
      kind: "article",
      slug: wikiPath,
      title: new URLSearchParams(search).get("title") ?? undefined,
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
  const [editSelectedText, setEditSelectedText] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [editSectionId, setEditSectionId] = useState("");
  const [editIncludeRecentPrompts, setEditIncludeRecentPrompts] =
    useState(false);
  // References panel state
  const [editRefsEnabled, setEditRefsEnabled] = useState(false);
  const [editRefs, setEditRefs] = useState<
    Array<{
      slug: string;
      title: string;
      summaryMarkdown: string;
      pinned: boolean;
    }>
  >([]);
  const [editInitialRefSlugs, setEditInitialRefSlugs] = useState<string[]>([]);
  const [editAddRefsOpen, setEditAddRefsOpen] = useState(false);
  // Slugs the user has explicitly removed from the reference list. Loaded
  // from the article's persisted blacklist when the edit tray opens; every
  // mutation is applied immediately via a refs-only edit (no LLM).
  const [editBlacklist, setEditBlacklist] = useState<string[]>([]);
  const [editBlacklistOpen, setEditBlacklistOpen] = useState(false);
  const [editBlacklistInput, setEditBlacklistInput] = useState("");
  // Typeahead query for adding references (single unified search dropdown).
  const [editRefSearchDraft, setEditRefSearchDraft] = useState("");
  const [editRewriteMode, setEditRewriteMode] = useState<
    "aggressive" | "subtle"
  >("aggressive");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  // Title editing
  const [editTitleDraft, setEditTitleDraft] = useState("");
  const [editTitleBusy, setEditTitleBusy] = useState(false);
  const [editTitleError, setEditTitleError] = useState<string | null>(null);
  // Protection
  const [protectionBusy, setProtectionBusy] = useState(false);
  const [rawEditOpen, setRawEditOpen] = useState(false);
  const [rawEditMarkdown, setRawEditMarkdown] = useState("");
  const [rawEditPreview, setRawEditPreview] = useState<{
    html: string;
    diagnostics: Array<{ severity: string; message: string }>;
  } | null>(null);
  const [rawEditPreviewBusy, setRawEditPreviewBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<ArticleRevision[]>([]);
  const [selectedRevision, setSelectedRevision] =
    useState<ArticleRevision | null>(null);
  const [restoreConfirmRevision, setRestoreConfirmRevision] =
    useState<ArticleRevision | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [revertingId, setRevertingId] = useState<number | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [copySlugMessage, setCopySlugMessage] = useState<string | null>(null);
  const [themeSettings, setThemeSettings] =
    useState<ThemeSettings>(initialThemeSettings);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const articleRef = useRef<HTMLElement | null>(null);
  const editTrayRef = useRef<HTMLElement | null>(null);
  const inFlightSlugRef = useRef<string | null>(null);
  // Abort controller for any in-flight rewrite/refresh stream. Cancelled on navigation.
  const activeOperationRef = useRef<AbortController | null>(null);
  // The user's literal typed title (e.g. from the search bar), remembered
  // out-of-band for the next page fetch of that slug — sent as a request
  // header rather than a URL param so the address bar stays clean.
  const pendingRequestedTitleRef = useRef<{
    slug: string;
    title: string;
  } | null>(null);
  const editIsPartial =
    editSectionId === "__selection__" || Boolean(editSectionId);
  const editInitialRefSlugSet = useMemo(
    () => new Set(editInitialRefSlugs),
    [editInitialRefSlugs],
  );
  const editRefsToggleLocked = editIsPartial && editInitialRefSlugs.length > 0;
  // Reference selection differs from what was loaded — enough to submit an
  // edit even with an empty prompt (the server applies it without an LLM call).
  const editRefsChanged =
    editRefsEnabled &&
    (editRefs.length !== editInitialRefSlugs.length ||
      editRefs.some((r) => !editInitialRefSlugSet.has(r.slug)));

  useLayoutEffect(() => {
    applyThemeSettings(themeSettings, systemDark);
  }, [systemDark, themeSettings]);

  useEffect(() => {
    const timeout = window.setTimeout(() => persistTheme(themeSettings), 150);
    return () => window.clearTimeout(timeout);
  }, [themeSettings]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setSystemDark(query.matches);
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);

  // --- Unsaved-edit navigation guard -------------------------------------
  // Navigating away always closes the in-place / AI edit panes. If the in-place
  // editor has unsaved changes, a confirm dialog first lets the user discard or
  // stay. dirtyRef keeps guardNav stable so the navigate* callbacks don't churn.
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const pendingNavRef = useRef<(() => void) | null>(null);
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current =
      rawEditOpen && page != null && rawEditMarkdown !== page.article.markdown;
  }, [rawEditOpen, rawEditMarkdown, page]);

  const closeEditors = useCallback(() => {
    setEditOpen(false);
    setRawEditOpen(false);
    setRawEditPreview(null);
    setEditError(null);
  }, []);

  const guardNav = useCallback(
    (proceed: () => void) => {
      if (dirtyRef.current) {
        pendingNavRef.current = () => {
          closeEditors();
          proceed();
        };
        setDiscardConfirmOpen(true);
        return;
      }
      closeEditors();
      proceed();
    },
    [closeEditors],
  );

  useEffect(() => {
    const onPop = () => {
      // Back/forward already changed the URL, so just close the editor and
      // follow it (the dirty confirm only guards in-app navigations).
      closeEditors();
      const next = parseRoute();
      setRoute(next);
      setHeaderSearchDraft(next.kind === "search" ? next.query : "");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [closeEditors]);

  useEffect(() => {
    if (route.kind === "random") {
      let cancelled = false;
      setPage(null);
      setLoading(true);
      setError(null);
      document.title = "Random - Halupedia";
      (async () => {
        try {
          const res = await fetch("/api/random-page");
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(payload?.error || `error ${res.status}`);
          const path = String(payload.path ?? "");
          const url = new URL(path, window.location.origin);
          if (
            url.origin !== window.location.origin ||
            !url.pathname.startsWith("/wiki/")
          ) {
            throw new Error("random page endpoint returned an invalid path");
          }
          if (cancelled) return;
          window.history.replaceState({}, "", url.pathname);
          setRoute({
            kind: "article",
            slug: toWikiSegment(
              decodeURIComponent(url.pathname.slice("/wiki/".length)),
            ),
          });
        } catch (err: any) {
          if (cancelled) return;
          console.error("[app] random_page_failed", err);
          setError(err?.message || "Could not choose a random page.");
          setLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    if (route.kind !== "article" && route.kind !== "disambiguation") {
      setPage(null);
      setLoading(false);
      setError(null);
      setLinkMenu(null);
      setLinkMenuError(null);
      setLinkMenuBusy(false);
      setEditOpen(false);
      setEditDraft("");
      setEditSectionId("");
      setEditSelectedText("");
      setEditIncludeRecentPrompts(false);
      setEditRefsEnabled(false);
      setEditRefs([]);
      setEditInitialRefSlugs([]);
      setEditAddRefsOpen(false);
      setEditBlacklist([]);
      setEditBlacklistOpen(false);
      setEditBlacklistInput("");
      setEditRefSearchDraft("");
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
      setCopySlugMessage(null);
      document.title =
        route.kind === "search"
          ? route.query
            ? `Search: ${route.query} - Halupedia`
            : "Search - Halupedia"
          : route.kind === "admin"
            ? "Admin - Halupedia"
            : route.kind === "settings"
              ? "Settings - Halupedia"
              : route.kind === "index"
                ? "All entries - Halupedia"
                : "Halupedia";
      return;
    }

    const fetchSlug = route.slug;
    if (inFlightSlugRef.current === fetchSlug) return;

    // Immediately normalize the URL so spaces → underscores before any server response.
    if (route.kind === "article") {
      const normalizedPath = `/wiki/${fetchSlug}`;
      if (window.location.pathname !== normalizedPath) {
        window.history.replaceState({}, "", normalizedPath);
      }
    }
    inFlightSlugRef.current = fetchSlug;

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
    setEditSelectedText("");
    setEditIncludeRecentPrompts(false);
    setEditBusy(false);
    setEditError(null);
    setEditRefsEnabled(false);
    setEditRefs([]);
    setEditInitialRefSlugs([]);
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
    setCopySlugMessage(null);
    let streamedHtml = "";

    (async () => {
      try {
        const apiUrl =
          route.kind === "disambiguation"
            ? `/api/disambiguation/${encodeURIComponent(route.slug)}`
            : `/api/page/${encodeURIComponent(route.slug)}`;
        const pendingTitle = pendingRequestedTitleRef.current;
        // Placeholder title shown while the article streams in. Prefer the
        // user's literal typed title (it carries punctuation the slug-based
        // URL can't, e.g. the colon in "Pee: A Test") so it appears
        // immediately instead of snapping in only once the article fully
        // renders. Falls back to reconstructing from the URL segment.
        const matchedPending =
          pendingTitle && pendingTitle.slug === route.slug
            ? pendingTitle.title
            : null;
        // Derive the title exactly the way the server will: slug-style URLs
        // (legacy /wiki/some-old-slug links) expand to their word-form title
        // immediately, instead of the raw segment flashing as the title/slug
        // until generation finishes.
        const placeholderTitle =
          matchedPending ??
          normalizeCanonicalTitle(wikiSegmentToRequestedTitle(route.slug));
        // The article's real slug, derived the same way the server derives it.
        const placeholderSlug = slugify(placeholderTitle);
        const res =
          pendingTitle && pendingTitle.slug === route.slug
            ? // HTTP header values must be ASCII/Latin-1 — titles with emoji or
            // other non-Latin1 characters (e.g. "Banana 🍌") would make fetch
            // throw synchronously ("invalid header value") if sent raw. Percent
            // -encode for transport; the server decodes it back to the literal.
            await fetch(apiUrl, {
              headers: {
                "x-requested-title": encodeURIComponent(pendingTitle.title),
              },
            })
            : await fetch(apiUrl);
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
          if (
            data.canonicalPath &&
            data.redirectedFrom &&
            window.location.pathname !== data.canonicalPath
          ) {
            window.history.replaceState({}, "", data.canonicalPath);
          }
          document.title = `${data.article.displayTitle || data.article.title} - Halupedia`;
          return;
        }

        if (!res.body) throw new Error("streaming response missing body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const pollGeneratedArticle = async (slug: string, attempt = 0) => {
          if (cancelled || attempt >= 240) return;
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          if (cancelled) return;
          try {
            const res = await fetch(
              `/api/page/${encodeURIComponent(slug)}?wait=0`,
            );
            if (res.status === 202) {
              await pollGeneratedArticle(slug, attempt + 1);
              return;
            }
            if (!res.ok) return;
            const data: PageData = await res.json();
            if (cancelled) return;
            setPage(data);
            setLoading(false);
            if (
              data.canonicalPath &&
              data.redirectedFrom &&
              window.location.pathname !== data.canonicalPath
            ) {
              window.history.replaceState({}, "", data.canonicalPath);
            }
            document.title = `${data.article.displayTitle || data.article.title} - Halupedia`;
            void pollPostProcess(data.article);
          } catch {
            return;
          }
        };
        const pollPostProcess = async (
          article: PageData["article"],
          attempt = 0,
        ) => {
          // Poll for up to ~2 minutes (40 attempts × 3 s) to catch slow postProcess
          // runs that include LLM calls for see-also and link repair.
          if (cancelled || attempt >= 40) return;
          await new Promise((resolve) => window.setTimeout(resolve, 3000));
          if (cancelled) return;
          try {
            const res = await fetch(
              `/api/page/${encodeURIComponent(toWikiSegment(article.title))}?wait=0`,
            );
            if (res.status === 202) {
              await pollPostProcess(article, attempt + 1);
              return;
            }
            if (!res.ok) return;
            const data: PageData = await res.json();
            if (cancelled) return;
            // Detect any server-side update: newer timestamp, changed markdown,
            // or a see-also section appearing for the first time.
            const hasNewSeeAlso =
              (data.article as any).metadata?.seeAlso?.length > 0 &&
              ((article as any).metadata?.seeAlso?.length ?? 0) === 0;
            if (
              (data.article.generated_at ?? 0) > (article.generated_at ?? 0) ||
              data.article.markdown !== article.markdown ||
              hasNewSeeAlso
            ) {
              // Only apply if the user is still on this article.
              setPage((current) => {
                if (current?.article.slug !== data.article.slug) return current;
                return data;
              });
              return;
            }
          } catch {
            return;
          }
          await pollPostProcess(article, attempt + 1);
        };
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
              | {
                type: "start";
                slug: string;
                cached: boolean;
                joined?: boolean;
              }
              | { type: "status"; message: string }
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
            if (event.type === "start") {
              setPage(
                (current) =>
                  current ?? {
                    cached: false,
                    article: {
                      slug: placeholderSlug,
                      canonicalSlug: placeholderSlug,
                      title: placeholderTitle,
                      html: "",
                      markdown: "",
                      plain_text: "",
                      generated_at: Date.now(),
                    },
                    backlinks: { existing: [], unwritten: [] },
                    statusMessage: "Waiting and contemplating...",
                  },
              );
              setLoading(false);
              // Joined streams now receive live progress events — no polling needed.
            } else if (event.type === "status") {
              setPage((current) =>
                current
                  ? { ...current, statusMessage: event.message }
                  : current,
              );
            } else if (event.type === "progress") {
              streamedHtml = event.html;
              setPage((current) => ({
                cached: false,
                article: current?.article ?? {
                  slug: placeholderSlug,
                  canonicalSlug: placeholderSlug,
                  title: placeholderTitle,
                  html: streamedHtml,
                  markdown: event.markdown ?? "",
                  plain_text: "",
                  generated_at: Date.now(),
                },
                backlinks: current?.backlinks ?? {
                  existing: [],
                  unwritten: [],
                },
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
                  : current,
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
              if (
                event.canonicalPath &&
                event.redirectedFrom &&
                window.location.pathname !== event.canonicalPath
              ) {
                window.history.replaceState({}, "", event.canonicalPath);
              }
              document.title = `${event.article.displayTitle || event.article.title} - Halupedia`;
              if (!event.cached) void pollPostProcess(event.article);
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
      } finally {
        if (!cancelled) inFlightSlugRef.current = null;
      }
    })();

    return () => {
      cancelled = true;
      inFlightSlugRef.current = null;
      // Abort any in-flight rewrite/refresh stream when navigating away.
      activeOperationRef.current?.abort();
      activeOperationRef.current = null;
    };
  }, [route]);

  const navigateHome = useCallback(() => {
    guardNav(() => {
      window.history.pushState({}, "", "/");
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
      setRoute({ kind: "home" });
    });
  }, [guardNav]);

  const navigateToArticle = useCallback(
    (slugOrTitleSegment: string, explicitTitle?: string) => {
      const clean = articleInputToWikiSegment(slugOrTitleSegment);
      if (!clean) return;
      guardNav(() => {
        // The URL is title-shaped when the caller has a title. Keep that title
        // out-of-band too, so punctuation that cannot survive the path still
        // reaches the server exactly.
        const title = explicitTitle?.trim();
        if (title) pendingRequestedTitleRef.current = { slug: clean, title };
        window.history.pushState({}, "", `/wiki/${clean}`);
        window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
        setRoute({ kind: "article", slug: clean });
      });
    },
    [guardNav],
  );

  const navigateToSearch = useCallback(
    (query: string) => {
      guardNav(() => {
        const trimmed = query.trim();
        const url = trimmed
          ? `/search?q=${encodeURIComponent(trimmed)}`
          : "/search";
        window.history.pushState({}, "", url);
        window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
        setHeaderSearchDraft(trimmed);
        setRoute({ kind: "search", query: trimmed });
      });
    },
    [guardNav],
  );

  const navigateToIndex = useCallback(() => {
    guardNav(() => {
      window.history.pushState({}, "", "/all-entries");
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
      setRoute({ kind: "index" });
    });
  }, [guardNav]);

  const navigateToRandom = useCallback(() => {
    guardNav(() => {
      window.history.pushState({}, "", "/Random");
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
      setRoute({ kind: "random" });
    });
  }, [guardNav]);

  const navigateToAdmin = useCallback(() => {
    guardNav(() => {
      window.history.pushState({}, "", "/admin");
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
      setRoute({ kind: "admin" });
    });
  }, [guardNav]);

  const navigateToSettings = useCallback(() => {
    guardNav(() => {
      window.history.pushState({}, "", "/settings");
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
      setRoute({ kind: "settings" });
    });
  }, [guardNav]);

  const navigateToGraph = useCallback(() => {
    guardNav(() => {
      window.history.pushState({}, "", "/graph");
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
      setRoute({ kind: "graph" });
    });
  }, [guardNav]);

  const navigateToDisambiguation = useCallback(
    (titleSegment: string) => {
      guardNav(() => {
        const clean = titleSegment.replace(/^\/+|\/+$/g, "");
        window.history.pushState(
          {},
          "",
          `/wiki/Special:Disambiguation/${clean}`,
        );
        window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
        setRoute({ kind: "disambiguation", slug: clean });
      });
    },
    [guardNav],
  );

  const navigateToMedia = useCallback(
    (imageSlug: string) => {
      guardNav(() => {
        window.history.pushState(
          {},
          "",
          `/media/${encodeURIComponent(imageSlug)}`,
        );
        window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
        setRoute({ kind: "media", imageSlug });
      });
    },
    [guardNav],
  );

  const navigateToMediaList = useCallback(() => {
    guardNav(() => {
      window.history.pushState({}, "", "/media");
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
      setRoute({ kind: "media-list" });
    });
  }, [guardNav]);

  // Called by Sidebar when the live stream emits an {type:"article"} event.
  // Refetches the page once and applies it only if the user is still on that slug.
  const handleLiveArticleUpdate = useCallback((updatedSlug: string) => {
    fetch(`/api/page/${encodeURIComponent(updatedSlug)}?wait=0`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: PageData | null) => {
        if (!data) return;
        setPage((latest) => {
          if (latest?.article.slug !== data.article.slug) return latest;
          return data;
        });
      })
      .catch(() => { });
  }, []);

  const interceptArticleLinks = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const target = (e.target as HTMLElement).closest("a");
      if (!target) return;
      const href = target.getAttribute("href");
      if (!href) return;
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey ||
        (e as any).button === 1
      )
        return;
      // Swallow dead "#" hrefs emitted by the markdown renderer for any
      // non-halu link (server markdown.ts rewrites them to "#"). Without
      // this the browser appends "#" to the URL bar with no navigation.
      if (href === "#" || href.startsWith("#")) {
        e.preventDefault();
        return;
      }
      if (href.startsWith("/wiki/")) {
        e.preventDefault();
        navigateToArticle(href.slice("/wiki/".length));
      } else if (href.startsWith("/media/")) {
        e.preventDefault();
        navigateToMedia(decodeURIComponent(href.slice("/media/".length)));
      }
    },
    [navigateToArticle, navigateToMedia],
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
      const res = await fetch(
        `/api/article/${encodeURIComponent(page.article.slug)}/add-link`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ selectedText: linkMenu.text }),
        },
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `error ${res.status}`);
      setPage(payload as PageData);
      clearLinkSelection();
    } catch (err: any) {
      setLinkMenuError(err?.message || "Could not add a link there.");
      setLinkMenuBusy(false);
    }
  }, [page?.article.slug, linkMenu?.text, linkMenuBusy, clearLinkSelection]);

  const openSelectionEdit = useCallback(() => {
    if (!linkMenu?.text) return;
    setEditSelectedText(linkMenu.text);
    setEditSectionId("__selection__");
    setEditOpen(true);
    setLinkMenu(null);
  }, [linkMenu?.text]);

  // Load saved references from the server — called on edit-open and after saves.
  const loadEditRefs = useCallback((slug: string) => {
    fetch(`/api/article/${encodeURIComponent(slug)}/references`)
      .then((r) => r.json())
      .then(
        (body: {
          references?: Array<{
            slug: string;
            title: string;
            summaryMarkdown: string;
            pinned?: boolean;
          }>;
          blacklist?: string[];
        }) => {
          const seen = new Set<string>();
          const refs = (body.references ?? [])
            .filter((r) => {
              if (seen.has(r.slug)) return false;
              seen.add(r.slug);
              return true;
            })
            .map((r) => ({ ...r, pinned: Boolean(r.pinned) }));
          setEditRefs(refs);
          setEditInitialRefSlugs(refs.map((ref) => ref.slug));
          setEditRefsEnabled(refs.length > 0);
          setEditBlacklist(body.blacklist ?? []);
        },
      )
      .catch(() => { });
  }, []);

  useEffect(() => {
    if (!editOpen || !page?.article.slug) return;
    loadEditRefs(page.article.slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editOpen, page?.article.slug]);

  const addEditRef = useCallback(
    (ref: { slug: string; title: string; summary?: string }) => {
      setEditRefs((prev) =>
        prev.some((r) => r.slug === ref.slug)
          ? prev
          : [
            ...prev,
            {
              slug: ref.slug,
              title: ref.title,
              summaryMarkdown: ref.summary ?? "",
              pinned: false,
            },
          ],
      );
      setEditRefSearchDraft("");
    },
    [],
  );

  const removeEditRef = useCallback(
    (slug: string) => {
      if (editIsPartial && editInitialRefSlugSet.has(slug)) return;
      setEditRefs((prev) => prev.filter((r) => r.slug !== slug));
    },
    [editIsPartial, editInitialRefSlugSet],
  );

  // Apply a blacklist change immediately and deterministically: a refs-only
  // edit (no LLM call) that persists the blocklist, rebuilds the reference
  // sidecar, and refreshes the rendered References section.
  const syncBlacklist = useCallback(
    async (nextBlacklist: string[]) => {
      if (!page?.article.slug) return;
      const slug = page.article.slug;
      setEditBlacklist(nextBlacklist);
      setEditError(null);
      try {
        const res = await fetch(
          `/api/article/${encodeURIComponent(slug)}/rewrite`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              instructions: "",
              blacklistSlugs: nextBlacklist,
            }),
          },
        );
        const payload = await res.json().catch(() => null);
        if (!res.ok)
          throw new Error((payload as any)?.error || `error ${res.status}`);
        if (payload) setPage(payload as PageData);
        loadEditRefs(slug);
      } catch (err: any) {
        setEditError(err?.message || "Could not update excluded references.");
      }
    },
    [page?.article.slug, loadEditRefs],
  );

  const blacklistEditRef = useCallback(
    (slug: string) => {
      setEditRefs((prev) => prev.filter((r) => r.slug !== slug));
      setEditBlacklistOpen(true);
      if (!editBlacklist.includes(slug))
        void syncBlacklist([...editBlacklist, slug]);
    },
    [editBlacklist, syncBlacklist],
  );

  const togglePinRef = useCallback(
    (slug: string) => {
      if (!page?.article.slug) return;
      const current = editRefs.find((r) => r.slug === slug);
      if (!current) return;
      const newPinned = !current.pinned;
      setEditRefs((prev) =>
        prev.map((r) => (r.slug === slug ? { ...r, pinned: newPinned } : r)),
      );
      fetch(
        `/api/article/${encodeURIComponent(page.article.slug)}/pin-reference`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refSlug: slug, pinned: newPinned }),
        },
      ).catch(() => {
        // Revert on failure
        setEditRefs((prev) =>
          prev.map((r) => (r.slug === slug ? { ...r, pinned: !newPinned } : r)),
        );
      });
    },
    [page?.article.slug, editRefs],
  );

  const openRawEdit = useCallback(() => {
    if (!page?.article.markdown) return;
    setRawEditMarkdown(page.article.markdown);
    setRawEditOpen(true);
    setRawEditPreview(null);
    setEditError(null);
    // Editing happens in place of the article body, so close the AI-edit panel.
    setEditOpen(false);
  }, [page?.article.markdown]);

  const previewRawEdit = useCallback(async () => {
    if (!page?.article.slug || !rawEditMarkdown.trim() || rawEditPreviewBusy)
      return;
    setRawEditPreviewBusy(true);
    try {
      const res = await fetch(
        `/api/article/${encodeURIComponent(page.article.slug)}/preview-markdown`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ markdown: rawEditMarkdown }),
        },
      );
      const data = (await res.json()) as {
        html?: string;
        diagnostics?: Array<{ severity: string; message: string }>;
      };
      setRawEditPreview({
        html: data.html ?? "",
        diagnostics: data.diagnostics ?? [],
      });
    } catch {
      setRawEditPreview({
        html: "",
        diagnostics: [{ severity: "error", message: "Preview failed" }],
      });
    } finally {
      setRawEditPreviewBusy(false);
    }
  }, [page?.article.slug, rawEditMarkdown, rawEditPreviewBusy]);

  const saveRawEdit = useCallback(async () => {
    if (!page?.article.slug || !rawEditMarkdown.trim() || editBusy) return;
    const previousPage = page;
    setEditBusy(true);
    setEditError(null);
    try {
      const res = await fetch(
        `/api/article/${encodeURIComponent(page.article.slug)}/raw-save`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            markdown: rawEditMarkdown,
            ...(editRefsEnabled && editRefs.length > 0
              ? {
                referenceSlugs: editRefs.map((r) => r.slug),
                ...(editRefs.some((r) => r.pinned)
                  ? {
                    pinnedSlugs: editRefs
                      .filter((r) => r.pinned)
                      .map((r) => r.slug),
                  }
                  : {}),
              }
              : {}),
          }),
        },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(
          (payload as { error?: string })?.error || `error ${res.status}`,
        );
      }
      const payload = (await res.json()) as { article?: typeof page.article };
      if (payload.article) {
        setPage((current) =>
          current ? { ...current, article: payload.article! } : current,
        );
      }
      setRawEditOpen(false);
      setRawEditMarkdown("");
      setHistoryLoaded(false);
      setEditBusy(false);
      if (page?.article.slug) loadEditRefs(page.article.slug);
    } catch (err: any) {
      setPage(previousPage);
      setEditError(err?.message || "Could not save.");
      setEditBusy(false);
    }
  }, [
    page,
    rawEditMarkdown,
    editBusy,
    editRefsEnabled,
    editRefs,
    loadEditRefs,
  ]);

  const rewriteArticle = useCallback(async () => {
    if (!page?.article.slug || editBusy) return;
    if (!editDraft.trim() && !editRefsChanged) return;
    const previousPage = page;
    const targetSlug = page.article.slug;
    const ac = new AbortController();
    activeOperationRef.current?.abort();
    activeOperationRef.current = ac;
    setEditBusy(true);
    setEditError(null);
    setPage((current) =>
      current ? { ...current, statusMessage: "Rewriting article..." } : current,
    );
    try {
      const res = await fetch(
        `/api/article/${encodeURIComponent(targetSlug)}/rewrite?stream=1`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/x-ndjson",
          },
          signal: ac.signal,
          body: JSON.stringify({
            instructions: editDraft,
            ...(editSectionId === "__selection__"
              ? { selectedText: editSelectedText }
              : { sectionId: editSectionId || undefined }),
            ...(editRefsEnabled &&
              (editRefs.length > 0 || editInitialRefSlugs.length > 0)
              ? {
                // Sent even when emptied: the panel state is authoritative, so
                // an empty array means "remove all refs" / "unpin all".
                referenceSlugs: editRefs.map((r) => r.slug),
                pinnedSlugs: editRefs
                  .filter((r) => r.pinned)
                  .map((r) => r.slug),
              }
              : {}),
            // Always sent: the panel state is authoritative, so an empty array
            // means "clear all persisted blocks" (it was loaded from the server
            // when the tray opened).
            blacklistSlugs: editBlacklist,
            ...(editIncludeRecentPrompts
              ? { includeRecentEditHistory: true }
              : {}),
            rewriteMode: editRewriteMode,
          }),
        },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.error || `error ${res.status}`);
      }
      // Server returns plain JSON (not NDJSON) when rewrite was blocked
      // (e.g. article protection active). Detect by content-type and bail cleanly.
      if (
        !(res.headers.get("content-type") ?? "").includes(
          "application/x-ndjson",
        )
      ) {
        const data = (await res.json().catch(() => null)) as PageData | null;
        if (data) setPage(data);
        else setPage(previousPage);
        setEditBusy(false);
        return;
      }
      if (!res.body) throw new Error("streaming response missing body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamedHtml = "";
      let doneArticle: PageData["article"] | null = null;
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
            | { type: "status"; message: string }
            | { type: "progress"; html: string; markdown?: string }
            | ({ type: "done" } & PageData)
            | { type: "error"; message: string };
          if (ac.signal.aborted) break;
          if (event.type === "status") {
            setPage((current) =>
              current?.article.slug === targetSlug
                ? { ...current, statusMessage: event.message }
                : current,
            );
          } else if (event.type === "progress") {
            streamedHtml = event.html;
            setPage((current) =>
              current?.article.slug === targetSlug
                ? {
                  ...current,
                  cached: false,
                  article: {
                    ...current.article,
                    html: streamedHtml,
                    markdown: event.markdown ?? current.article.markdown,
                  },
                }
                : current,
            );
          } else if (event.type === "done") {
            doneArticle = event.article;
            setPage((current) => {
              if (current?.article.slug !== event.article.slug) return current;
              return {
                cached: event.cached,
                canonicalPath: event.canonicalPath,
                redirectedFrom: event.redirectedFrom,
                article: {
                  ...event.article,
                  html: event.article.html || streamedHtml,
                },
                sections: event.sections,
                backlinks: event.backlinks,
              };
            });
          } else if (event.type === "error") {
            throw new Error(event.message);
          }
        }
      }
      // Start background polling for postProcess completion (see-also, link repair).
      if (doneArticle) {
        const pollSlug = doneArticle.slug;
        const pollTitle = doneArticle.title;
        const pollGeneratedAt = doneArticle.generated_at;
        (async () => {
          for (let i = 0; i < 40; i++) {
            await new Promise((r) => window.setTimeout(r, 3000));
            if (ac.signal.aborted) return;
            try {
              const res = await fetch(
                `/api/page/${encodeURIComponent(toWikiSegment(pollTitle))}?wait=0`,
                { signal: ac.signal },
              );
              if (!res.ok) continue;
              const data: PageData = await res.json();
              if (
                (data.article.generated_at ?? 0) > (pollGeneratedAt ?? 0) ||
                data.article.markdown !== doneArticle!.markdown
              ) {
                setPage((current) =>
                  current?.article.slug === pollSlug ? data : current,
                );
                return;
              }
            } catch {
              return;
            }
          }
        })();
      }
      setEditDraft("");
      setEditSectionId("");
      setEditSelectedText("");
      setEditIncludeRecentPrompts(false);
      setEditAddRefsOpen(false);
      setEditBlacklist([]);
      setEditBlacklistOpen(false);
      setEditBlacklistInput("");
      setEditRefSearchDraft("");
      setEditBusy(false);
      setHistoryOpen(false);
      setRevisions([]);
      setHistoryLoaded(false);
      // Reload refs from the freshly-saved article so the panel stays accurate.
      if (page?.article.slug) loadEditRefs(page.article.slug);
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      setPage(previousPage);
      setEditError(err?.message || "Could not rewrite the article.");
      setEditBusy(false);
    }
  }, [
    page,
    editDraft,
    editSectionId,
    editSelectedText,
    editRefsEnabled,
    editRefs,
    editRefsChanged,
    editInitialRefSlugs,
    editBlacklist,
    editIncludeRecentPrompts,
    editRewriteMode,
    editBusy,
    loadEditRefs,
  ]);

  const refreshContext = useCallback(async () => {
    if (!page?.article.slug || refreshBusy) return;
    const targetSlug = page.article.slug;
    const ac = new AbortController();
    activeOperationRef.current?.abort();
    activeOperationRef.current = ac;
    setRefreshBusy(true);
    setRefreshMessage("Refreshing with retrieved context...");
    try {
      const res = await fetch(
        `/api/article/${encodeURIComponent(targetSlug)}/refresh-context?stream=1`,
        {
          method: "POST",
          headers: { accept: "application/x-ndjson" },
          signal: ac.signal,
        },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.error || `error ${res.status}`);
      }
      if (!res.body) throw new Error("streaming response missing body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalPayload: PageData | null = null;
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
            | { type: "status"; message: string }
            | { type: "progress"; html: string; markdown?: string }
            | ({ type: "done" } & PageData)
            | { type: "error"; message: string };
          if (ac.signal.aborted) break;
          if (event.type === "status") {
            setRefreshMessage(event.message);
          } else if (event.type === "progress") {
            setPage((current) =>
              current?.article.slug === targetSlug
                ? {
                  ...current,
                  cached: false,
                  article: {
                    ...current.article,
                    html: event.html,
                    markdown: event.markdown ?? current.article.markdown,
                  },
                }
                : current,
            );
          } else if (event.type === "done") {
            finalPayload = event;
            // Only update the page if the user is still viewing this article.
            setPage((current) => {
              if (current?.article.slug !== event.article.slug) return current;
              return {
                cached: event.cached,
                canonicalPath: event.canonicalPath,
                redirectedFrom: event.redirectedFrom,
                refreshChanged: event.refreshChanged,
                article: event.article,
                sections: event.sections,
                backlinks: event.backlinks,
                referenceStatus: event.referenceStatus,
              };
            });
          } else if (event.type === "error") {
            throw new Error(event.message);
          }
        }
      }
      setRefreshMessage(
        finalPayload?.refreshChanged
          ? "Article refreshed."
          : "References already up to date.",
      );
      setHistoryOpen(false);
      setRevisions([]);
      setHistoryLoaded(false);
    } catch (err: any) {
      if (err?.name === "AbortError") return;
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
      const res = await fetch(
        `/api/article/${encodeURIComponent(page.article.slug)}/history`,
      );
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

  const loadHistory = useCallback(() => {
    if (!page?.article.slug) return;
    setHistoryOpen(true);
    setSelectedRevision(null);
    setRestoreConfirmRevision(null);
    setRestoreMessage(null);
  }, [page?.article.slug]);

  const revertToRevision = useCallback(
    async (revisionId: number) => {
      if (!page?.article.slug || revertingId) return;
      setRevertingId(revisionId);
      setHistoryError(null);
      try {
        const res = await fetch(
          `/api/article/${encodeURIComponent(page.article.slug)}/revert`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ revisionId }),
          },
        );
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
    },
    [page?.article.slug, revertingId],
  );

  useEffect(() => {
    if (
      historyOpen &&
      page &&
      !historyLoading &&
      !historyLoaded &&
      !historyError
    ) {
      void fetchHistory();
    }
  }, [
    historyOpen,
    page,
    historyLoading,
    historyLoaded,
    historyError,
    fetchHistory,
  ]);

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
      if (
        !anchorNode ||
        !articleEl.contains(anchorNode) ||
        anchorNode.closest("a")
      ) {
        setLinkMenu(null);
        return;
      }
      const text = selection.toString().replace(/\s+/g, " ").trim();
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

  // Scroll edit tray into view when it opens, and manage the selection highlight.
  // We use the CSS Custom Highlight API (CSS.highlights) if available so we can
  // keep a visual mark on the selected text without modifying the article DOM.
  useEffect(() => {
    const HIGHLIGHT_NAME = "halu-selection";
    if (!editOpen || !editSelectedText) {
      // Clean up any lingering highlight when the tray closes
      if (typeof CSS !== "undefined" && CSS.highlights) {
        CSS.highlights.delete(HIGHLIGHT_NAME);
      }
      return;
    }

    // Scroll tray into view
    editTrayRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

    // Re-apply the highlight using the current DOM selection range, if still present
    if (typeof CSS === "undefined" || !CSS.highlights) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed)
      return;
    try {
      const range = selection.getRangeAt(0);
      // CSS.highlights requires the Highlight constructor to be available
      if (typeof (globalThis as any).Highlight === "undefined") return;
      const highlight = new (globalThis as any).Highlight(range);
      CSS.highlights.set(HIGHLIGHT_NAME, highlight);
    } catch {
      // Browser may not support this; degrade gracefully
    }

    return () => {
      if (typeof CSS !== "undefined" && CSS.highlights) {
        CSS.highlights.delete(HIGHLIGHT_NAME);
      }
    };
  }, [editOpen, editSelectedText]);

  const articleSlug =
    route.kind === "article" || route.kind === "disambiguation"
      ? route.slug
      : null;
  const articleDisplayTitle =
    page?.article.displayTitle || page?.article.title || "";
  const articleTitle = page?.article.title ?? "";
  const historyEmpty =
    historyOpen &&
    historyLoaded &&
    !historyLoading &&
    !historyError &&
    revisions.length === 0;

  const copyArticleSlug = useCallback(async () => {
    if (!page?.article.slug) return;
    // Always show the slug so the user can copy it manually even if the API fails
    setCopySlugMessage(`Slug: ${page.article.slug}`);
    try {
      await navigator.clipboard.writeText(page.article.slug);
    } catch {
      // Clipboard write failed — the message still shows the slug for manual copy
    }
  }, [page]);

  const mainView = useMemo(() => {
    if (route.kind === "media") {
      return (
        <MediaPage imageSlug={route.imageSlug} onNavigate={navigateToArticle} />
      );
    }

    if (route.kind === "media-list") {
      return <MediaListPage onNavigateToMedia={navigateToMedia} />;
    }

    if (route.kind === "home") {
      return <Homepage onNavigate={navigateToArticle} />;
    }

    if (route.kind === "index") {
      return <AllEntries onNavigate={navigateToArticle} />;
    }

    if (route.kind === "admin") {
      return (
        <Admin onNavigate={navigateToArticle} onNavigateHome={navigateHome} />
      );
    }

    if (route.kind === "settings") {
      return (
        <Settings settings={themeSettings} onChange={setThemeSettings} />
      );
    }

    if (route.kind === "graph") {
      return <GraphView onNavigate={navigateToArticle} />;
    }

    if (route.kind === "random") {
      if (error) return <div className="error">{error}</div>;
      return (
        <div className="status">
          <span className="dot" />
          <span>Choosing a random article...</span>
        </div>
      );
    }

    if (route.kind === "search") {
      return (
        <SearchResults
          q={route.query}
          onNavigate={navigateToArticle}
          onSearch={navigateToSearch}
        />
      );
    }

    if (loading) {
      return (
        <div className="status">
          <span className="dot" />
          <span>Waiting and contemplating...</span>
        </div>
      );
    }

    if (error) {
      return <div className="error">{articleFailureMessage}</div>;
    }

    if (!page) return null;

    if (route.kind === "disambiguation") {
      return (
        <article
          className={clsx("article disambiguation-page", articleProseClasses)}
          onClick={interceptArticleLinks}
        >
          <div className="disambiguation-notice">
            This is a disambiguation page.
          </div>
          <h1
            dangerouslySetInnerHTML={{
              __html: renderInlineHtml(articleDisplayTitle),
            }}
          />
          <div
            dangerouslySetInnerHTML={{
              __html: stripLeadingH1(page.article.html),
            }}
          />
        </article>
      );
    }

    return (
      <>
        {page.redirectedFrom ? (
          <div className="status">
            <span>
              Redirected from{" "}
              {page.redirectedFrom.replace(/^\/wiki\//, "").replace(/_/g, " ")}
            </span>
          </div>
        ) : null}
        {!page.cached && (
          <div className="status">
            <span className="dot" />
            <span>Fresh generation from local canon.</span>
          </div>
        )}
        {refreshMessage ? <div className="status">{refreshMessage}</div> : null}
        {restoreMessage ? <div className="status">{restoreMessage}</div> : null}
        <div className="m-0 mb-5 grid grid-cols-[minmax(0,1fr)_auto] items-start justify-between gap-3 max-[680px]:grid-cols-1">
          <h1
            className="m-0 min-w-0 flex-1 border-b-2 border-rule pb-[0.6rem] font-serif text-[2.4rem] leading-[1.15] font-medium tracking-[-0.005em] text-balance [overflow-wrap:anywhere]"
            dangerouslySetInnerHTML={{
              __html: renderInlineHtml(articleDisplayTitle),
            }}
          />
          <div className="flex max-w-[clamp(7rem,18vw,16rem)] flex-row flex-nowrap content-start justify-end gap-2 max-[680px]:max-w-none max-[680px]:flex-wrap max-[680px]:justify-start">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="text-accent hover:border-accent hover:bg-accent-wash"
              style={{
                opacity: page.isProtected ? 1 : 0.35,
                fontSize: "1.1rem",
                lineHeight: 1,
              }}
              title={
                page.isProtected
                  ? "Article is locked — click to unlock"
                  : "Lock article against automatic rewrites"
              }
              aria-label={page.isProtected ? "Unlock article" : "Lock article"}
              disabled={protectionBusy}
              onClick={async () => {
                setProtectionBusy(true);
                try {
                  const res = await fetch(
                    `/api/article/${encodeURIComponent(page.article.slug)}/protect`,
                    {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ isProtected: !page.isProtected }),
                    },
                  );
                  if (res.ok) {
                    const data = (await res.json()) as { isProtected: boolean };
                    setPage((cur) =>
                      cur ? { ...cur, isProtected: data.isProtected } : cur,
                    );
                  }
                } finally {
                  setProtectionBusy(false);
                }
              }}
            >
              {page.isProtected ? (
                <LockIcon data-icon="inline-start" />
              ) : (
                <UnlockIcon data-icon="inline-start" />
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="text-accent hover:border-accent hover:bg-accent-wash"
              onClick={copyArticleSlug}
              aria-label="Copy slug"
              title="Copy slug"
            >
              <CopyIcon data-icon="inline-start" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="text-accent hover:border-accent hover:bg-accent-wash"
              onClick={refreshContext}
              disabled={refreshBusy}
              aria-label="Refresh with retrieved context"
              title="Refresh with retrieved context"
            >
              <RefreshCwIcon data-icon="inline-start" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="text-accent hover:border-accent hover:bg-accent-wash"
              onClick={loadHistory}
              aria-label="View history"
              title="View history"
            >
              <HistoryIcon data-icon="inline-start" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="text-accent hover:border-accent hover:bg-accent-wash"
              onClick={() => {
                setEditOpen(true);
                setEditError(null);
              }}
              aria-label="Edit article"
              title="Edit article"
            >
              <PencilIcon data-icon="inline-start" />
            </Button>
          </div>
        </div>
        {copySlugMessage ? (
          <div className="status">{copySlugMessage}</div>
        ) : null}
        {editOpen ? (
          <section
            className="edit-tray"
            aria-label="Edit article"
            ref={editTrayRef}
          >
            {/* Title editing row */}
            <div
              className="edit-tray-row"
              style={{
                borderBottom: "1px solid var(--color-border, #ddd)",
                paddingBottom: "0.5rem",
                marginBottom: "0.5rem",
              }}
            >
              <label style={{ flex: 1 }}>
                Title{" "}
                <span
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--color-muted, #888)",
                  }}
                >
                  (markdown, no links)
                </span>
                <Input
                  type="text"
                  className="mt-1 font-serif text-[1.05rem]"
                  placeholder={articleDisplayTitle}
                  value={editTitleDraft}
                  onChange={(e) => {
                    setEditTitleDraft(e.target.value);
                    setEditTitleError(null);
                  }}
                  disabled={editTitleBusy}
                />
              </label>
              <button
                type="button"
                className="edit-modal-close"
                style={{ alignSelf: "flex-end" }}
                disabled={editTitleBusy || !editTitleDraft.trim()}
                onClick={async () => {
                  const newTitle = editTitleDraft.trim();
                  if (!newTitle) return;
                  setEditTitleBusy(true);
                  setEditTitleError(null);
                  try {
                    const res = await fetch(
                      `/api/article/${encodeURIComponent(page.article.slug)}/update-title`,
                      {
                        method: "PATCH",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ title: newTitle }),
                      },
                    );
                    const data = (await res.json()) as any;
                    if (!res.ok) {
                      setEditTitleError(data.error ?? "Failed to update title");
                      return;
                    }
                    setEditTitleDraft("");
                    // Navigate to the new canonical path so the page re-fetches with the updated title.
                    if (data.canonicalPath) {
                      const clean = data.canonicalPath.replace(/^\/wiki\//, "");
                      navigateToArticle(clean);
                    } else {
                      setPage(data);
                    }
                  } catch {
                    setEditTitleError("Network error");
                  } finally {
                    setEditTitleBusy(false);
                  }
                }}
              >
                {editTitleBusy ? "Saving…" : "Save Title"}
              </button>
            </div>
            {editTitleError && (
              <p
                style={{
                  color: "red",
                  fontSize: "0.85rem",
                  marginBottom: "0.5rem",
                }}
              >
                {editTitleError}
              </p>
            )}

            {/* Headline image panel — owns its own state, lives outside mainView's memo */}
            <HeadlineImagePanel
              articleSlug={page.article.slug}
              onArticleUpdate={(article) =>
                setPage((cur) =>
                  cur
                    ? { ...cur, article: article as typeof cur.article }
                    : cur,
                )
              }
              onNavigateToMedia={navigateToMedia}
            />

            <div className="edit-tray-row">
              <label>
                Section
                <Select
                  value={editSectionId}
                  onValueChange={(v) => {
                    const val = v ?? "";
                    setEditSectionId(val);
                    if (val !== "__selection__") setEditSelectedText("");
                  }}
                  disabled={editBusy}
                  // label != value, so map values -> labels for the trigger.
                  items={{
                    "": "Entire article",
                    ...(editSelectedText
                      ? { __selection__: "*Selected Text*" }
                      : {}),
                    ...Object.fromEntries(
                      (page.sections ?? []).map((s) => [s.id, s.title]),
                    ),
                  }}
                >
                  <SelectTrigger aria-label="Section" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Entire article</SelectItem>
                    {editSelectedText && (
                      <SelectItem value="__selection__">
                        *Selected Text*
                      </SelectItem>
                    )}
                    {(page.sections ?? []).map((section) => (
                      <SelectItem key={section.id} value={section.id}>
                        {section.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="edit-modal-mode-toggle">
                Mode
                <Select
                  value={editRewriteMode}
                  onValueChange={(v) =>
                    setEditRewriteMode(
                      (v as "aggressive" | "subtle") ?? "aggressive",
                    )
                  }
                  disabled={editBusy}
                >
                  <SelectTrigger aria-label="Mode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="aggressive">Aggressive</SelectItem>
                    <SelectItem value="subtle">Subtle</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <button
                type="button"
                className="edit-modal-close"
                onClick={() => setEditOpen(false)}
                disabled={editBusy}
              >
                Close
              </button>
            </div>
            <MarkdownEditor
              className="edit-instructions-mdedit"
              value={editDraft}
              onChange={setEditDraft}
              placeholder="Describe your changes."
              minRows={3}
              disabled={editBusy}
            />
            <button
              type="button"
              className={clsx(
                "edit-recent-prompts-btn",
                editIncludeRecentPrompts && "edit-recent-prompts-btn--active",
              )}
              aria-pressed={editIncludeRecentPrompts}
              onClick={() => setEditIncludeRecentPrompts((enabled) => !enabled)}
              disabled={editBusy}
            >
              {editIncludeRecentPrompts
                ? "✓ Using last 2 edit prompts"
                : "Use last 2 edit prompts"}
            </button>
            {/* References panel */}
            <div className="edit-refs-row">
              <label className="edit-modal-rag-toggle flex items-center gap-1.5">
                <Checkbox
                  checked={editRefsEnabled}
                  onCheckedChange={(c) => {
                    if (editRefsToggleLocked) return;
                    const next = c === true;
                    setEditRefsEnabled(next);
                    if (!next) {
                      setEditAddRefsOpen(false);
                      setEditRefSearchDraft("");
                    }
                  }}
                  disabled={editBusy || editRefsToggleLocked}
                />
                Reference other articles
              </label>
              {editRefsEnabled && (
                <button
                  type="button"
                  className="edit-refs-add-btn"
                  onClick={() => {
                    setEditAddRefsOpen((o) => !o);
                    setEditRefSearchDraft("");
                  }}
                  disabled={editBusy}
                  aria-label="Add references"
                  title="Add references"
                >
                  {editAddRefsOpen ? "−" : "+"}
                </button>
              )}
            </div>

            {editRefsEnabled && editRefs.some((r) => r.pinned) && (
              <div className="edit-refs-pinned-section">
                <div className="edit-refs-section-header">
                  <span className="edit-refs-section-label">Pinned</span>
                  <span className="edit-refs-section-hint">
                    always included · persists between edits
                  </span>
                </div>
                <div className="edit-refs-tags">
                  {editRefs
                    .filter((r) => r.pinned)
                    .map((ref) => (
                      <span
                        key={ref.slug}
                        className="edit-ref-tag edit-ref-tag--pinned"
                      >
                        <button
                          type="button"
                          className="edit-ref-tag-pin edit-ref-tag-pin--active"
                          onClick={() => togglePinRef(ref.slug)}
                          disabled={editBusy}
                          aria-label={`Unpin ${ref.title}`}
                          title="Unpin"
                        >
                          📌
                        </button>
                        <a
                          href={`/wiki/${ref.slug}`}
                          target="_blank"
                          rel="noreferrer"
                          className="edit-ref-tag-link"
                        >
                          {ref.title}
                        </a>
                        <button
                          type="button"
                          className="edit-ref-tag-blacklist"
                          onClick={() => blacklistEditRef(ref.slug)}
                          disabled={editBusy}
                          aria-label={`Exclude ${ref.title}`}
                          title="Move to excluded"
                        >
                          🚫
                        </button>
                        <button
                          type="button"
                          className="edit-ref-tag-remove"
                          onClick={() => removeEditRef(ref.slug)}
                          disabled={
                            editBusy ||
                            (editIsPartial &&
                              editInitialRefSlugSet.has(ref.slug))
                          }
                          aria-label={`Remove ${ref.title}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                </div>
              </div>
            )}
            {editRefsEnabled && editRefs.some((r) => !r.pinned) && (
              <div className="edit-refs-tags">
                {editRefs
                  .filter((r) => !r.pinned)
                  .map((ref) => (
                    <span key={ref.slug} className="edit-ref-tag">
                      <button
                        type="button"
                        className="edit-ref-tag-pin"
                        onClick={() => togglePinRef(ref.slug)}
                        disabled={editBusy}
                        aria-label={`Pin ${ref.title}`}
                        title="Pin to always include"
                      >
                        📌
                      </button>
                      <a
                        href={`/wiki/${ref.slug}`}
                        target="_blank"
                        rel="noreferrer"
                        className="edit-ref-tag-link"
                      >
                        {ref.title}
                      </a>
                      <button
                        type="button"
                        className="edit-ref-tag-blacklist"
                        onClick={() => blacklistEditRef(ref.slug)}
                        disabled={editBusy}
                        aria-label={`Exclude ${ref.title}`}
                        title="Move to excluded"
                      >
                        🚫
                      </button>
                      <button
                        type="button"
                        className="edit-ref-tag-remove"
                        onClick={() => removeEditRef(ref.slug)}
                        disabled={
                          editBusy ||
                          (editIsPartial && editInitialRefSlugSet.has(ref.slug))
                        }
                        aria-label={`Remove ${ref.title}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
              </div>
            )}

            {editRefsEnabled && editAddRefsOpen && (
              <div className="mt-[0.3rem]">
                <ArticleSearchDropdown
                  inputType="text"
                  query={editRefSearchDraft}
                  onQueryChange={setEditRefSearchDraft}
                  placeholder="Search articles to reference…"
                  onPick={addEditRef}
                  renderPreview={(s) => s.summary?.slice(0, 100)}
                />
              </div>
            )}

            {/* Blacklist: articles to exclude from RAG/references for this rewrite */}
            <div className="edit-blacklist-row">
              <button
                type="button"
                className="edit-blacklist-toggle"
                onClick={() => setEditBlacklistOpen((o) => !o)}
                disabled={editBusy}
              >
                {editBlacklistOpen ? "▾" : "▸"} Excluded references
                {editBlacklist.length > 0 && (
                  <span className="edit-blacklist-count">
                    {" "}
                    ({editBlacklist.length})
                  </span>
                )}
              </button>
            </div>
            {editBlacklistOpen && (
              <div className="edit-blacklist-panel">
                {editBlacklist.length > 0 && (
                  <div className="edit-blacklist-tags">
                    {editBlacklist.map((slug) => (
                      <span key={slug} className="edit-blacklist-tag">
                        <span className="edit-blacklist-tag-slug">{slug}</span>
                        <button
                          type="button"
                          className="edit-blacklist-tag-remove"
                          onClick={() =>
                            void syncBlacklist(
                              editBlacklist.filter((s) => s !== slug),
                            )
                          }
                          disabled={editBusy}
                          aria-label={`Remove ${slug} from exclusions`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="edit-blacklist-add-row">
                  <input
                    type="text"
                    className="edit-blacklist-input"
                    value={editBlacklistInput}
                    onChange={(e) => setEditBlacklistInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const s = editBlacklistInput
                          .trim()
                          .toLowerCase()
                          .replace(/\s+/g, "-");
                        if (s && !editBlacklist.includes(s)) {
                          void syncBlacklist([...editBlacklist, s]);
                        }
                        setEditBlacklistInput("");
                      }
                    }}
                    placeholder="Slug to exclude (Enter to add)"
                    disabled={editBusy}
                  />
                </div>
              </div>
            )}

            {editError ? (
              <div className="edit-modal-error">{editError}</div>
            ) : null}
            {page.isProtected && (
              <div
                className="edit-modal-error"
                style={{
                  background: "transparent",
                  border: "1px solid var(--color-border, #ccc)",
                  color: "var(--color-muted, #888)",
                }}
              >
                🔒 Article is locked — LLM rewrites are blocked. Use{" "}
                <strong>Raw</strong> to edit directly.
              </div>
            )}
            <div className="edit-modal-actions">
              <button
                type="button"
                className="edit-modal-submit"
                onClick={rewriteArticle}
                disabled={
                  editBusy ||
                  (!editDraft.trim() && !editRefsChanged) ||
                  !!page.isProtected
                }
              >
                {editBusy ? "Rewriting..." : "Apply edit"}
              </button>
              <button
                type="button"
                className="edit-raw-btn"
                onClick={openRawEdit}
                disabled={editBusy}
                title="Edit raw markdown directly"
              >
                Raw
              </button>
            </div>
          </section>
        ) : null}
        {historyOpen ? (
          <section className="history-panel" aria-label="Edit history">
            <div className="history-panel-header">
              <h2>History</h2>
              {historyLoading ? <span>Loading...</span> : null}
              <button
                type="button"
                className="edit-modal-close"
                onClick={() => {
                  setHistoryOpen(false);
                  setSelectedRevision(null);
                  setRestoreConfirmRevision(null);
                  setRestoreMessage(null);
                }}
              >
                Close
              </button>
            </div>
            {historyError ? (
              <div className="edit-modal-error">{historyError}</div>
            ) : null}
            {historyEmpty ? (
              <p className="history-empty">No edit history yet.</p>
            ) : null}
            <ol className="history-list">
              {revisions.map((revision) => (
                <li
                  key={revision.id}
                  className={
                    selectedRevision?.id === revision.id
                      ? "selected"
                      : undefined
                  }
                >
                  <div>
                    <strong>{revision.operation}</strong>
                    <time>{new Date(revision.createdAt).toLocaleString()}</time>
                    {revision.instructions ? (
                      <p>{revision.instructions}</p>
                    ) : null}
                    {revision.summaryMarkdown ? (
                      <div
                        className="history-summary"
                        dangerouslySetInnerHTML={{
                          __html: renderInlineHtml(revision.summaryMarkdown),
                        }}
                      />
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedRevision((current) =>
                        current?.id === revision.id ? null : revision,
                      );
                      setRestoreConfirmRevision(null);
                      setRestoreMessage(null);
                    }}
                  >
                    {selectedRevision?.id === revision.id
                      ? "Hide revision"
                      : `View revision ${revision.id}`}
                  </button>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        {historyOpen && selectedRevision ? (
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
              <AlertDialog
                open={restoreConfirmRevision?.id === selectedRevision.id}
                onOpenChange={(open) => {
                  if (!open) setRestoreConfirmRevision(null);
                }}
              >
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Restore this old revision?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      This replaces the current article with this older version.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={revertingId !== null}>
                      No
                    </AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => revertToRevision(selectedRevision.id)}
                      disabled={revertingId !== null}
                    >
                      {revertingId === selectedRevision.id
                        ? "Restoring..."
                        : "Yes, restore"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            <article className="article old-revision-preview">
              <ArticleProse html={stripLeadingH1(selectedRevision.html)} />
            </article>
          </>
        ) : rawEditOpen ? (
          <article className="article article--editing">
            <div className="article-edit-bar">
              <span className="article-edit-bar-title">Editing in place</span>
              <div className="article-edit-bar-actions">
                <button
                  type="button"
                  className="edit-raw-btn"
                  onClick={previewRawEdit}
                  disabled={
                    editBusy || rawEditPreviewBusy || !rawEditMarkdown.trim()
                  }
                >
                  {rawEditPreviewBusy ? "Rendering…" : "Preview"}
                </button>
                {rawEditPreview && (
                  <button
                    type="button"
                    className="edit-raw-btn"
                    onClick={() => setRawEditPreview(null)}
                  >
                    Hide preview
                  </button>
                )}
                <button
                  type="button"
                  className="edit-modal-submit"
                  onClick={saveRawEdit}
                  disabled={editBusy || !rawEditMarkdown.trim()}
                >
                  {editBusy ? "Saving..." : "Save"}
                </button>
                <button
                  type="button"
                  className="edit-modal-close"
                  onClick={() => {
                    setRawEditOpen(false);
                    setRawEditPreview(null);
                    setEditError(null);
                  }}
                  disabled={editBusy}
                >
                  Close
                </button>
              </div>
            </div>
            {editError ? (
              <div className="edit-modal-error">{editError}</div>
            ) : null}
            <div
              className={`raw-edit-body${rawEditPreview ? " raw-edit-body--split" : ""}`}
            >
              <MarkdownEditor
                className="raw-edit-mdedit article-inplace-mdedit"
                value={rawEditMarkdown}
                onChange={(v) => {
                  setRawEditMarkdown(v);
                  setRawEditPreview(null);
                }}
                minRows={12}
                disabled={editBusy}
              />
              {rawEditPreview && (
                <div className="raw-edit-preview-pane">
                  <ArticleProse
                    className="raw-edit-preview-html article-body"
                    html={rawEditPreview.html}
                  />
                  {rawEditPreview.diagnostics.length > 0 && (
                    <div className="raw-edit-preview-diagnostics">
                      {rawEditPreview.diagnostics.map((d, i) => (
                        <div
                          key={i}
                          className={`raw-edit-diagnostic raw-edit-diagnostic--${d.severity}`}
                        >
                          <span className="raw-edit-diagnostic-badge">
                            {d.severity}
                          </span>
                          {d.message}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </article>
        ) : (
          <ArticleBody
            ref={articleRef}
            html={stripLeadingH1(page.article.html)}
            statusMessage={page.statusMessage}
            onClick={interceptArticleLinks}
          />
        )}
        <ArticleBacklinks
          existing={page.backlinks.existing}
          unwritten={page.backlinks.unwritten}
          onNavigate={navigateToArticle}
        />
      </>
    );
  }, [
    route,
    loading,
    error,
    page,
    navigateToArticle,
    navigateToSearch,
    interceptArticleLinks,
    refreshContext,
    refreshBusy,
    refreshMessage,
    loadHistory,
    editOpen,
    editSectionId,
    editBusy,
    editDraft,
    editError,
    editIncludeRecentPrompts,
    rewriteArticle,
    rawEditOpen,
    rawEditMarkdown,
    rawEditPreview,
    rawEditPreviewBusy,
    openRawEdit,
    saveRawEdit,
    previewRawEdit,
    editRefsEnabled,
    editRefs,
    editRefsToggleLocked,
    editIsPartial,
    editInitialRefSlugSet,
    editAddRefsOpen,
    editRefSearchDraft,
    editRefsChanged,
    editBlacklist,
    editBlacklistOpen,
    editBlacklistInput,
    addEditRef,
    removeEditRef,
    blacklistEditRef,
    syncBlacklist,
    togglePinRef,
    historyOpen,
    historyLoading,
    historyLoaded,
    historyError,
    historyEmpty,
    revisions,
    selectedRevision,
    restoreConfirmRevision,
    restoreMessage,
    revertingId,
    revertToRevision,
    copyArticleSlug,
    copySlugMessage,
    editTitleDraft,
    editTitleBusy,
    editTitleError,
    protectionBusy,
    themeSettings,
  ]);

  const activeTheme = resolveThemeMode(themeSettings.mode, systemDark);

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

        <Button
          variant="outline"
          size="icon"
          aria-label={activeTheme === "dark" ? "Use day mode" : "Use night mode"}
          title={activeTheme === "dark" ? "Use day mode" : "Use night mode"}
          onClick={() =>
            setThemeSettings((current) => ({
              ...current,
              mode: activeTheme === "dark" ? "light" : "dark",
            }))
          }
        >
          {activeTheme === "dark" ? (
            <SunIcon />
          ) : (
            <MoonIcon />
          )}
        </Button>

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
            href="/media"
            onClick={(e) => {
              e.preventDefault();
              navigateToMediaList();
            }}
          >
            Media
          </a>
          <a
            href="/Random"
            onClick={(e) => {
              e.preventDefault();
              navigateToRandom();
            }}
          >
            Random
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
          <a
            href="/settings"
            onClick={(e) => {
              e.preventDefault();
              navigateToSettings();
            }}
          >
            Settings
          </a>
          <a
            href="/graph"
            onClick={(e) => {
              e.preventDefault();
              navigateToGraph();
            }}
          >
            Graph
          </a>
        </nav>

        <form
          className="header-search"
          onSubmit={(e) => {
            e.preventDefault();
            const draft = headerSearchDraft.trim();
            if (draft) {
              // The same field/submit doubles as a path/URL pasting shortcut
              // (e.g. "wiki/Archive_scouts", a full URL). Only treat plain
              // text as a literal title to forward — a path reference already
              // names its target via the slug, with nothing to preserve.
              const looksLikePathReference =
                /wiki\//i.test(draft) ||
                /^https?:\/\//i.test(draft) ||
                draft.includes("/");
              navigateToArticle(
                headerSearchDraft,
                looksLikePathReference ? undefined : headerSearchDraft,
              );
              setHeaderSearchDraft("");
            }
          }}
        >
          <ArticleSearchDropdown
            wrapClassName="flex-1"
            query={headerSearchDraft}
            onQueryChange={setHeaderSearchDraft}
            placeholder="Search the register..."
            leading={{
              // The typed text doubles as a literal title to forward, so
              // punctuation a slug can't carry — the colon in "Rat: Eating
              // Test" — shows immediately rather than only after generation.
              label: (
                <>
                  Go to:{" "}
                  <strong className="font-semibold text-accent">
                    {headerSearchDraft.trim()}
                  </strong>
                </>
              ),
              onSelect: () => {
                navigateToArticle(headerSearchDraft, headerSearchDraft);
                setHeaderSearchDraft("");
              },
            }}
            onPick={(s) => {
              // Navigate by title — that builds the canonical /wiki/ URL (same
              // derivation as the search-results page); the slug is a DB key,
              // not a routing key. Pass the title as the literal too.
              navigateToArticle(s.title, s.title);
              setHeaderSearchDraft("");
            }}
          />
          <button type="submit" className="header-search-submit">
            Go
          </button>
        </form>
      </header>

      <section
        className={clsx("layout", {
          "layout--graph": route.kind === "graph",
          "layout--admin":
            route.kind === "admin" || route.kind === "settings",
        })}
      >
        <main className="layout-main">{mainView}</main>
        {route.kind !== "graph" &&
          route.kind !== "admin" &&
          route.kind !== "settings" && (
            <Sidebar
              articleSlug={articleSlug}
              articleTitle={articleTitle}
              showTopArticles={route.kind === "home"}
              infobox={page?.infobox ?? null}
              headlineMedia={page?.headlineMedia ?? null}
              onNavigate={navigateToArticle}
              onNavigateToMedia={navigateToMedia}
              onArticleUpdate={handleLiveArticleUpdate}
            />
            // TODO factor into a new component in a new file w shadcn components
          )}
      </section>

      {linkMenu ? (
        <div
          className="selection-link-menu"
          style={{ left: linkMenu.x, top: linkMenu.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="selection-link-button"
            onClick={addLinkFromSelection}
            disabled={linkMenuBusy}
          >
            {linkMenuBusy ? "Adding..." : "Add a link here"}
          </button>
          <button
            type="button"
            className="selection-link-button"
            onClick={openSelectionEdit}
            disabled={linkMenuBusy}
          >
            Edit selection
          </button>
          <button
            type="button"
            className="selection-link-dismiss"
            onClick={clearLinkSelection}
            disabled={linkMenuBusy}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {linkMenuError ? (
        <div className="selection-link-error">{linkMenuError}</div>
      ) : null}

      <AlertDialog
        open={discardConfirmOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDiscardConfirmOpen(false);
            pendingNavRef.current = null;
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved edits?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes in the editor. Leaving this page will
              discard them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay on page</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const proceed = pendingNavRef.current;
                pendingNavRef.current = null;
                setDiscardConfirmOpen(false);
                proceed?.();
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <footer className="site-footer">
        Local-first fictional canon engine
      </footer>
    </div>
  );
}

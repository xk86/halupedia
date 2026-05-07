import { useCallback, useEffect, useRef, useState } from "react";
import { Comments } from "./Comments";
import { AllEntries } from "./AllEntries";

const RESERVED_ALL_ENTRIES = "all-entries";

type Status = "idle" | "loading" | "streaming" | "done" | "error";

const DREAMING_MESSAGES = [
  "Consulting seventeen conflicting sources…",
  "Cross-referencing the index…",
  "Locating the relevant volume…",
  "Interviewing three anonymous experts…",
  "Resolving a minor scholarly dispute…",
];

function currentSlug(): string {
  const path = window.location.pathname.replace(/^\/+/, "");
  if (!path || path === "") return "hallucinopedia";
  // Strip trailing slash.
  return decodeURIComponent(path.replace(/\/+$/, ""));
}

export function App() {
  const [slug, setSlug] = useState<string>(() => currentSlug());
  const [html, setHtml] = useState<string>("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dreamMsg, setDreamMsg] = useState<string>(DREAMING_MESSAGES[0]);
  const prevSlugRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /* ----- Popstate (back/forward) ----- */
  useEffect(() => {
    const onPop = () => setSlug(currentSlug());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /* ----- Fetch + stream on every slug change ----- */
  useEffect(() => {
    // Reserved client-only routes (e.g. the all-entries index) bypass the
    // article fetch entirely — the SPA renders them itself.
    if (slug === RESERVED_ALL_ENTRIES) {
      abortRef.current?.abort();
      setHtml("");
      setError(null);
      setStatus("done");
      return;
    }

    let cancelled = false;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setHtml("");
    setError(null);
    setStatus("loading");
    setDreamMsg(DREAMING_MESSAGES[Math.floor(Math.random() * DREAMING_MESSAGES.length)]);

    const from = prevSlugRef.current;
    const url = `/api/page/${encodeURIComponent(slug)}${from ? `?from=${encodeURIComponent(from)}` : ""}`;

    (async () => {
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) {
          const j: any = await res.json().catch(() => ({}));
          throw new Error(j?.error || `error ${res.status}`);
        }
        const cachedHeader = res.headers.get("x-hallucinopedia-cached");
        const isCached = cachedHeader === "true";

        if (!res.body) {
          const text = await res.text();
          if (cancelled) return;
          setHtml(text);
          setStatus("done");
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let firstChunk = true;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          if (cancelled) return;
          if (firstChunk) {
            setStatus(isCached ? "done" : "streaming");
            firstChunk = false;
          }
          setHtml(accumulated);
        }
        accumulated += decoder.decode();
        if (cancelled) return;
        setHtml(accumulated);
        setStatus("done");
      } catch (e: any) {
        if (cancelled || e?.name === "AbortError") return;
        setError(e?.message || "generation failed");
        setStatus("error");
      }
    })();

    // Update browser title once we have an h1.
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [slug]);

  /* ----- Update document.title when article arrives ----- */
  useEffect(() => {
    if (!html) return;
    const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (m) {
      const title = m[1].replace(/<[^>]+>/g, "").trim();
      if (title) document.title = `${title} — Hallucinopedia`;
    }
  }, [html]);

  /* ----- Internal link interception ----- */
  const onContainerClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const target = (e.target as HTMLElement).closest("a");
    if (!target) return;
    const href = target.getAttribute("href");
    if (!href || !href.startsWith("/")) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e as any).button === 1) return;
    e.preventDefault();
    navigateTo(href.slice(1));
  }, []);

  const navigateTo = useCallback(
    (nextSlug: string) => {
      const clean = nextSlug.replace(/^\/+|\/+$/g, "") || "hallucinopedia";
      if (clean === slug) return;
      prevSlugRef.current = slug;
      window.history.pushState({}, "", `/${clean}`);
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
      setSlug(clean);
    },
    [slug]
  );

  const onStumble = useCallback(async () => {
    try {
      const res = await fetch("/api/random");
      const j: any = await res.json();
      if (j?.slug) navigateTo(j.slug);
    } catch {}
  }, [navigateTo]);

  return (
    <div className="site">
      <header className="site-header">
        <div className="brand-stack">
          <a
            href="/hallucinopedia"
            className="brand"
            onClick={(e) => {
              e.preventDefault();
              navigateTo("hallucinopedia");
            }}
          >
            Hallucin<span className="amp">&middot;</span>opedia
          </a>
          <a
            href="https://buymeacoffee.com/baderbc"
            target="_blank"
            rel="noopener noreferrer"
            className="brand-donate"
            title="Donations go directly to LLM tokens so the press can keep printing."
          >
            Buy us tokens →
          </a>
        </div>
        <nav className="nav">
          <a
            href="/hallucinopedia"
            onClick={(e) => {
              e.preventDefault();
              navigateTo("hallucinopedia");
            }}
          >
            Index
          </a>
          <a
            href="/all-entries"
            onClick={(e) => {
              e.preventDefault();
              navigateTo("all-entries");
            }}
          >
            All entries
          </a>
          <a
            href="#stumble"
            onClick={(e) => {
              e.preventDefault();
              onStumble();
            }}
          >
            Stumble
          </a>
          <a
            href="https://github.com/BaderBC/halupedia"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
        </nav>
      </header>

      <main
        className={status === "streaming" ? "streaming" : ""}
        onClick={onContainerClick}
      >
        {slug === RESERVED_ALL_ENTRIES ? (
          <AllEntries onNavigate={navigateTo} />
        ) : (
          <>
            {status === "loading" && !html && (
              <div className="status">
                <span className="dot" />
                <span>{dreamMsg}</span>
              </div>
            )}
            {status === "streaming" && (
              <div className="status">
                <span className="dot" />
                <span>Retrieving entry…</span>
              </div>
            )}
            {status === "error" && error && (
              <div className="error">
                Something broke, which is ironic for a made-up encyclopedia: {error}
              </div>
            )}
            <article
              className="article"
              dangerouslySetInnerHTML={{ __html: html }}
            />
            {status === "done" && <Comments slug={slug} />}
          </>
        )}
      </main>

      <footer className="site-footer">
        Comprehensive coverage of topics mainstream encyclopedias overlooked.
      </footer>
    </div>
  );
}

/**
 * Sidebar — the parchment-coloured right rail.
 *
 * Mostly mocked still, but the "Currently Being Consulted" panel and the
 * "fellow readers on this folio" stat are now wired to a live Durable
 * Object via the `usePresence` hook in App.tsx — so those numbers reflect
 * actual concurrent readers, refreshed every ~3 seconds.
 *
 * Sections (top → bottom):
 *   1. The Reader      — identity + karma (mock); + live "fellow readers" line
 *   2. Currently Being Consulted — top-N live, real WS data
 *   3. Cited by        — backlinks for the current article (article view only, mock)
 *   4. Today's Curiosity — one editorially-featured entry (mock)
 *   5. Patronage       — tip jar + Discord (real links)
 */

import { useState } from "react";
import type { PresenceTopItem } from "./usePresence";

/** Solana wallet for direct on-chain patronage. Sits alongside the BMC link
 *  for readers who'd rather skip Stripe's cut and send a few lamports. */
const SOLANA_ADDRESS = "EboTHi6QY9GxfknLj3nBNcZ2cx9nha6XDHhA8NZKUgoc";

interface SidebarProps {
  /** Current article slug. Pass null on non-article views (search, all-entries). */
  slug: string | null;
  onNavigate: (slug: string) => void;
  /** Live top-N readers, fed in by App.tsx's usePresence hook. */
  presenceTop: PresenceTopItem[];
  /** How many readers are currently on the same article as the viewer. */
  presenceHereCount: number | null;
  /** All-time top articles by upvote score. Refreshed on every successful
   *  vote via App's `refreshTopArticles`. */
  topArticles: { slug: string; title: string; score: number }[];
}

/* --- Mock data (still TODO: backend) --------------------------------- */

const MOCK_BACKLINKS: { slug: string; title: string }[] = [
  { slug: "footnote-drift", title: "Footnote Drift" },
  { slug: "the-pellbrick-correspondence", title: "The Pellbrick Correspondence" },
  { slug: "ministry-of-archival-redundancies", title: "Ministry of Archival Redundancies" },
];

const MOCK_FEATURED = {
  slug: "the-national-library-of-unfinished-books",
  title: "The National Library of Unfinished Books",
  blurb:
    "A reading-room in which every volume breaks off mid-sentence; patrons are encouraged to invent the remainder.",
};

/** Mock identity. Real implementation will read from the comments-identity
 *  cookie + a /api/me endpoint. Toggle `LOGGED_IN` to preview the guest state. */
const LOGGED_IN = true;
const MOCK_USER = {
  name: "Bartram Pellbrick-Thwaite",
  username: "pellbrick_archivist",
  karma: 247,
};

/* --- Component -------------------------------------------------------- */

/** Internal slug used by App.tsx for the "/" route. Anything else with a
 *  non-null slug is a real article page. */
const HOMEPAGE_SLUG = "halupedia";

export function Sidebar({
  slug,
  onNavigate,
  presenceTop,
  presenceHereCount,
  topArticles,
}: SidebarProps) {
  // "Cited by" should appear on every real article view that has at least
  // one inbound link — i.e. everywhere except:
  //   - non-article views (search, all-entries) where the parent passes null,
  //   - the homepage at "/" (slug "halupedia"),
  //   - articles with zero backlinks (panel would be empty).
  //
  // PRE-DEPLOY: ReaderCard and BacklinksPanel are temporarily disabled in
  // the render below until the underlying features (real /api/me identity
  // + karma sum, real backlinks query against link_hints) are wired up.
  // The components themselves stay in this file so re-enabling is a
  // one-line change.
  const isArticleView = slug !== null && slug !== HOMEPAGE_SLUG;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _showBacklinks = isArticleView && MOCK_BACKLINKS.length > 0;

  return (
    <aside className="sidebar" aria-label="Reader's column">
      {/* Disabled until /api/me + karma plumbing lands.
          <ReaderCard hereCount={presenceHereCount} isArticleView={isArticleView} /> */}
      <FellowReadersPanel
        hereCount={presenceHereCount}
        isArticleView={isArticleView}
      />
      <TopArticlesPanel
        items={topArticles}
        currentSlug={slug}
        onNavigate={onNavigate}
      />
      <CurrentlyReadPanel
        items={presenceTop}
        currentSlug={slug}
        onNavigate={onNavigate}
      />
      {/* Disabled until link_hints backlinks query is wired up.
          {_showBacklinks && <BacklinksPanel onNavigate={onNavigate} />} */}
      <FeaturedPanel onNavigate={onNavigate} />
      <PatronagePanel />
    </aside>
  );
}

/* --- Fellow readers (standalone, independent of the disabled Reader card) -- */

/**
 * Tiny panel showing "N others consulting this folio at present". Lives at
 * the top of the sidebar so it's the first thing the user notices when
 * they land on a real article.
 *
 * Hidden on:
 *   - non-article views (search, all-entries, homepage) — `isArticleView` is false
 *   - while the WS hasn't echoed back a here count yet (hereCount === null)
 */
function FellowReadersPanel({
  hereCount,
  isArticleView,
}: {
  hereCount: number | null;
  isArticleView: boolean;
}) {
  if (!isArticleView || hereCount == null) return null;
  // Subtract the viewer themselves so we never tell a lone reader they're
  // "1 person reading this".
  const others = Math.max(0, hereCount - 1);
  return (
    <section
      className="sb-panel sb-fellow-panel"
      aria-label="Concurrent readers"
    >
      <FellowReadersLine n={others} />
    </section>
  );
}

/* --- 1. Reader's Card ------------------------------------------------- */

function ReaderCard({
  hereCount,
  isArticleView,
}: {
  hereCount: number | null;
  isArticleView: boolean;
}) {
  // Live "fellow readers" line. Subtract the viewer themselves so the copy
  // never lies about a count of 1 ("you, alone, are reading this folio").
  // Suppress entirely on non-article views and while the count is unknown.
  const others =
    hereCount != null && hereCount > 0 ? Math.max(0, hereCount - 1) : null;
  const showFellowReaders = isArticleView && others != null;

  if (!LOGGED_IN) {
    return (
      <section className="sb-panel sb-reader sb-reader-guest">
        <h3 className="sb-heading">The Reader</h3>
        <p className="sb-reader-intro">
          You are perusing the register anonymously.
        </p>
        <button
          type="button"
          className="sb-cta"
          onClick={() => {
            /* mock — real impl will trigger identity hallucination */
          }}
        >
          Sign the register
        </button>
        <p className="sb-fineprint">
          A name will be drawn for you. No password. No e-mail. No fuss.
        </p>
        {showFellowReaders && <FellowReadersLine n={others!} />}
      </section>
    );
  }

  return (
    <section className="sb-panel sb-reader" aria-label="Your reader card">
      <h3 className="sb-heading">The Reader</h3>
      <a
        href={`/reader/${MOCK_USER.username}`}
        className="sb-reader-name"
        onClick={(e) => {
          e.preventDefault();
          /* mock — future profile page */
        }}
      >
        {MOCK_USER.name}
      </a>
      <div className="sb-reader-handle">@{MOCK_USER.username}</div>
      <dl className="sb-reader-stats">
        <div>
          <dt>Karma</dt>
          <dd>{MOCK_USER.karma.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Standing</dt>
          <dd>Junior Archivist</dd>
        </div>
      </dl>
      {showFellowReaders && <FellowReadersLine n={others!} />}
    </section>
  );
}

function FellowReadersLine({ n }: { n: number }) {
  return (
    <p className="sb-fellow-readers" aria-live="polite">
      <span className="sb-fellow-dot" aria-hidden="true" />
      {n === 0 ? (
        <>You alone are consulting this folio at present.</>
      ) : n === 1 ? (
        <>One other reader consults this folio at present.</>
      ) : (
        <>
          <strong>{n.toLocaleString()}</strong> others consult this folio at
          present.
        </>
      )}
    </p>
  );
}

/* --- 2. Top Folios (all-time, by upvotes) ----------------------------- */

function TopArticlesPanel({
  items,
  currentSlug,
  onNavigate,
}: {
  items: { slug: string; title: string; score: number }[];
  currentSlug: string | null;
  onNavigate: (s: string) => void;
}) {
  // Hide entirely until at least one article has been upvoted. A "Top
  // Folios: nothing yet" panel reads as broken on a fresh deploy.
  if (items.length === 0) return null;

  return (
    <section className="sb-panel" aria-labelledby="sb-top-h">
      <h3 className="sb-heading" id="sb-top-h">
        Top Folios
      </h3>
      <ol className="sb-list sb-list-numbered">
        {items.map((item, i) => {
          const isCurrent = item.slug === currentSlug;
          return (
            <li key={item.slug} className={isCurrent ? "sb-now-current" : ""}>
              <span className="sb-rank">{i + 1}.</span>
              <a
                href={`/${item.slug}`}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate(item.slug);
                }}
              >
                {item.title || item.slug}
              </a>
              <span
                className="sb-score"
                title={`${item.score} endorsement${item.score === 1 ? "" : "s"}`}
              >
                ▲{item.score}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* --- 3. Currently Being Consulted (live) ------------------------------ */

function CurrentlyReadPanel({
  items,
  currentSlug,
  onNavigate,
}: {
  items: PresenceTopItem[];
  currentSlug: string | null;
  onNavigate: (s: string) => void;
}) {
  // Hide the panel entirely while the WS hasn't given us anything yet
  // (first ~3s of the SPA's life, or any extended outage). An empty
  // "currently being consulted: nothing" box is worse than no box.
  if (items.length === 0) return null;

  return (
    <section className="sb-panel" aria-labelledby="sb-now-h">
      <h3 className="sb-heading" id="sb-now-h">
        Currently Being Consulted
      </h3>
      <ol className="sb-list sb-list-numbered">
        {items.map((item, i) => {
          const isCurrent = item.slug === currentSlug;
          return (
            <li key={item.slug} className={isCurrent ? "sb-now-current" : ""}>
              <span className="sb-rank">{i + 1}.</span>
              <a
                href={`/${item.slug}`}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate(item.slug);
                }}
              >
                {item.title || item.slug}
              </a>
              <span
                className="sb-score"
                title={`${item.count} reader${item.count === 1 ? "" : "s"} right now`}
              >
                {item.count}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="sb-fineprint sb-now-fineprint">
        Counts refreshed every few seconds.
      </p>
    </section>
  );
}

/* --- 3. Cited by (article view only, mock) --------------------------- */

function BacklinksPanel({ onNavigate }: { onNavigate: (s: string) => void }) {
  return (
    <section className="sb-panel" aria-labelledby="sb-cited-h">
      <h3 className="sb-heading" id="sb-cited-h">
        Cited by
      </h3>
      <ul className="sb-list sb-list-plain">
        {MOCK_BACKLINKS.map((item) => (
          <li key={item.slug}>
            <a
              href={`/${item.slug}`}
              onClick={(e) => {
                e.preventDefault();
                onNavigate(item.slug);
              }}
            >
              {item.title}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* --- 4. Today's Curiosity (mock) ------------------------------------- */

function FeaturedPanel({ onNavigate }: { onNavigate: (s: string) => void }) {
  return (
    <section className="sb-panel sb-featured" aria-labelledby="sb-featured-h">
      <h3 className="sb-heading" id="sb-featured-h">
        Today&rsquo;s Curiosity
      </h3>
      <a
        href={`/${MOCK_FEATURED.slug}`}
        className="sb-featured-title"
        onClick={(e) => {
          e.preventDefault();
          onNavigate(MOCK_FEATURED.slug);
        }}
      >
        {MOCK_FEATURED.title}
      </a>
      <p className="sb-featured-blurb">{MOCK_FEATURED.blurb}</p>
    </section>
  );
}

/* --- 5. Patronage ---------------------------------------------------- */

function PatronagePanel() {
  return (
    <section className="sb-panel sb-patron" aria-labelledby="sb-patron-h">
      <h3 className="sb-heading" id="sb-patron-h">
        Patronage
      </h3>
      <p className="sb-patron-blurb">
        The press runs on tokens. Patrons keep it printing.
      </p>
      <a
        href="https://buymeacoffee.com/baderbc"
        target="_blank"
        rel="noopener noreferrer"
        className="sb-cta sb-cta-outline"
      >
        Buy us tokens →
      </a>
      <SolanaTipJar />
      <a
        href="https://discord.gg/fKMnyNwtGc"
        target="_blank"
        rel="noopener noreferrer"
        className="sb-discord-link"
      >
        Join Discord
      </a>
    </section>
  );
}

/** Small click-to-copy chip for the project's Solana wallet. Kept inline
 *  in the Patronage panel so it sits right next to the BMC button. */
function SolanaTipJar() {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(SOLANA_ADDRESS);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail on insecure contexts / older browsers.
      // Falling back silently is fine — the address is visible on screen.
    }
  };

  return (
    <div className="sb-solana" aria-label="Solana wallet address">
      <span className="sb-solana-label">or send SOL</span>
      <button
        type="button"
        className="sb-solana-addr"
        onClick={onCopy}
        title="Copy Solana address"
      >
        <code>{SOLANA_ADDRESS}</code>
        <span className="sb-solana-copy" aria-live="polite">
          {copied ? "copied" : "copy"}
        </span>
      </button>
    </div>
  );
}

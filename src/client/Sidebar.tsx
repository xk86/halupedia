import { renderSummaryHtml } from "./summaryHtml";
import { toWikiSegment } from "./wikiPath";

interface BacklinkItem {
  slug: string;
  title: string;
  visibleLabel: string;
  hiddenHint: string;
  summaryMarkdown?: string;
  createdAt: number;
}

interface SidebarProps {
  articleSlug: string | null;
  articleTitle: string;
  backlinks: {
    existing: BacklinkItem[];
    unwritten: BacklinkItem[];
  } | null;
  onNavigate: (slug: string) => void;
}

export function Sidebar({ articleSlug, articleTitle, backlinks, onNavigate }: SidebarProps) {
  const isArticleView = Boolean(articleSlug);
  const hasBacklinks =
    Boolean(backlinks) &&
    ((backlinks?.existing.length ?? 0) > 0 || (backlinks?.unwritten.length ?? 0) > 0);

  if (!isArticleView || !hasBacklinks || !backlinks) {
    return <aside className="sidebar" aria-label="Context" />;
  }

  return (
    <aside className="sidebar" aria-label="Context">
      {backlinks && (
        <section className="sb-panel" aria-labelledby="sb-backlinks-h">
          <h3 className="sb-heading" id="sb-backlinks-h">
            Referenced By
          </h3>

          {backlinks.existing.length === 0 && backlinks.unwritten.length === 0 ? (
            <p className="sb-copy">No incoming references yet.</p>
          ) : (
            <>
              {backlinks.existing.length > 0 && (
                <>
                  <h4 className="sb-subheading">Existing Articles</h4>
                  <ul className="sb-list">
                    {backlinks.existing.map((item) => (
                      <li key={`${item.slug}-${item.createdAt}`}>
                        <a
                          href={`/wiki/${toWikiSegment(item.title)}`}
                          onClick={(e) => {
                            e.preventDefault();
                            onNavigate(toWikiSegment(item.title));
                          }}
                        >
                          {item.title}
                        </a>
                        <div
                          className="sb-hint"
                          dangerouslySetInnerHTML={{ __html: renderSummaryHtml(item.summaryMarkdown || item.hiddenHint) }}
                        />
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {backlinks.unwritten.length > 0 && (
                <>
                  <h4 className="sb-subheading">Unwritten Articles</h4>
                  <ul className="sb-list">
                    {backlinks.unwritten.map((item) => (
                      <li key={`${item.slug}-${item.createdAt}`}>
                        <a
                          href={`/wiki/${toWikiSegment(item.title)}`}
                          onClick={(e) => {
                            e.preventDefault();
                            onNavigate(toWikiSegment(item.title));
                          }}
                        >
                          {item.title}
                        </a>
                        <div
                          className="sb-hint"
                          dangerouslySetInnerHTML={{ __html: renderSummaryHtml(item.hiddenHint) }}
                        />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </section>
      )}
    </aside>
  );
}

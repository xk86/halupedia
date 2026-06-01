import { toWikiSegment } from "./wikiPath";

interface InfoboxRow { label: string; value: string; }
interface InfoboxGroup { label: string; rows: InfoboxRow[]; }
interface InfoboxData {
  title: string;
  subtitle?: string;
  groups: InfoboxGroup[];
}
interface HeadlineMedia { mediaId: string; caption: string; description: string; }

interface SidebarProps {
  articleSlug: string | null;
  articleTitle: string;
  infobox: InfoboxData | null;
  headlineMedia: HeadlineMedia | null;
  onNavigate: (slug: string) => void;
  onNavigateToMedia: (imageSlug: string) => void;
}

export function Sidebar({ articleSlug, infobox, headlineMedia, onNavigateToMedia }: SidebarProps) {
  const hasContent = Boolean(articleSlug) && Boolean(infobox || headlineMedia);

  if (!hasContent) {
    return <aside className="sidebar" aria-label="Context" />;
  }

  const title = infobox?.title ?? "";
  const subtitle = infobox?.subtitle ?? "";
  const groups = infobox?.groups ?? [];
  const caption = headlineMedia?.caption || headlineMedia?.description || "";

  return (
    <aside className="sidebar sidebar--infobox" aria-label="Article info">
      <div className="infobox">
        {title && <div className="infobox-title">{title}</div>}
        {subtitle && <div className="infobox-subtitle">{subtitle}</div>}

        {headlineMedia && (
          <>
            <a
              href={`/media/${encodeURIComponent(headlineMedia.mediaId)}`}
              className="infobox-image-link"
              onClick={(e) => { e.preventDefault(); onNavigateToMedia(headlineMedia.mediaId); }}
            >
              <img
                src={`/api/media/${encodeURIComponent(headlineMedia.mediaId)}`}
                alt={caption}
                className="infobox-image"
              />
            </a>
            {caption && <p className="infobox-caption">{caption}</p>}
          </>
        )}

        {groups.length > 0 && (
          <table className="infobox-table">
            {groups.map((group, gi) => (
              <tbody key={gi}>
                {group.label && (
                  <tr>
                    <th className="infobox-group-header" colSpan={2}>{group.label}</th>
                  </tr>
                )}
                {group.rows.map((row, ri) => (
                  <tr key={ri}>
                    <th className="infobox-label">{row.label}</th>
                    <td className="infobox-value">{row.value}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        )}
      </div>
    </aside>
  );
}

import { useEffect, useRef, useState } from "react";
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

export function Sidebar({ articleSlug, infobox: infoboxProp, headlineMedia: headlineMediaProp, onNavigate, onNavigateToMedia }: SidebarProps) {
  // Live sidecar state — starts from props, updated by the /live stream.
  const [infobox, setInfobox] = useState<InfoboxData | null>(infoboxProp);
  const [headlineMedia, setHeadlineMedia] = useState<HeadlineMedia | null>(headlineMediaProp);
  const liveRef = useRef<AbortController | null>(null);

  // Sync prop changes (navigation) into local state.
  useEffect(() => { setInfobox(infoboxProp); }, [infoboxProp]);
  useEffect(() => { setHeadlineMedia(headlineMediaProp); }, [headlineMediaProp]);

  // Subscribe to live sidecar updates for this article.
  useEffect(() => {
    if (!articleSlug) return;
    liveRef.current?.abort();
    const ac = new AbortController();
    liveRef.current = ac;

    (async () => {
      try {
        const res = await fetch(`/api/article/${encodeURIComponent(articleSlug)}/live`, {
          signal: ac.signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done || ac.signal.aborted) break;
          buf += dec.decode(value, { stream: true });
          let nl = buf.indexOf("\n");
          while (nl >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            nl = buf.indexOf("\n");
            if (!line) continue;
            try {
              const event = JSON.parse(line) as
                | { type: "ready" }
                | { type: "infobox"; infobox: InfoboxData }
                | { type: "caption"; caption: string; mediaId: string }
                | { type: "article" };
              if (event.type === "infobox") {
                setInfobox(event.infobox);
              } else if (event.type === "caption") {
                setHeadlineMedia((prev) =>
                  prev && prev.mediaId === event.mediaId
                    ? { ...prev, caption: event.caption }
                    : prev,
                );
              }
              // "article" updates are handled by App.tsx via pollPostProcess;
              // we don't need to update the article body here.
            } catch {}
          }
        }
      } catch (e: any) {
        if (e?.name === "AbortError") return;
      }
    })();

    return () => { ac.abort(); };
  }, [articleSlug]);

  const hasContent = Boolean(articleSlug) && Boolean(infobox || headlineMedia);
  if (!hasContent) {
    return <aside className="sidebar" aria-label="Context" />;
  }

  const title = infobox?.title ?? "";
  const subtitle = infobox?.subtitle ?? "";
  const groups = infobox?.groups ?? [];
  // Only show the pipeline-generated per-article caption — never the raw description.
  const caption = headlineMedia?.caption ?? "";

  const handleInternalLink = (e: React.MouseEvent<HTMLElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("/wiki/")) {
      e.preventDefault();
      const seg = href.slice("/wiki/".length);
      onNavigate(decodeURIComponent(seg));
    }
  };

  return (
    <aside className="sidebar sidebar--infobox" aria-label="Article info" onClick={handleInternalLink}>
      <div className="infobox">
        {title && <div className="infobox-title">{title}</div>}
        {subtitle && <div className="infobox-subtitle" dangerouslySetInnerHTML={{ __html: subtitle }} />}

        {headlineMedia && (
          <>
            <a
              href={`/media/${encodeURIComponent(headlineMedia.mediaId)}`}
              className="infobox-image-link"
              onClick={(e) => { e.preventDefault(); onNavigateToMedia(headlineMedia.mediaId); }}
            >
              <img
                src={`/api/media/${encodeURIComponent(headlineMedia.mediaId)}`}
                alt={caption || headlineMedia.mediaId}
                className="infobox-image"
              />
            </a>
            {caption && <p className="infobox-caption" dangerouslySetInnerHTML={{ __html: caption }} />}
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
                    <td className="infobox-value" dangerouslySetInnerHTML={{ __html: row.value }} />
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

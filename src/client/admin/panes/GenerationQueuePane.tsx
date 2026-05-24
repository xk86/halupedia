import { Pane } from "../Pane";
import { toWikiSegment } from "../../wikiPath";

interface QueueItem {
  slug: string;
  title: string;
  seq: number;
  startedAt: number;
  waiting: number;
}

interface Props {
  items: QueueItem[];
  onNavigate: (slug: string) => void;
}

export function GenerationQueuePane({ items, onNavigate }: Props) {
  return (
    <Pane id="generation-queue" title="Generation Queue" count={`${items.length} active`}>
      {items.length ? (
        <ul className="admin-queue-list">
          {items.map((item) => (
            <li key={`${item.slug}-${item.seq}`} className="admin-queue-item">
              <a
                href={`/wiki/${toWikiSegment(item.title)}`}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate(toWikiSegment(item.title));
                }}
              >
                {item.title}
              </a>
              <span>{item.waiting} waiting</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sb-copy">No active article generations.</p>
      )}
    </Pane>
  );
}

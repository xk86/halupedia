import { Pane } from "../Pane";
import { toWikiSegment } from "../../wikiPath";

interface LatestArticle {
  slug: string;
  canonicalSlug: string;
  title: string;
  generatedAt: number;
}

interface Props {
  articles: LatestArticle[];
  onNavigate: (slug: string) => void;
}

export function RecentArticlesPane({ articles, onNavigate }: Props) {
  return (
    <Pane id="recent-articles" title="Recent Articles" count={`${articles.length}`}>
      <ul className="search-list">
        {articles.map((item) => (
          <li key={`${item.slug}-${item.generatedAt}`} className="search-item">
            <a
              href={`/wiki/${toWikiSegment(item.title)}`}
              onClick={(e) => {
                e.preventDefault();
                onNavigate(toWikiSegment(item.title));
              }}
            >
              {item.title}
            </a>
          </li>
        ))}
      </ul>
    </Pane>
  );
}

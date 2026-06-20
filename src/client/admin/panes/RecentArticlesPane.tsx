import { memo } from "react";
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

function RecentArticlesPaneComponent({ articles, onNavigate }: Props) {
  return (
    <Pane
      id="recent-articles"
      title="Recent Articles"
      count={`${articles.length}`}
    >
      <ul className="m-0 list-none p-0">
        {articles.map((item) => (
          <li
            key={`${item.slug}-${item.generatedAt}`}
            className="py-[0.35rem] [border-bottom:1px_dotted_var(--rule-soft)] last:border-b-0 [&_a]:border-b-0 [&_a]:text-[1.05rem]"
          >
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

export const RecentArticlesPane = memo(RecentArticlesPaneComponent);

import { useEffect, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface TopArticle {
  slug: string;
  title: string;
  inboundCount: number;
}

interface TopArticlesCardProps {
  onNavigate: (slug: string) => void;
}

const listClasses = "m-0 flex w-full list-none flex-col gap-1 p-0";
const itemClasses = "flex w-full items-baseline gap-2 py-0.5 text-sm";

export function TopArticlesCard({ onNavigate }: TopArticlesCardProps) {
  const [topArticles, setTopArticles] = useState<TopArticle[]>([]);

  useEffect(() => {
    fetch("/api/top-articles?limit=10")
      .then((response) => response.json())
      .then((data) =>
        setTopArticles((data as { articles: TopArticle[] }).articles ?? []),
      )
      .catch(() => {});
  }, []);

  if (topArticles.length === 0) return null;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Top articles</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className={listClasses}>
          {topArticles.map((article, index) => (
            <li key={article.slug} className={itemClasses}>
              <span className="min-w-2 shrink-0 text-right font-mono text-xs text-muted-foreground">
                {index + 1}
              </span>
              <a
                className="min-w-0 flex-1 break-words"
                href={`/wiki/${article.title.replace(/\s+/g, "_")}`}
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate(article.title);
                }}
              >
                {article.title}
              </a>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {article.inboundCount}{" "}
                {article.inboundCount === 1 ? "ref" : "refs"}
              </span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

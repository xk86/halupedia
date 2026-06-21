import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

const proseLayoutClasses = "prose prose-halu max-w-none";

const proseQuoteClasses =
  "[&_blockquote]:rounded-r-md [&_blockquote]:border-l-accent [&_blockquote]:bg-blockquote-bg [&_blockquote]:px-5 [&_blockquote]:py-3";

export const articleProseClasses = cn(proseLayoutClasses, proseQuoteClasses);

interface ArticleProseProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  html: string;
}

export function ArticleProse({ html, className, ...props }: ArticleProseProps) {
  return (
    <div
      className={cn(articleProseClasses, className)}
      dangerouslySetInnerHTML={{ __html: html }}
      {...props}
    />
  );
}

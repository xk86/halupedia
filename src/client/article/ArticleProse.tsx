import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

const proseLayoutClasses = "prose prose-halu max-w-none";

const proseLinkClasses = "[&_a]:border-b-0";

export const articleProseClasses = cn(proseLayoutClasses, proseLinkClasses);

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

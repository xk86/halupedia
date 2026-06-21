import { forwardRef, type MouseEventHandler } from "react";

import { Separator } from "@/components/ui/separator";
import { ArticleProse } from "@/article/ArticleProse";
import { cn } from "@/lib/utils";

const statusLayoutClasses = "flex items-center gap-2 py-2";
const statusTypographyClasses = "font-mono text-sm text-muted-foreground";

interface ArticleBodyProps {
  html: string;
  statusMessage?: string | null;
  onClick: MouseEventHandler<HTMLElement>;
}

export const ArticleBody = forwardRef<HTMLElement, ArticleBodyProps>(
  function ArticleBody({ html, statusMessage, onClick }, ref) {
    return (
      <article ref={ref} className="article" onClick={onClick}>
        <ArticleProse html={html} />
        {statusMessage ? (
          <>
            <Separator className="mt-6" />
            <div className={cn(statusLayoutClasses, statusTypographyClasses)}>
              <span className="size-2 animate-[pulse_1.1s_ease-in-out_infinite] rounded-full bg-primary" />
              <span>{statusMessage}</span>
            </div>
          </>
        ) : null}
      </article>
    );
  },
);

declare module "markdown-it-container" {
  import type MarkdownIt from "markdown-it";
  function markdownItContainer(
    md: MarkdownIt,
    name: string,
    options?: {
      validate?: (params: string) => boolean;
      render?: (tokens: any[], idx: number) => string;
      marker?: string;
    },
  ): void;
  export = markdownItContainer;
}

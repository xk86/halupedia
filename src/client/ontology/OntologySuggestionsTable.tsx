import { GitMergeIcon, ListPlusIcon, XIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

export interface OntologySuggestionView {
  id: number;
  predicate: string;
  label: string;
  object: string;
  objectHtml?: string;
  validated: boolean;
}

interface OntologySuggestionsTableProps {
  suggestions: OntologySuggestionView[];
  busy?: boolean;
  onAppend: (id: number) => void;
  onMerge: (id: number) => void;
  onDismiss: (id: number) => void;
}

function RenderedInlineMarkdown({ html }: { html: string }) {
  return (
    <span
      className="break-words"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function OntologySuggestionsTable({
  suggestions,
  busy = false,
  onAppend,
  onMerge,
  onDismiss,
}: OntologySuggestionsTableProps) {
  return (
    <Table>
      <TableBody>
        {suggestions.map((suggestion) => (
          <TableRow
            key={suggestion.id}
            className="border-b border-panel-border last:border-0 max-[560px]:block"
          >
            <th
              scope="row"
              className="w-[1%] px-3 py-1.5 text-left align-baseline text-xs font-medium whitespace-nowrap text-muted-foreground max-[560px]:block max-[560px]:w-full max-[560px]:pb-0 max-[560px]:whitespace-normal"
            >
              {suggestion.label}
            </th>
            <TableCell className="px-3 py-1.5 align-baseline text-sm whitespace-normal max-[560px]:block max-[560px]:w-full">
              <span className="flex min-w-0 flex-wrap items-baseline gap-2">
                <span className="min-w-0 flex-1 break-words">
                  {suggestion.objectHtml ? (
                    <RenderedInlineMarkdown html={suggestion.objectHtml} />
                  ) : (
                    suggestion.object
                  )}
                </span>
                <Badge
                  variant={suggestion.validated ? "secondary" : "warn"}
                  className="text-[10px]"
                >
                  {suggestion.validated ? "validated" : "raw"}
                </Badge>
                <span className="flex shrink-0 flex-wrap items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Add ${suggestion.label}`}
                    disabled={busy}
                    onClick={() => onAppend(suggestion.id)}
                  >
                    <ListPlusIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Merge ${suggestion.label}`}
                    disabled={busy}
                    onClick={() => onMerge(suggestion.id)}
                  >
                    <GitMergeIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Dismiss ${suggestion.label}`}
                    disabled={busy}
                    onClick={() => onDismiss(suggestion.id)}
                  >
                    <XIcon />
                  </Button>
                </span>
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

import { useCallback, useState } from "react";
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  GitMergeIcon,
  ListPlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";

import { Pane } from "../Pane";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import {
  OntologySuggestionsTable,
  type OntologySuggestionView,
} from "@/ontology/OntologySuggestionsTable";

interface PendingOntologyArticle {
  slug: string;
  title: string;
  suggestionCount: number;
  suggestions: OntologySuggestionView[];
}

interface PendingOntologyPayload {
  articleCount: number;
  suggestionCount: number;
  articles: PendingOntologyArticle[];
}

interface OntologySuggestionsPaneProps {
  onNavigate: (slug: string) => void;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const payload = (await res.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!res.ok) throw new Error(payload.error || `request failed (${res.status})`);
  return payload;
}

function encodeSlug(slug: string): string {
  return encodeURIComponent(slug);
}

function ArticleSuggestionGroup({
  article,
  busy,
  onAppend,
  onMerge,
  onDismiss,
  onNavigate,
}: {
  article: PendingOntologyArticle;
  busy: boolean;
  onAppend: (slug: string, ids?: number[]) => void;
  onMerge: (slug: string, ids?: number[]) => void;
  onDismiss: (slug: string, id?: number) => void;
  onNavigate: (slug: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const ids = article.suggestions.map((suggestion) => suggestion.id);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card
        size="sm"
        data-testid={`ontology-suggestion-article-${article.slug}`}
        className="gap-0 py-0"
      >
        <CardHeader className="grid-cols-[minmax(0,1fr)_auto] py-3">
          <CollapsibleTrigger
            aria-label={`Toggle ${article.title}`}
            className="group/article flex min-w-0 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left"
          >
            <ChevronDownIcon
              data-icon="inline-start"
              className="shrink-0 text-muted-foreground transition-transform group-not-data-[panel-open]/article:-rotate-90"
            />
            <div className="min-w-0">
              <CardTitle>
                <h4 className="font:inherit m-0 truncate">{article.title}</h4>
              </CardTitle>
              <p className="m-0 truncate text-xs text-muted-foreground">
                {article.slug}
              </p>
            </div>
          </CollapsibleTrigger>
          <CardAction className="flex flex-wrap items-center gap-1 max-[680px]:col-start-1 max-[680px]:row-start-2 max-[680px]:justify-self-start">
            <Badge variant="secondary">{article.suggestionCount}</Badge>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Open ${article.title}`}
              onClick={() => onNavigate(article.slug)}
            >
              <ExternalLinkIcon />
            </Button>
            <Button
              size="xs"
              disabled={busy}
              aria-label={`Add all for ${article.title}`}
              onClick={() => onAppend(article.slug, ids)}
            >
              <ListPlusIcon data-icon="inline-start" />
              Add all
            </Button>
            <Button
              variant="secondary"
              size="xs"
              disabled={busy}
              aria-label={`Merge all for ${article.title}`}
              onClick={() => onMerge(article.slug, ids)}
            >
              <GitMergeIcon data-icon="inline-start" />
              Merge all
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Dismiss all for ${article.title}`}
              disabled={busy}
              onClick={() => onDismiss(article.slug)}
            >
              <XIcon />
            </Button>
          </CardAction>
        </CardHeader>
        <CollapsibleContent>
          <Separator />
          <CardContent className="px-0">
            <OntologySuggestionsTable
              suggestions={article.suggestions}
              busy={busy}
              onAppend={(id) => onAppend(article.slug, [id])}
              onMerge={(id) => onMerge(article.slug, [id])}
              onDismiss={(id) => onDismiss(article.slug, id)}
            />
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

export function OntologySuggestionsPane({
  onNavigate,
}: OntologySuggestionsPaneProps) {
  const [data, setData] = useState<PendingOntologyPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [autoMerging, setAutoMerging] = useState(false);
  const [confirmAutoMerge, setConfirmAutoMerge] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(
        await fetchJson<PendingOntologyPayload>(
          "/api/admin/ontology/suggestions",
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "failed to load ontology suggestions",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const applySuggestions = useCallback(
    async (slug: string, mode: "append" | "merge", ids?: number[]) => {
      if (busyKey) return;
      setBusyKey(`${slug}:${mode}:${ids?.join(",") ?? "all"}`);
      setError(null);
      try {
        await fetchJson(`/api/article/${encodeSlug(slug)}/ontology/suggestions/${mode}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ids ? { ids } : {}),
        });
        await load();
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "failed to apply ontology suggestions",
        );
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, load],
  );

  const dismissSuggestions = useCallback(
    async (slug: string, id?: number) => {
      if (busyKey) return;
      setBusyKey(`${slug}:dismiss:${id ?? "all"}`);
      setError(null);
      try {
        const suffix = id ? `/${id}` : "";
        await fetchJson(
          `/api/article/${encodeSlug(slug)}/ontology/suggestions${suffix}`,
          { method: "DELETE" },
        );
        await load();
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "failed to dismiss ontology suggestions",
        );
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, load],
  );

  const autoMergeAll = useCallback(async () => {
    if (!data || autoMerging || busyKey) return;
    setAutoMerging(true);
    setError(null);
    try {
      // Sweep every article sequentially, merging all of its suggestions.
      for (const article of data.articles) {
        await fetchJson(
          `/api/article/${encodeSlug(article.slug)}/ontology/suggestions/merge`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
        );
      }
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "failed to auto-merge ontology suggestions",
      );
    } finally {
      setAutoMerging(false);
    }
  }, [data, autoMerging, busyKey, load]);

  const count = data ? `${data.suggestionCount} pending` : undefined;
  const busy = busyKey !== null || autoMerging;

  return (
    <Pane
      id="ontology-suggestions"
      title="Pending ontology suggestions"
      description="Generated ontology candidates waiting for per-article review."
      count={count}
      actions={
        <>
          {data && data.articles.length > 0 ? (
            <Button
              variant="secondary"
              size="xs"
              disabled={busy}
              onClick={() => setConfirmAutoMerge(true)}
            >
              <GitMergeIcon data-icon="inline-start" />
              Auto merge all
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh ontology suggestions"
            disabled={loading || busy}
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            <RefreshCwIcon />
          </Button>
        </>
      }
      wide
    >
      {error ? <p className="m-0 mb-3 text-sm text-destructive">{error}</p> : null}
      {loading && !data ? (
        <p className="m-0 text-sm text-muted-foreground">
          Loading pending ontology suggestions...
        </p>
      ) : null}
      {!loading && !data ? (
        <Button
          size="sm"
          onClick={() => {
            setLoading(true);
            void load();
          }}
        >
          <RefreshCwIcon data-icon="inline-start" />
          Load pending suggestions
        </Button>
      ) : null}
      {!loading && data && data.articles.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">
          No pending ontology suggestions.
        </p>
      ) : null}
      {data && data.articles.length > 0 ? (
        <div className="flex flex-col gap-3">
          {data.articles.map((article) => (
            <ArticleSuggestionGroup
              key={article.slug}
              article={article}
              busy={busy}
              onAppend={(slug, ids) => applySuggestions(slug, "append", ids)}
              onMerge={(slug, ids) => applySuggestions(slug, "merge", ids)}
              onDismiss={dismissSuggestions}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ) : null}
      <AlertDialog
        open={confirmAutoMerge}
        onOpenChange={(open) => {
          if (!open) setConfirmAutoMerge(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Auto merge all suggestions?</AlertDialogTitle>
            <AlertDialogDescription>
              This will merge every pending suggestion
              {data
                ? ` (${data.suggestionCount} across ${data.articleCount} articles)`
                : ""}{" "}
              into the ontology. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={autoMerging}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={autoMerging}
              onClick={() => {
                setConfirmAutoMerge(false);
                void autoMergeAll();
              }}
            >
              Merge all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Pane>
  );
}

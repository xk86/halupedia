import { useCallback, useEffect, useState } from "react";
import {
  GitMergeIcon,
  ListPlusIcon,
  PencilIcon,
  TagIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import {
  ArticleSearchDropdown,
  type Suggestion,
} from "@/ArticleSearchDropdown";
import { OntologySuggestionsTable } from "@/ontology/OntologySuggestionsTable";
import { entryTitlePresentation } from "../entryTitle";

interface OntologyFact {
  id: number;
  predicate: string;
  label: string;
  object: string;
  objectHtml?: string;
  objectSlug: string | null;
  source: string;
  confidence: number;
}

interface OntologyPayload {
  entityType: string | null;
  facts: OntologyFact[];
  identifiers: Array<{ scheme: string; value: string }>;
  categories: string[];
  suggestions: OntologySuggestion[];
}

interface Predicate {
  name: string;
  label: string;
  subject: string;
  object: string;
}

interface ArticleOntologyProps {
  slug: string;
  onNavigate: (titleSegment: string, explicitTitle?: string) => void;
}

interface EditDraft {
  predicate: string;
  objectSlug: string;
  objectName: string;
  literal: string;
  query: string;
}

const emptyDraft: EditDraft = {
  predicate: "",
  objectSlug: "",
  objectName: "",
  literal: "",
  query: "",
};

const sourceBadgeVariant: Record<string, "outline" | "secondary" | "default"> =
  {
    extracted: "outline",
    infobox: "outline",
    inferred: "secondary",
    curated: "default",
  };

interface OntologySuggestion {
  id: number;
  predicate: string;
  label: string;
  object: string;
  objectHtml?: string;
  validated: boolean;
}

function RenderedInlineMarkdown({ html }: { html: string }) {
  return (
    <span
      className="break-words"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function normalizePredicateKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeOntologyPayload(
  payload: Partial<OntologyPayload> | null,
): OntologyPayload | null {
  if (!payload) return null;
  return {
    entityType: payload.entityType ?? null,
    facts: Array.isArray(payload.facts) ? payload.facts : [],
    identifiers: Array.isArray(payload.identifiers) ? payload.identifiers : [],
    categories: Array.isArray(payload.categories) ? payload.categories : [],
    suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : [],
  };
}

export function ArticleOntology({ slug, onNavigate }: ArticleOntologyProps) {
  const [data, setData] = useState<OntologyPayload | null>(null);
  const [predicates, setPredicates] = useState<Predicate[]>([]);
  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  const [entityTypeDraft, setEntityTypeDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [editingFactId, setEditingFactId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft>(emptyDraft);
  const [draft, setDraft] = useState(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inferring, setInferring] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setEditing(false);
    setEditingFactId(null);
    setDraft(emptyDraft);
    setEditDraft(emptyDraft);
    setEntityTypeDraft("");
    setError(null);
    setInferring(false);
    fetch(`/api/article/${encodeURIComponent(slug)}/ontology`)
      .then((r) => (r.ok ? r.json() : null))
      .then((payload: Partial<OntologyPayload> | null) => {
        if (cancelled) return;
        setData(normalizeOntologyPayload(payload));
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (!editing || (predicates.length > 0 && entityTypes.length > 0)) return;
    fetch("/api/ontology/vocabulary")
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { predicates?: Predicate[]; entityTypes?: string[] } | null) => {
        if (v?.predicates) setPredicates(v.predicates);
        if (v?.entityTypes) setEntityTypes(v.entityTypes);
      })
      .catch(() => undefined);
  }, [editing, predicates.length, entityTypes.length]);

  const apiBase = `/api/article/${encodeURIComponent(slug)}/ontology`;
  const predicateKey = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      const match = predicates.find(
        (p) => p.name === trimmed || p.label === trimmed,
      );
      return match ? match.name : normalizePredicateKey(trimmed);
    },
    [predicates],
  );

  const addFact = useCallback(async () => {
    const predicate = predicateKey(draft.predicate);
    if (!predicate || busy) return;
    const objectSlug = draft.objectSlug.trim();
    const objectLiteral = draft.literal.trim();
    if (!objectSlug && !objectLiteral) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/facts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          objectSlug
            ? { predicate, objectSlug }
            : { predicate, objectLiteral },
        ),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not add fact");
        return;
      }
      setData(
        normalizeOntologyPayload(
          (await res.json()) as Partial<OntologyPayload>,
        ),
      );
      setDraft(emptyDraft);
    } finally {
      setBusy(false);
    }
  }, [draft, busy, apiBase, predicateKey]);

  const removeFact = useCallback(
    async (id: number) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${apiBase}/facts/${id}`, { method: "DELETE" });
        if (res.ok) {
          setData(
            normalizeOntologyPayload(
              (await res.json()) as Partial<OntologyPayload>,
            ),
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, apiBase],
  );

  const saveFact = useCallback(
    async (id: number) => {
      if (busy) return;
      const objectSlug = editDraft.objectSlug.trim();
      const objectLiteral = editDraft.literal.trim();
      const predicate = predicateKey(editDraft.predicate);
      if (!predicate || (!objectSlug && !objectLiteral)) return;
      setBusy(true);
      setError(null);
      try {
        const body: Record<string, string> = { predicate };
        if (objectSlug) body.objectSlug = objectSlug;
        else body.objectLiteral = objectLiteral;
        const res = await fetch(`${apiBase}/facts/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          setError(b.error ?? "Could not update fact");
          return;
        }
        setData(
          normalizeOntologyPayload(
            (await res.json()) as Partial<OntologyPayload>,
          ),
        );
        setEditingFactId(null);
        setEditDraft(emptyDraft);
      } finally {
        setBusy(false);
      }
    },
    [busy, editDraft, apiBase, predicateKey],
  );

  const saveEntityType = useCallback(async () => {
    const entityType = entityTypeDraft.trim();
    if (!entityType || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/entity`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityType }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? "Could not update type");
        return;
      }
      const next = normalizeOntologyPayload(
        (await res.json()) as Partial<OntologyPayload>,
      );
      setData(next);
      setEntityTypeDraft(next?.entityType ?? "");
    } finally {
      setBusy(false);
    }
  }, [apiBase, busy, entityTypeDraft]);

  const startEdit = (fact: OntologyFact) => {
    setEditingFactId(fact.id);
    setEditDraft({
      predicate: fact.predicate,
      objectSlug: fact.objectSlug ?? "",
      objectName: fact.objectSlug ? fact.object : "",
      literal: fact.objectSlug ? "" : fact.object,
      query: fact.objectSlug ? fact.object : "",
    });
  };

  const inferFacts = useCallback(async () => {
    if (inferring) return;
    setInferring(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/infer`, { method: "POST" });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? "Inference failed");
        return;
      }
      const refreshed = await fetch(apiBase);
      if (!refreshed.ok) {
        setError("Suggestions finished, but the ontology could not be reloaded");
        return;
      }
      setData(
        normalizeOntologyPayload(
          (await refreshed.json()) as Partial<OntologyPayload>,
        ),
      );
    } catch {
      setError("Inference request failed");
    } finally {
      setInferring(false);
    }
  }, [inferring, apiBase]);

  const applySuggestions = useCallback(
    async (mode: "append" | "merge", ids?: number[]) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${apiBase}/suggestions/${mode}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ids ? { ids } : {}),
        });
        if (res.ok) {
          setData(
            normalizeOntologyPayload(
              (await res.json()) as Partial<OntologyPayload>,
            ),
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, apiBase],
  );

  const dismissSuggestions = useCallback(
    async (id?: number) => {
      if (busy) return;
      setBusy(true);
      try {
        const url = id
          ? `${apiBase}/suggestions/${id}`
          : `${apiBase}/suggestions`;
        const res = await fetch(url, { method: "DELETE" });
        if (res.ok) {
          setData(
            normalizeOntologyPayload(
              (await res.json()) as Partial<OntologyPayload>,
            ),
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, apiBase],
  );

  if (!data) return null;
  const facts = data.facts.filter((f) => f.predicate !== "is_a");
  if (facts.length === 0 && !editing && !data.entityType) return null;

  const renderObject = (fact: OntologyFact) => {
    if (!fact.objectSlug) {
      return fact.objectHtml ? (
        <RenderedInlineMarkdown html={fact.objectHtml} />
      ) : (
        <span className="break-words">{fact.object}</span>
      );
    }
    const title = entryTitlePresentation(fact.object);
    return (
      <a
        href={title.wikiPath}
        className="break-words text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:decoration-accent/80"
        onClick={(event) => {
          event.preventDefault();
          onNavigate(title.wikiSegment, title.plainTitle);
        }}
        dangerouslySetInnerHTML={{ __html: title.html }}
      />
    );
  };

  const renderEditRow = (fact: OntologyFact) => (
    <TableRow
      key={fact.id}
      className="border-b border-panel-border bg-muted/30 last:border-0 max-[560px]:block"
    >
      <th
        scope="row"
        className="w-[1%] px-3 py-1.5 align-top text-xs font-medium whitespace-nowrap text-muted-foreground max-[560px]:block max-[560px]:w-full max-[560px]:pb-0 max-[560px]:whitespace-normal"
      >
        <Input
          list="ontology-predicates"
          value={
            predicates.find((p) => p.name === editDraft.predicate)?.label ??
            editDraft.predicate
          }
          onChange={(e) => {
            const match = predicates.find((p) => p.label === e.target.value);
            setEditDraft((d) => ({
              ...d,
              predicate: match ? match.name : e.target.value,
            }));
          }}
          placeholder="Relationship…"
          className="h-7 w-36 text-xs"
        />
      </th>
      <TableCell className="px-3 py-1.5 align-top text-sm max-[560px]:block max-[560px]:w-full">
        <div className="flex flex-col gap-1.5">
          <ArticleSearchDropdown
            query={editDraft.objectName || editDraft.query}
            onQueryChange={(q) =>
              setEditDraft((d) => ({
                ...d,
                query: q,
                objectSlug: "",
                objectName: "",
              }))
            }
            onPick={(s: Suggestion) =>
              setEditDraft((d) => ({
                ...d,
                objectSlug: s.slug,
                objectName: s.title,
                query: s.title,
                literal: "",
              }))
            }
            placeholder="Link an article…"
            wrapClassName="w-full"
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">or</span>
            <Input
              value={editDraft.literal}
              disabled={!!editDraft.objectSlug}
              onChange={(e) =>
                setEditDraft((d) => ({ ...d, literal: e.target.value }))
              }
              placeholder="plain value"
              className="h-7 flex-1 text-xs"
            />
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              disabled={
                busy ||
                !editDraft.predicate ||
                (!editDraft.objectSlug && !editDraft.literal.trim())
              }
              onClick={() => saveFact(fact.id)}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setEditingFactId(null);
                setEditDraft(emptyDraft);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      </TableCell>
    </TableRow>
  );

  return (
    <Card
      size="sm"
      className="article prose-halu mt-8 w-full max-w-full gap-0 rounded-sm py-0"
      aria-label="Ontology facts"
    >
      <CardHeader className="gap-2 rounded-none border-b border-panel-border bg-accent-wash-strong px-3 py-1.5 max-[560px]:grid-cols-1">
        <CardTitle className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Facts
          {data.entityType ? (
            <Badge variant="outline" className="ml-2 font-normal normal-case">
              {data.entityType}
            </Badge>
          ) : null}
        </CardTitle>
        <CardAction className="max-[560px]:col-start-1 max-[560px]:row-start-2 max-[560px]:justify-self-start">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setEditing((v) => {
                const next = !v;
                if (next) setEntityTypeDraft(data.entityType ?? "");
                return next;
              });
              setEditingFactId(null);
            }}
          >
            {editing ? "Done" : "Edit"}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="px-0 max-[680px]:max-h-[70dvh] max-[680px]:overflow-y-auto">
        <Table>
          <TableBody>
            {facts.map((fact) =>
              editingFactId === fact.id ? (
                renderEditRow(fact)
              ) : (
                <TableRow
                  key={fact.id}
                  className="border-b border-panel-border last:border-0 max-[560px]:block"
                >
                  <th
                    scope="row"
                    className="w-[1%] px-3 py-1.5 text-left align-baseline text-xs font-medium whitespace-nowrap text-muted-foreground max-[560px]:block max-[560px]:w-full max-[560px]:pb-0 max-[560px]:whitespace-normal"
                  >
                    {fact.label}
                  </th>
                  <TableCell className="px-3 py-1.5 align-baseline text-sm whitespace-normal max-[560px]:block max-[560px]:w-full">
                    <span className="flex min-w-0 flex-wrap items-baseline gap-2">
                      <span className="min-w-0 flex-1 break-words">
                        {renderObject(fact)}
                      </span>
                      {editing ? (
                        <span className="flex shrink-0 flex-wrap items-center gap-1">
                          <Badge
                            variant={
                              sourceBadgeVariant[fact.source] ?? "outline"
                            }
                            className="text-[10px]"
                          >
                            {fact.source}
                            {fact.source === "inferred" && fact.confidence < 1
                              ? ` ${Math.round(fact.confidence * 100)}%`
                              : null}
                          </Badge>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Edit fact"
                            disabled={busy}
                            onClick={() => startEdit(fact)}
                          >
                            <PencilIcon />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Remove fact"
                            disabled={busy}
                            onClick={() => removeFact(fact.id)}
                          >
                            <Trash2Icon />
                          </Button>
                        </span>
                      ) : null}
                    </span>
                  </TableCell>
                </TableRow>
              ),
            )}
          </TableBody>
        </Table>

        {editing ? (
          <div className="border-t border-panel-border px-3 py-3">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  thing type
                </span>
                <Input
                  list="ontology-entity-types"
                  value={entityTypeDraft}
                  onChange={(event) => setEntityTypeDraft(event.target.value)}
                  placeholder="person"
                  className="h-8 w-40 max-w-full"
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    busy ||
                    !entityTypeDraft.trim() ||
                    entityTypeDraft.trim() === (data.entityType ?? "")
                  }
                  onClick={saveEntityType}
                >
                  <TagIcon data-icon="inline-start" />
                  Set type
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  list="ontology-predicates"
                  value={
                    predicates.find((p) => p.name === draft.predicate)?.label ??
                    draft.predicate
                  }
                  onChange={(e) => {
                    const match = predicates.find(
                      (p) => p.label === e.target.value,
                    );
                    setDraft((d) => ({
                      ...d,
                      predicate: match ? match.name : e.target.value,
                    }));
                  }}
                  placeholder="Relationship…"
                  className="h-8 w-48 max-w-full"
                />

                <ArticleSearchDropdown
                  query={draft.objectName || draft.query}
                  onQueryChange={(query) =>
                    setDraft((d) => ({
                      ...d,
                      query,
                      objectSlug: "",
                      objectName: "",
                    }))
                  }
                  onPick={(s: Suggestion) =>
                    setDraft((d) => ({
                      ...d,
                      objectSlug: s.slug,
                      objectName: s.title,
                      query: s.title,
                      literal: "",
                    }))
                  }
                  placeholder="Link an article…"
                  wrapClassName="min-w-52 flex-1"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  or a plain value
                </span>
                <Input
                  value={draft.literal}
                  disabled={!!draft.objectSlug}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, literal: e.target.value }))
                  }
                  placeholder="e.g. 1998"
                  className="h-8 w-40 max-w-full"
                />
                <Button
                  size="sm"
                  disabled={
                    busy ||
                    !draft.predicate ||
                    (!draft.objectSlug && !draft.literal.trim())
                  }
                  onClick={addFact}
                >
                  Add fact
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={inferring || busy}
                  onClick={inferFacts}
                >
                  {inferring ? "Suggesting…" : "Suggest facts"}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {data.suggestions.length} pending
                </span>
              </div>
              {error ? (
                <span className="text-xs text-destructive">{error}</span>
              ) : null}
            </div>
          </div>
        ) : null}

        {data.suggestions.length > 0 ? (
          <Card size="sm" className="m-2 gap-0 py-0">
            <CardHeader className="gap-2 max-[560px]:grid-cols-1">
              <CardTitle>Ontology suggestions</CardTitle>
              <CardAction className="flex flex-wrap items-center gap-1 max-[560px]:col-start-1 max-[560px]:row-start-2 max-[560px]:justify-self-start">
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() => applySuggestions("append")}
                >
                  <ListPlusIcon data-icon="inline-start" />
                  Add all
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  disabled={busy}
                  onClick={() => applySuggestions("merge")}
                >
                  <GitMergeIcon data-icon="inline-start" />
                  Merge all
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Dismiss all suggestions"
                  disabled={busy}
                  onClick={() => dismissSuggestions()}
                >
                  <XIcon />
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="px-0">
              <OntologySuggestionsTable
                suggestions={data.suggestions}
                busy={busy}
                onAppend={(id) => applySuggestions("append", [id])}
                onMerge={(id) => applySuggestions("merge", [id])}
                onDismiss={(id) => dismissSuggestions(id)}
              />
            </CardContent>
          </Card>
        ) : null}
      </CardContent>
      {editing ? (
        <>
          <datalist id="ontology-predicates">
            {predicates.map((p) => (
              <option key={p.name} value={p.label} />
            ))}
          </datalist>
          <datalist id="ontology-entity-types">
            {entityTypes.map((type) => (
              <option key={type} value={type} />
            ))}
          </datalist>
        </>
      ) : null}
    </Card>
  );
}

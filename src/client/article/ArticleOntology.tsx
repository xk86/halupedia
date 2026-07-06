import { useCallback, useEffect, useState } from "react";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { ArticleSearchDropdown, type Suggestion } from "@/ArticleSearchDropdown";
import { entryTitlePresentation } from "../entryTitle";

interface OntologyFact {
  id: number;
  predicate: string;
  label: string;
  object: string;
  objectSlug: string | null;
  source: string;
  confidence: number;
}

interface OntologyPayload {
  entityType: string | null;
  facts: OntologyFact[];
  identifiers: Array<{ scheme: string; value: string }>;
  categories: string[];
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

const emptyDraft: EditDraft = { predicate: "", objectSlug: "", objectName: "", literal: "", query: "" };

const sourceBadgeVariant: Record<string, "outline" | "secondary" | "default"> = {
  extracted: "outline",
  infobox: "outline",
  inferred: "secondary",
  curated: "default",
};

export function ArticleOntology({ slug, onNavigate }: ArticleOntologyProps) {
  const [data, setData] = useState<OntologyPayload | null>(null);
  const [predicates, setPredicates] = useState<Predicate[]>([]);
  const [editing, setEditing] = useState(false);
  const [editingFactId, setEditingFactId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft>(emptyDraft);
  const [draft, setDraft] = useState(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setEditing(false);
    setEditingFactId(null);
    setDraft(emptyDraft);
    setEditDraft(emptyDraft);
    setError(null);
    fetch(`/api/article/${encodeURIComponent(slug)}/ontology`)
      .then((r) => (r.ok ? r.json() : null))
      .then((payload: Partial<OntologyPayload> | null) => {
        if (cancelled) return;
        setData(
          payload
            ? {
                entityType: payload.entityType ?? null,
                facts: Array.isArray(payload.facts) ? payload.facts : [],
                identifiers: Array.isArray(payload.identifiers) ? payload.identifiers : [],
                categories: Array.isArray(payload.categories) ? payload.categories : [],
              }
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (!editing || predicates.length > 0) return;
    fetch("/api/ontology/vocabulary")
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { predicates: Predicate[] } | null) => {
        if (v?.predicates) setPredicates(v.predicates);
      })
      .catch(() => undefined);
  }, [editing, predicates.length]);

  const apiBase = `/api/article/${encodeURIComponent(slug)}/ontology`;

  const addFact = useCallback(async () => {
    if (!draft.predicate || busy) return;
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
          objectSlug ? { predicate: draft.predicate, objectSlug } : { predicate: draft.predicate, objectLiteral },
        ),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not add fact");
        return;
      }
      setData((await res.json()) as OntologyPayload);
      setDraft(emptyDraft);
    } finally {
      setBusy(false);
    }
  }, [draft, busy, apiBase]);

  const removeFact = useCallback(
    async (id: number) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${apiBase}/facts/${id}`, { method: "DELETE" });
        if (res.ok) setData((await res.json()) as OntologyPayload);
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
      if (!editDraft.predicate || (!objectSlug && !objectLiteral)) return;
      setBusy(true);
      setError(null);
      try {
        const body: Record<string, string> = { predicate: editDraft.predicate };
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
        setData((await res.json()) as OntologyPayload);
        setEditingFactId(null);
        setEditDraft(emptyDraft);
      } finally {
        setBusy(false);
      }
    },
    [busy, editDraft, apiBase],
  );

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

  if (!data) return null;
  const facts = data.facts.filter((f) => f.predicate !== "is_a");
  if (facts.length === 0 && !editing && !data.entityType) return null;

  const renderObject = (fact: OntologyFact) => {
    if (!fact.objectSlug) return <span>{fact.object}</span>;
    const title = entryTitlePresentation(fact.object);
    return (
      <a
        href={title.wikiPath}
        className="text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:decoration-accent/80"
        onClick={(event) => {
          event.preventDefault();
          onNavigate(title.wikiSegment, title.plainTitle);
        }}
        dangerouslySetInnerHTML={{ __html: title.html }}
      />
    );
  };

  const renderEditRow = (fact: OntologyFact) => (
    <TableRow key={fact.id} className="border-b border-panel-border bg-muted/30 last:border-0">
      <th scope="row" className="w-[1%] px-3 py-1.5 align-top text-xs font-medium whitespace-nowrap text-muted-foreground">
        <Select
          value={editDraft.predicate}
          onValueChange={(v) => setEditDraft((d) => ({ ...d, predicate: v ?? "" }))}
        >
          <SelectTrigger size="sm" className="w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {predicates.map((p) => (
              <SelectItem key={p.name} value={p.name}>{p.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </th>
      <TableCell className="px-3 py-1.5 align-top text-sm">
        <div className="flex flex-col gap-1.5">
          <ArticleSearchDropdown
            query={editDraft.objectName || editDraft.query}
            onQueryChange={(q) => setEditDraft((d) => ({ ...d, query: q, objectSlug: "", objectName: "" }))}
            onPick={(s: Suggestion) =>
              setEditDraft((d) => ({ ...d, objectSlug: s.slug, objectName: s.title, query: s.title, literal: "" }))
            }
            placeholder="Link an article…"
            wrapClassName="w-full"
          />
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">or</span>
            <Input
              value={editDraft.literal}
              disabled={!!editDraft.objectSlug}
              onChange={(e) => setEditDraft((d) => ({ ...d, literal: e.target.value }))}
              placeholder="plain value"
              className="h-7 flex-1 text-xs"
            />
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              disabled={busy || !editDraft.predicate || (!editDraft.objectSlug && !editDraft.literal.trim())}
              onClick={() => saveFact(fact.id)}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => { setEditingFactId(null); setEditDraft(emptyDraft); }}
            >
              Cancel
            </Button>
          </div>
        </div>
      </TableCell>
    </TableRow>
  );

  return (
    <Card size="sm" className="mt-8 max-w-[87dvw] gap-0 rounded-sm py-0" aria-label="Ontology facts">
      <CardHeader className="gap-0 rounded-none border-b border-panel-border bg-accent-wash-strong px-3 py-1.5">
        <CardTitle className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Facts
          {data.entityType ? (
            <Badge variant="outline" className="ml-2 font-normal normal-case">
              {data.entityType}
            </Badge>
          ) : null}
        </CardTitle>
        <CardAction>
          <Button variant="ghost" size="xs" onClick={() => { setEditing((v) => !v); setEditingFactId(null); }}>
            {editing ? "Done" : "Edit"}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="px-0">
        <Table containerClassName="overflow-x-visible">
          <TableBody>
            {facts.map((fact) =>
              editingFactId === fact.id ? renderEditRow(fact) : (
                <TableRow key={fact.id} className="border-b border-panel-border last:border-0">
                  <th
                    scope="row"
                    className="w-[1%] px-3 py-1.5 text-left align-baseline text-xs font-medium whitespace-nowrap text-muted-foreground"
                  >
                    {fact.label}
                  </th>
                  <TableCell className="px-3 py-1.5 align-baseline text-sm whitespace-normal">
                    <span className="flex items-baseline gap-2">
                      <span className="flex-1">{renderObject(fact)}</span>
                      {editing ? (
                        <span className="flex shrink-0 items-center gap-1">
                          <Badge
                            variant={sourceBadgeVariant[fact.source] ?? "outline"}
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
                            ✎
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Remove fact"
                            disabled={busy}
                            onClick={() => removeFact(fact.id)}
                          >
                            ×
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
                <Select
                  value={draft.predicate}
                  onValueChange={(predicate) => setDraft((d) => ({ ...d, predicate: predicate ?? "" }))}
                >
                  <SelectTrigger size="sm" className="w-48">
                    <SelectValue placeholder="Relationship…" />
                  </SelectTrigger>
                  <SelectContent>
                    {predicates.map((p) => (
                      <SelectItem key={p.name} value={p.name}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <ArticleSearchDropdown
                  query={draft.objectName || draft.query}
                  onQueryChange={(query) =>
                    setDraft((d) => ({ ...d, query, objectSlug: "", objectName: "" }))
                  }
                  onPick={(s: Suggestion) =>
                    setDraft((d) => ({ ...d, objectSlug: s.slug, objectName: s.title, query: s.title, literal: "" }))
                  }
                  placeholder="Link an article…"
                  wrapClassName="min-w-52 flex-1"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">or a plain value</span>
                <Input
                  value={draft.literal}
                  disabled={!!draft.objectSlug}
                  onChange={(e) => setDraft((d) => ({ ...d, literal: e.target.value }))}
                  placeholder="e.g. 1998"
                  className="h-8 w-40"
                />
                <Button
                  size="sm"
                  disabled={busy || !draft.predicate || (!draft.objectSlug && !draft.literal.trim())}
                  onClick={addFact}
                >
                  Add fact
                </Button>
              </div>
              {error ? <span className="text-xs text-destructive">{error}</span> : null}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

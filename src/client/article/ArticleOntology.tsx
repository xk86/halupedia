import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ArticleSearchDropdown, type Suggestion } from "@/ArticleSearchDropdown";
import { entryTitlePresentation } from "../entryTitle";

interface OntologyFact {
  id: number;
  predicate: string;
  label: string;
  object: string;
  objectSlug: string | null;
  source: string;
  editable: boolean;
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

const headingClasses =
  "mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase";

/** Empty draft for the "add a fact" form. */
const emptyDraft = { predicate: "", objectSlug: "", objectName: "", literal: "", query: "" };

/**
 * The typed-ontology facts panel shown at the foot of an article. It lists the
 * article entity's relations (linking objects that are themselves articles) and,
 * behind an edit toggle, lets a curator add hand-authored facts or remove ones
 * they added. The server brings the article up to the live vocabulary lazily,
 * so simply viewing this panel re-extracts an article that no longer fits the
 * current ontology.
 */
export function ArticleOntology({ slug, onNavigate }: ArticleOntologyProps) {
  const [data, setData] = useState<OntologyPayload | null>(null);
  const [predicates, setPredicates] = useState<Predicate[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setEditing(false);
    setDraft(emptyDraft);
    setError(null);
    fetch(`/api/article/${encodeURIComponent(slug)}/ontology`)
      .then((r) => (r.ok ? r.json() : null))
      .then((payload: OntologyPayload | null) => {
        if (!cancelled) setData(payload);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Load the predicate vocabulary lazily, the first time the user edits.
  useEffect(() => {
    if (!editing || predicates.length > 0) return;
    fetch("/api/ontology/vocabulary")
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { predicates: Predicate[] } | null) => {
        if (v?.predicates) setPredicates(v.predicates);
      })
      .catch(() => undefined);
  }, [editing, predicates.length]);

  const addFact = useCallback(async () => {
    if (!draft.predicate || busy) return;
    const objectSlug = draft.objectSlug.trim();
    const objectLiteral = draft.literal.trim();
    if (!objectSlug && !objectLiteral) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/article/${encodeURIComponent(slug)}/ontology/facts`, {
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
  }, [draft, busy, slug]);

  const removeFact = useCallback(
    async (id: number) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/article/${encodeURIComponent(slug)}/ontology/facts/${id}`,
          { method: "DELETE" },
        );
        if (res.ok) setData((await res.json()) as OntologyPayload);
      } finally {
        setBusy(false);
      }
    },
    [busy, slug],
  );

  if (!data) return null;
  // `is_a` is conveyed by the type chip; don't repeat it as a row.
  const facts = data.facts.filter((f) => f.predicate !== "is_a");
  if (facts.length === 0 && !editing && !data.entityType) return null;

  const renderObject = (fact: OntologyFact) => {
    if (!fact.objectSlug) return <span>{fact.object}</span>;
    const title = entryTitlePresentation(fact.object);
    return (
      <a
        href={title.wikiPath}
        onClick={(event) => {
          event.preventDefault();
          onNavigate(title.wikiSegment, title.plainTitle);
        }}
        dangerouslySetInnerHTML={{ __html: title.html }}
      />
    );
  };

  return (
    <section className="mt-8 max-w-[87dvw]" aria-label="Ontology facts">
      <Separator className="mb-3" />
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className={headingClasses + " mb-0"}>
          Facts
          {data.entityType ? (
            <span className="ml-2 font-normal normal-case">({data.entityType})</span>
          ) : null}
        </h4>
        <Button variant="ghost" size="xs" onClick={() => setEditing((v) => !v)}>
          {editing ? "Done" : "Edit"}
        </Button>
      </div>

      <ul className="m-0 flex list-none flex-col gap-y-1 p-0">
        {facts.map((fact) => (
          <li key={fact.id} className="flex items-baseline gap-2 text-sm">
            <span className="text-muted-foreground">{fact.label}</span>
            <span className="flex-1">{renderObject(fact)}</span>
            {editing && fact.editable ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Remove fact"
                disabled={busy}
                onClick={() => removeFact(fact.id)}
              >
                ×
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      {editing ? (
        <div className="mt-3 flex flex-col gap-2 rounded-sm border border-panel-border p-3">
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
      ) : null}
    </section>
  );
}

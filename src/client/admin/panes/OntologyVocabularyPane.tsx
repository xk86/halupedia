import { useCallback, useState } from "react";
import { RefreshCwIcon, SparklesIcon } from "lucide-react";
import { Pane } from "../Pane";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface PredicateUsage {
  name: string;
  label: string;
  arity: "unary" | "binary";
  subject: string;
  object: string;
  symmetric: boolean;
  transitive: boolean;
  inverse?: string;
  usageCount: number;
}

interface UnmappedLabelUsage {
  label: string;
  count: number;
  example: string;
}

interface VocabularyStats {
  predicates: PredicateUsage[];
  unmappedLabels: UnmappedLabelUsage[];
}

interface PredicateAdditionProposal {
  name: string;
  arity: "unary" | "binary";
  subject: string;
  object: string;
  label: string;
  symmetric: boolean;
  transitive: boolean;
  inverse?: string;
  labelMappings: string[];
  reason: string;
}

interface PredicateRemovalProposal {
  name: string;
  reason: string;
}

interface VocabularyReviewProposals {
  additions: PredicateAdditionProposal[];
  removals: PredicateRemovalProposal[];
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const payload = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(payload.error || `request failed (${res.status})`);
  return payload;
}

/**
 * Admin tool for growing/pruning the ontology predicate vocabulary itself (as
 * opposed to a single article's facts — see the article-page facts editor).
 * Shows current predicate usage and infobox labels that never mapped to a
 * predicate (the concrete evidence for a gap), then an LLM pass proposes
 * concrete additions/removals from that evidence. Nothing is written to
 * config/ontology.toml until the operator selects proposals and applies them;
 * applying hot-reloads the running vocabulary (no restart) and existing
 * articles pick up the change lazily on next view/reference.
 */
export function OntologyVocabularyPane() {
  const [stats, setStats] = useState<VocabularyStats | null>(null);
  const [proposals, setProposals] = useState<VocabularyReviewProposals | null>(null);
  const [selectedAdditions, setSelectedAdditions] = useState<Set<number>>(new Set());
  const [selectedRemovals, setSelectedRemovals] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStats = useCallback(() => {
    setStatsLoading(true);
    setError(null);
    fetchJson<VocabularyStats>("/api/admin/ontology/stats")
      .then(setStats)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "failed to load stats"))
      .finally(() => setStatsLoading(false));
  }, []);

  const runReview = useCallback(async () => {
    setReviewing(true);
    setError(null);
    try {
      const result = await fetchJson<{ stats: VocabularyStats; proposals: VocabularyReviewProposals }>(
        "/api/admin/ontology/review",
        { method: "POST" },
      );
      setStats(result.stats);
      setProposals(result.proposals);
      // Additions default-checked (safer to add than to remove); removals
      // default-unchecked so a destructive change is always an explicit opt-in.
      setSelectedAdditions(new Set(result.proposals.additions.map((_, i) => i)));
      setSelectedRemovals(new Set());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "vocabulary review failed");
    } finally {
      setReviewing(false);
    }
  }, []);

  const applySelected = useCallback(async () => {
    if (!proposals) return;
    const additions = proposals.additions.filter((_, i) => selectedAdditions.has(i));
    const removals = proposals.removals.filter((r) => selectedRemovals.has(r.name)).map((r) => r.name);
    if (additions.length === 0 && removals.length === 0) return;
    setApplying(true);
    setError(null);
    try {
      const nextStats = await fetchJson<VocabularyStats>("/api/admin/ontology/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ additions, removals }),
      });
      setStats(nextStats);
      setProposals(null);
      setSelectedAdditions(new Set());
      setSelectedRemovals(new Set());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to apply changes");
    } finally {
      setApplying(false);
    }
  }, [proposals, selectedAdditions, selectedRemovals]);

  const toggleAddition = (i: number) =>
    setSelectedAdditions((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const toggleRemoval = (name: string) =>
    setSelectedRemovals((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const selectedCount = selectedAdditions.size + selectedRemovals.size;

  return (
    <Pane
      id="ontology-vocabulary"
      title="Ontology vocabulary review"
      description="Reevaluate the predicate vocabulary against the corpus — add what's missing, retire what's dead — instead of hand-editing ontology.toml from scratch."
      count={stats ? `${stats.predicates.length} predicates` : undefined}
      wide
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={loadStats} disabled={statsLoading}>
          <RefreshCwIcon data-icon="inline-start" />
          {statsLoading ? "Loading…" : stats ? "Refresh stats" : "Load stats"}
        </Button>
        <Button size="sm" onClick={runReview} disabled={reviewing}>
          <SparklesIcon data-icon="inline-start" />
          {reviewing ? "Reviewing…" : "Run LLM vocabulary review"}
        </Button>
        {proposals ? (
          <Button size="sm" variant="secondary" onClick={applySelected} disabled={applying || selectedCount === 0}>
            {applying ? "Applying…" : `Apply selected (${selectedCount})`}
          </Button>
        ) : null}
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>

      {proposals ? (
        <div className="mb-4 grid items-start gap-3 lg:grid-cols-2">
          <section>
            <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Proposed additions ({proposals.additions.length})
            </h4>
            {proposals.additions.length ? (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {proposals.additions.map((a, i) => (
                  <li key={a.name} className="flex items-start gap-2 rounded-sm border border-panel-border p-2 text-sm">
                    <Checkbox
                      checked={selectedAdditions.has(i)}
                      onCheckedChange={() => toggleAddition(i)}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono font-medium">{a.name}</span>
                        <Badge variant="outline">{a.arity}</Badge>
                        <Badge variant="secondary">
                          {a.subject} → {a.object}
                        </Badge>
                        {a.symmetric ? <Badge variant="outline">symmetric</Badge> : null}
                        {a.inverse ? <Badge variant="outline">inverse: {a.inverse}</Badge> : null}
                      </div>
                      <p className="m-0 mt-1 text-muted-foreground">{a.reason}</p>
                      {a.labelMappings.length ? (
                        <p className="m-0 mt-1 font-mono text-xs text-muted-foreground">
                          absorbs: {a.labelMappings.join(", ")}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-sm text-muted-foreground">No additions proposed.</p>
            )}
          </section>

          <section>
            <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Proposed removals ({proposals.removals.length})
            </h4>
            {proposals.removals.length ? (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {proposals.removals.map((r) => (
                  <li key={r.name} className="flex items-start gap-2 rounded-sm border border-panel-border p-2 text-sm">
                    <Checkbox
                      checked={selectedRemovals.has(r.name)}
                      onCheckedChange={() => toggleRemoval(r.name)}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <span className="font-mono font-medium">{r.name}</span>
                      <p className="m-0 mt-1 text-muted-foreground">{r.reason}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-sm text-muted-foreground">No removals proposed.</p>
            )}
          </section>
        </div>
      ) : null}

      {!stats && !statsLoading ? (
        <p className="m-0 text-sm text-muted-foreground">
          Load stats to see current predicate usage and unmapped labels.
        </p>
      ) : null}

      {stats ? (
        <div className="grid items-start gap-3 lg:grid-cols-2">
          <section>
            <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Predicates ({stats.predicates.length})
            </h4>
            <Table
              containerClassName="max-h-96 rounded-md border border-border"
              className="text-xs [&_td]:py-1 [&_th]:h-7"
            >
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Subject → Object</TableHead>
                  <TableHead className="text-right">Usage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.predicates
                  .slice()
                  .sort((a, b) => b.usageCount - a.usageCount)
                  .map((p) => (
                    <TableRow key={p.name}>
                      <TableCell className="font-mono">{p.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {p.subject} → {p.object}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {p.usageCount === 0 ? <Badge variant="warn">0</Badge> : p.usageCount}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </section>

          <section>
            <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Unmapped infobox labels ({stats.unmappedLabels.length})
            </h4>
            {stats.unmappedLabels.length ? (
              <Table
                containerClassName="max-h-96 rounded-md border border-border"
                className="text-xs [&_td]:py-1 [&_th]:h-7"
              >
                <TableHeader>
                  <TableRow>
                    <TableHead>Label</TableHead>
                    <TableHead className="text-right">Count</TableHead>
                    <TableHead>Example</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.unmappedLabels.map((l) => (
                    <TableRow key={l.label}>
                      <TableCell className="font-mono">{l.label}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{l.count}</TableCell>
                      <TableCell className="truncate text-muted-foreground">{l.example}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="m-0 text-sm text-muted-foreground">
                Every infobox label currently maps to a predicate.
              </p>
            )}
          </section>
        </div>
      ) : null}
    </Pane>
  );
}

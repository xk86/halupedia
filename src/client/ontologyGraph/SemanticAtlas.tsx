import { useEffect, useMemo, useState } from "react";
import { NetworkIcon, RouteIcon, ShapesIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { projectSemanticGraph, layoutSemanticNodes, type SemanticGraphFilters } from "./model";
import type {
  OntologyGraphNode,
  OntologyGraphPayload,
  OntologyGraphRelation,
  SemanticLens,
  SemanticMetric,
} from "./types";

const METRICS: { value: SemanticMetric; label: string }[] = [
  { value: "pagerank", label: "PageRank" },
  { value: "betweenness", label: "Betweenness" },
  { value: "closeness", label: "Closeness" },
  { value: "eigenvector", label: "Eigenvector" },
  { value: "degree", label: "Degree" },
  { value: "inDegree", label: "In-degree" },
  { value: "outDegree", label: "Out-degree" },
  { value: "hitsAuthority", label: "HITS authority" },
  { value: "hitsHub", label: "HITS hub" },
  { value: "eccentricity", label: "Eccentricity" },
  { value: "factCount", label: "Fact count" },
  { value: "literalFactCount", label: "Literal facts" },
];

const SOURCE_LABELS: Record<string, string> = {
  all: "All sources",
  curated: "Curated",
  infobox: "Infobox",
  extracted: "Extracted",
  inferred: "Inferred",
};

const TYPE_COLORS = [
  "var(--primary)",
  "var(--accent)",
  "var(--foreground)",
  "var(--muted-foreground)",
  "var(--control-border-strong)",
  "var(--warning-border)",
  "var(--destructive)",
];

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatMetric(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toPrecision(3).replace(/\.?0+$/, "");
}

function nodeColor(node: OntologyGraphNode, typeIndex: Map<string, number>): string {
  return TYPE_COLORS[(typeIndex.get(node.entityType) ?? 0) % TYPE_COLORS.length];
}

function factTone(relation: OntologyGraphRelation): "default" | "secondary" | "outline" | "warn" {
  if (relation.sourceKind === "curated") return "default";
  if (relation.sourceKind === "inferred") return "outline";
  if (relation.confidence < 0.75) return "warn";
  return "secondary";
}

function SemanticGraphCanvas({
  nodes,
  relations,
  metric,
  maxMetric,
  selectedNodeId,
  selectedRelationId,
  onSelectNode,
  onSelectRelation,
}: {
  nodes: OntologyGraphNode[];
  relations: OntologyGraphRelation[];
  metric: SemanticMetric;
  maxMetric: number;
  selectedNodeId: string | null;
  selectedRelationId: string | null;
  onSelectNode: (node: OntologyGraphNode) => void;
  onSelectRelation: (relation: OntologyGraphRelation) => void;
}) {
  const positioned = useMemo(() => layoutSemanticNodes(nodes, metric, maxMetric), [nodes, metric, maxMetric]);
  const nodeById = new Map(positioned.map((node) => [node.id, node]));
  const typeIndex = new Map([...new Set(nodes.map((node) => node.entityType))].sort().map((type, index) => [type, index]));

  if (nodes.length === 0) {
    return (
      <Card className="min-h-[32rem]">
        <CardHeader>
          <CardTitle>No ontology graph nodes</CardTitle>
          <CardDescription>Relax filters or index ontology facts for articles.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="min-h-[32rem]">
      <CardContent className="p-0">
        <svg viewBox="0 0 960 560" role="img" aria-label="Ontology semantic graph" className="h-[32rem] w-full">
          <rect width="960" height="560" fill="var(--background)" />
          {relations.map((relation) => {
            const source = nodeById.get(relation.source);
            const target = relation.target ? nodeById.get(relation.target) : null;
            if (!source || !target) return null;
            const selected = relation.id === selectedRelationId;
            return (
              <g key={relation.id}>
                <line
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke={selected ? "var(--primary)" : "var(--border)"}
                  strokeWidth={selected ? 2.2 : 1}
                  strokeDasharray={relation.sourceKind === "inferred" ? "6 5" : undefined}
                  opacity={selected ? 0.95 : Math.max(0.18, relation.confidence)}
                  onClick={() => onSelectRelation(relation)}
                />
                <circle
                  cx={(source.x + target.x) / 2}
                  cy={(source.y + target.y) / 2}
                  r={selected ? 4 : 2}
                  fill={selected ? "var(--primary)" : "var(--muted-foreground)"}
                  onClick={() => onSelectRelation(relation)}
                />
              </g>
            );
          })}
          {positioned.map((node) => {
            const selected = node.id === selectedNodeId;
            return (
              <g key={node.id} onClick={() => onSelectNode(node)} className="cursor-pointer">
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={node.radius + (selected ? 5 : 0)}
                  fill={selected ? "var(--ring)" : "var(--background)"}
                  opacity={selected ? 0.55 : 0.2}
                />
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={node.radius}
                  fill={nodeColor(node, typeIndex)}
                  opacity={node.articleSlug ? 0.92 : 0.55}
                />
                <text
                  x={node.x}
                  y={node.y + node.radius + 14}
                  textAnchor="middle"
                  fill="var(--foreground)"
                  fontSize="11"
                >
                  {node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label}
                </text>
              </g>
            );
          })}
        </svg>
      </CardContent>
    </Card>
  );
}

function NodeInspector({
  node,
  relations,
  onNavigate,
}: {
  node: OntologyGraphNode | null;
  relations: OntologyGraphRelation[];
  onNavigate: (slug: string) => void;
}) {
  if (!node) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Inspector</CardTitle>
          <CardDescription>Select a node or relation.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const facts = relations.filter((relation) => relation.source === node.id || relation.target === node.id).slice(0, 12);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="truncate">{node.label}</CardTitle>
        <CardDescription>{node.entityType}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Badge variant={node.articleSlug ? "default" : "outline"}>{node.articleSlug ? "article entity" : "orphan entity"}</Badge>
          <Badge variant="secondary">community {node.community}</Badge>
          <Badge variant="secondary">component {node.componentId}</Badge>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <span className="text-muted-foreground">PageRank</span>
          <span>{formatMetric(node.metrics.pagerank)}</span>
          <span className="text-muted-foreground">Degree</span>
          <span>{formatMetric(node.metrics.degree)}</span>
          <span className="text-muted-foreground">Facts</span>
          <span>{formatCount(node.metrics.factCount)}</span>
          <span className="text-muted-foreground">Literal facts</span>
          <span>{formatCount(node.metrics.literalFactCount)}</span>
        </div>
        {node.articleSlug && (
          <Button size="sm" variant="outline" onClick={() => onNavigate(node.articleSlug!)}>
            Open article
          </Button>
        )}
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium">Nearby facts</div>
          {facts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No visible facts for this node.</p>
          ) : (
            facts.map((fact) => (
              <div key={fact.id} className="rounded-md border border-border p-2 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant={factTone(fact)}>{fact.predicate}</Badge>
                  <span className="text-muted-foreground">{SOURCE_LABELS[fact.sourceKind] ?? fact.sourceKind}</span>
                </div>
                {fact.targetLiteral && <div className="mt-1 truncate">{fact.targetLiteral}</div>}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function SemanticAtlas({ onNavigate }: { onNavigate: (slug: string) => void }) {
  const [payload, setPayload] = useState<OntologyGraphPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null);
  const [filters, setFilters] = useState<SemanticGraphFilters>({
    lens: "relations",
    query: "",
    predicate: "all",
    entityType: "all",
    sourceKind: "all",
    metric: "pagerank",
    limit: 80,
    showLiteralFacts: true,
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/ontology/graph")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<OntologyGraphPayload>;
      })
      .then((next) => {
        if (!cancelled) setPayload(next);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "failed to load ontology graph");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const projection = useMemo(
    () => (payload ? projectSemanticGraph(payload, filters) : null),
    [payload, filters],
  );
  const selectedNode = projection?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedRelation = projection?.relations.find((relation) => relation.id === selectedRelationId) ?? null;

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Ontology graph failed</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (!payload || !projection) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Loading Semantic Atlas…</CardTitle>
          <CardDescription>Building corpus ontology projection.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const predicateItems = [{ label: "All predicates", value: "all" }].concat(
    payload.predicates.map((predicate) => ({ label: `${predicate.name} (${predicate.relationCount})`, value: predicate.name })),
  );
  const typeItems = [{ label: "All types", value: "all" }].concat(
    payload.entityTypes.map((type) => ({ label: `${type.type} (${type.entityCount})`, value: type.type })),
  );
  const metricItems = METRICS.map((metric) => ({ label: metric.label, value: metric.value }));
  const sourceItems = Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label }));

  return (
    <div className="flex flex-col gap-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle>Semantic Atlas</CardTitle>
          <CardDescription>
            Ontology-first graph view. Map/reduce stages prepare facts, summaries, metrics, communities, components, and render projection.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup value={[filters.lens]} onValueChange={(value) => value[0] && setFilters((current) => ({ ...current, lens: value[0] as SemanticLens }))} spacing={1}>
              <ToggleGroupItem value="relations">
                <RouteIcon data-icon="inline-start" />
                Relations
              </ToggleGroupItem>
              <ToggleGroupItem value="types">
                <ShapesIcon data-icon="inline-start" />
                Types
              </ToggleGroupItem>
              <ToggleGroupItem value="coverage">
                <NetworkIcon data-icon="inline-start" />
                Coverage
              </ToggleGroupItem>
            </ToggleGroup>
            <Input
              className="max-w-[18rem]"
              value={filters.query}
              onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
              placeholder="Filter entities…"
              aria-label="Filter ontology entities"
            />
            <Select value={filters.predicate} onValueChange={(value) => value && setFilters((current) => ({ ...current, predicate: value }))} items={predicateItems}>
              <SelectTrigger size="sm" aria-label="Predicate filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {predicateItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select value={filters.entityType} onValueChange={(value) => value && setFilters((current) => ({ ...current, entityType: value }))} items={typeItems}>
              <SelectTrigger size="sm" aria-label="Entity type filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {typeItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select value={filters.sourceKind} onValueChange={(value) => value && setFilters((current) => ({ ...current, sourceKind: value }))} items={sourceItems}>
              <SelectTrigger size="sm" aria-label="Source filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {sourceItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select value={filters.metric} onValueChange={(value) => value && setFilters((current) => ({ ...current, metric: value as SemanticMetric }))} items={metricItems}>
              <SelectTrigger size="sm" aria-label="Metric">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {metricItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant={filters.showLiteralFacts ? "default" : "outline"}
              onClick={() => setFilters((current) => ({ ...current, showLiteralFacts: !current.showLiteralFacts }))}
            >
              Literal facts
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">{formatCount(projection.nodes.length)} visible entities</Badge>
            <Badge variant="secondary">{formatCount(projection.relations.length)} visible edges</Badge>
            <Badge variant="secondary">{formatCount(projection.literalRelations.length)} literal facts</Badge>
            <Badge variant="outline">{formatCount(payload.analysis.componentCount)} components</Badge>
            <Badge variant="outline">{formatCount(payload.analysis.communityCount)} communities</Badge>
            <Badge variant="outline">density {payload.analysis.density.toExponential(2)}</Badge>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-[minmax(0,1fr)_22rem] gap-4">
        <div className="flex flex-col gap-4">
          <SemanticGraphCanvas
            nodes={projection.nodes}
            relations={projection.relations}
            metric={filters.metric}
            maxMetric={projection.maxMetric}
            selectedNodeId={selectedNodeId}
            selectedRelationId={selectedRelationId}
            onSelectNode={(node) => {
              setSelectedNodeId(node.id);
              setSelectedRelationId(null);
            }}
            onSelectRelation={(relation) => {
              setSelectedRelationId(relation.id);
              setSelectedNodeId(null);
            }}
          />
          <div className="grid grid-cols-3 gap-4">
            <Card size="sm">
              <CardHeader>
                <CardTitle>Coverage</CardTitle>
                <CardDescription>{formatCount(payload.coverage.articleEntityCount)} / {formatCount(payload.coverage.articleCount)} articles mapped</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-1 text-sm">
                <span>{formatCount(payload.coverage.articlesWithoutEntityCount)} articles without entities</span>
                <span>{formatCount(payload.coverage.isolatedEntityCount)} isolated entities</span>
                <span>{formatCount(payload.coverage.staleArticleCount)} stale ontology states</span>
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardTitle>Facts</CardTitle>
                <CardDescription>{formatCount(payload.coverage.relationCount)} total relations</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-1 text-sm">
                <span>{formatCount(payload.coverage.entityEdgeCount)} entity edges</span>
                <span>{formatCount(payload.coverage.literalFactCount)} literal facts</span>
                <span>{formatCount(payload.coverage.inferredRelationCount)} inferred facts</span>
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardTitle>Analysis</CardTitle>
                <CardDescription>{payload.analysis.metrics.length} metrics</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1">
                {payload.analysis.stages.slice(0, 6).map((stage) => (
                  <Badge key={stage} variant="outline">{stage}</Badge>
                ))}
              </CardContent>
            </Card>
          </div>
          {filters.lens !== "coverage" && (
            <Card>
              <CardHeader>
                <CardTitle>{filters.lens === "types" ? "Entity types" : "Predicates"}</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Count</TableHead>
                      <TableHead>Incoming</TableHead>
                      <TableHead>Outgoing / edges</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(filters.lens === "types" ? payload.entityTypes.slice(0, 10) : payload.predicates.slice(0, 10)).map((row) => (
                      <TableRow key={"type" in row ? row.type : row.name}>
                        <TableCell>{"type" in row ? row.type : row.name}</TableCell>
                        <TableCell>{formatCount("type" in row ? row.entityCount : row.relationCount)}</TableCell>
                        <TableCell>{formatCount("type" in row ? row.incomingCount : row.literalCount)}</TableCell>
                        <TableCell>{formatCount("type" in row ? row.outgoingCount : row.entityEdgeCount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
        <div className="flex flex-col gap-4">
          <NodeInspector node={selectedNode} relations={projection.relations.concat(projection.literalRelations)} onNavigate={onNavigate} />
          {selectedRelation && (
            <Card>
              <CardHeader>
                <CardTitle>{selectedRelation.predicate}</CardTitle>
                <CardDescription>{selectedRelation.predicateLabel}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                <Badge variant={factTone(selectedRelation)}>{SOURCE_LABELS[selectedRelation.sourceKind] ?? selectedRelation.sourceKind}</Badge>
                <span>confidence {formatMetric(selectedRelation.confidence)}</span>
                {selectedRelation.provenanceSlug && <Button size="sm" variant="outline" onClick={() => onNavigate(selectedRelation.provenanceSlug!)}>Open provenance</Button>}
                {selectedRelation.inferredFrom && <p className="text-muted-foreground">{selectedRelation.inferredFrom}</p>}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

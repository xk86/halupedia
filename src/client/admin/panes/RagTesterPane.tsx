import { useState, type FormEvent } from "react";
import { SearchIcon } from "lucide-react";
import { MarkdownEditor } from "../../MarkdownEditor";
import { Pane } from "../Pane";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type RetrievalProfile =
  | "article_generation"
  | "article_rewrite"
  | "article_refresh"
  | "reference_search";

interface RetrievedDocument {
  documentId: string;
  articleSlug: string;
  sourceKind: string;
  sourceId: string;
  content: string;
  sectionPath?: string[];
  metadata?: Record<string, unknown>;
  rawScore: number;
  fusedRank: number;
  retrievalReason: string;
  provenance: string;
}

interface RagQueryResult {
  request: {
    query: string;
    profile: RetrievalProfile;
    targetSlug: string;
    directSlugs: string[];
    minScore: number;
  };
  retrieval: {
    textDocuments: RetrievedDocument[];
    imageDocuments: unknown[];
    sourceArticles: Array<{
      slug: string;
      title: string;
      score: number;
      contributingKinds: string[];
      provenance: string;
    }>;
    relatedTitles: string[];
    diagnostics: {
      profile: string;
      queryText?: string;
      textEmbeddingModel?: string;
      servingHost?: string;
      vectorDimensions?: number;
      candidateTextCount: number;
      candidateImageCount: number;
      selectedTextCount: number;
      selectedImageCount: number;
      selectedKinds: string[];
      exclusions: Array<{ documentId: string; reason: string }>;
      degraded?: string;
    };
  };
  evidence: {
    articleContext: string;
    infoboxContext: string;
    ontologyFacts: string;
    relatedTitles: string;
    linkAllowlist: Array<{ slug: string; title: string }>;
    decisions: Array<{
      documentId: string;
      kind: string;
      included: boolean;
      reason: string;
    }>;
    tokensUsed: number;
    tokenBudget: number;
  };
}

const PROFILE_LABELS: Record<RetrievalProfile, string> = {
  article_generation: "Article generation",
  article_rewrite: "Article rewrite",
  article_refresh: "Article refresh",
  reference_search: "Reference search",
};

function formatScore(score: number): string {
  return Number.isFinite(score) ? score.toFixed(4) : String(score);
}

export function RagTesterPane() {
  const [query, setQuery] = useState("");
  const [profile, setProfile] =
    useState<RetrievalProfile>("article_generation");
  const [targetSlug, setTargetSlug] = useState("");
  const [result, setResult] = useState<RagQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  async function runQuery(event: FormEvent) {
    event.preventDefault();
    if (!query.trim() || searching) return;
    setSearching(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/rag/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, profile, targetSlug }),
      });
      const payload = (await response.json()) as RagQueryResult & {
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || `error ${response.status}`);
      setResult(payload);
    } catch (cause) {
      setResult(null);
      setError(cause instanceof Error ? cause.message : "RAG query failed");
    } finally {
      setSearching(false);
    }
  }

  return (
    <Pane
      id="rag-tester"
      title="New RAG pipeline tester"
      description="Run read-only LanceDB retrieval and inspect every selection and evidence decision."
      count={result ? `${result.retrieval.textDocuments.length} documents` : undefined}
      wide
    >
      <form onSubmit={runQuery}>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel>Retrieval query</FieldLabel>
            <FieldDescription>
              Markdown links using ref: or halu: are also tested through the
              direct-reference path.
            </FieldDescription>
            <MarkdownEditor
              value={query}
              onChange={setQuery}
              disabled={searching}
              placeholder="Describe the material to retrieve…"
              minRows={5}
            />
          </Field>

          <div className="grid gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="rag-profile">Retrieval profile</FieldLabel>
              <Select
                value={profile}
                onValueChange={(value) => setProfile(value as RetrievalProfile)}
                disabled={searching}
              >
                <SelectTrigger id="rag-profile" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(Object.keys(PROFILE_LABELS) as RetrievalProfile[]).map(
                      (value) => (
                        <SelectItem key={value} value={value}>
                          {PROFILE_LABELS[value]}
                        </SelectItem>
                      ),
                    )}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Controls document kinds, top-K limits, ontology quota, and token
                budget.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="rag-target">Target article slug</FieldLabel>
              <Input
                id="rag-target"
                value={targetSlug}
                onChange={(event) => setTargetSlug(event.target.value)}
                disabled={searching}
                placeholder="Optional; enables category-symbolic lookup"
              />
              <FieldDescription>
                The target is excluded from results. Its categories seed the
                symbolic retrieval path.
              </FieldDescription>
            </Field>
          </div>

          {error ? <FieldError>{error}</FieldError> : null}

          <div>
            <Button type="submit" disabled={!query.trim() || searching}>
              <SearchIcon data-icon="inline-start" />
              {searching ? "Running new RAG pipeline…" : "Run retrieval"}
            </Button>
          </div>
        </FieldGroup>
      </form>

      {result ? <RagResults result={result} /> : null}
    </Pane>
  );
}

function RagResults({ result }: { result: RagQueryResult }) {
  const { request, retrieval, evidence } = result;
  const diagnostics = retrieval.diagnostics;
  return (
    <div className="mt-6 flex flex-col gap-5">
      <Separator />

      <section aria-labelledby="rag-diagnostics-title">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h4 id="rag-diagnostics-title" className="m-0 text-sm font-semibold">
            Retrieval diagnostics
          </h4>
          <Badge variant="secondary">{request.profile}</Badge>
          <Badge variant="outline">min score {request.minScore}</Badge>
          {diagnostics.degraded ? (
            <Badge variant="warn">degraded</Badge>
          ) : (
            <Badge variant="secondary">vector search</Badge>
          )}
        </div>
        <Table className="text-xs [&_td]:py-1.5 [&_th]:h-8">
          <TableHeader>
            <TableRow>
              <TableHead>Target</TableHead>
              <TableHead>Embedding</TableHead>
              <TableHead>Candidates</TableHead>
              <TableHead>Selected</TableHead>
              <TableHead>Direct refs</TableHead>
              <TableHead>Kinds</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="font-mono">{request.targetSlug}</TableCell>
              <TableCell className="font-mono">
                {diagnostics.textEmbeddingModel ?? "unknown"}
                {diagnostics.servingHost ? ` @ ${diagnostics.servingHost}` : ""}
                {diagnostics.vectorDimensions
                  ? ` (${diagnostics.vectorDimensions}d)`
                  : ""}
              </TableCell>
              <TableCell>{diagnostics.candidateTextCount}</TableCell>
              <TableCell>{diagnostics.selectedTextCount}</TableCell>
              <TableCell className="font-mono">
                {request.directSlugs.join(", ") || "none"}
              </TableCell>
              <TableCell>{diagnostics.selectedKinds.join(", ") || "none"}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
        {diagnostics.degraded ? (
          <p className="mt-2 mb-0 font-mono text-xs text-destructive">
            {diagnostics.degraded}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="rag-articles-title">
        <h4 id="rag-articles-title" className="mb-3 text-sm font-semibold">
          Article candidates ({retrieval.sourceArticles.length})
        </h4>
        {retrieval.sourceArticles.length ? (
          <Table className="text-xs [&_td]:py-1.5 [&_th]:h-8">
            <TableHeader>
              <TableRow>
                <TableHead>Article</TableHead>
                <TableHead>Provenance</TableHead>
                <TableHead>Best score</TableHead>
                <TableHead>Contributing kinds</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {retrieval.sourceArticles.map((article) => (
                <TableRow key={article.slug}>
                  <TableCell>
                    <a className="font-medium text-primary hover:underline" href={`/wiki/${article.slug}`}>
                      {article.title}
                    </a>
                    <span className="ml-2 font-mono text-muted-foreground">
                      {article.slug}
                    </span>
                  </TableCell>
                  <TableCell>{article.provenance}</TableCell>
                  <TableCell className="font-mono tabular-nums">
                    {formatScore(article.score)}
                  </TableCell>
                  <TableCell>{article.contributingKinds.join(", ")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="m-0 text-sm text-muted-foreground">No article candidates.</p>
        )}
      </section>

      <section aria-labelledby="rag-documents-title">
        <h4 id="rag-documents-title" className="mb-3 text-sm font-semibold">
          Selected documents ({retrieval.textDocuments.length})
        </h4>
        <div className="grid gap-3 lg:grid-cols-2">
          {retrieval.textDocuments.map((document) => (
            <DocumentCard key={document.documentId} document={document} />
          ))}
        </div>
        {!retrieval.textDocuments.length ? (
          <p className="m-0 text-sm text-muted-foreground">No documents selected.</p>
        ) : null}
      </section>

      <section aria-labelledby="rag-assembly-title">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h4 id="rag-assembly-title" className="m-0 text-sm font-semibold">
            Prompt evidence assembly
          </h4>
          <Badge variant="outline">
            {evidence.tokensUsed} / {evidence.tokenBudget || "unlimited"} tokens
          </Badge>
          <Badge variant="secondary">
            {evidence.decisions.filter((decision) => decision.included).length} included
          </Badge>
        </div>
        <Table className="mb-3 text-xs [&_td]:py-1.5 [&_th]:h-8">
          <TableHeader>
            <TableRow>
              <TableHead>Document</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Decision</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {evidence.decisions.map((decision) => (
              <TableRow key={decision.documentId}>
                <TableCell className="font-mono">{decision.documentId}</TableCell>
                <TableCell>{decision.kind}</TableCell>
                <TableCell>
                  <Badge variant={decision.included ? "secondary" : "outline"}>
                    {decision.included ? "included" : "excluded"}
                  </Badge>
                </TableCell>
                <TableCell>{decision.reason}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="grid gap-3 lg:grid-cols-3">
          <EvidenceCard title="Article context" content={evidence.articleContext} />
          <EvidenceCard title="Infobox context" content={evidence.infoboxContext} />
          <EvidenceCard title="Ontology facts" content={evidence.ontologyFacts} />
        </div>
      </section>

      <section aria-labelledby="rag-exclusions-title">
        <h4 id="rag-exclusions-title" className="mb-3 text-sm font-semibold">
          Retrieval exclusions ({diagnostics.exclusions.length})
        </h4>
        {diagnostics.exclusions.length ? (
          <Table className="text-xs [&_td]:py-1.5 [&_th]:h-8">
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {diagnostics.exclusions.map((exclusion, index) => (
                <TableRow key={`${exclusion.documentId}:${exclusion.reason}:${index}`}>
                  <TableCell className="font-mono">{exclusion.documentId}</TableCell>
                  <TableCell>{exclusion.reason}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="m-0 text-sm text-muted-foreground">No recorded exclusions.</p>
        )}
      </section>
    </div>
  );
}

function DocumentCard({ document }: { document: RetrievedDocument }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="truncate font-mono text-sm" title={document.documentId}>
          #{document.fusedRank + 1} {document.documentId}
        </CardTitle>
        <CardDescription>
          {document.articleSlug}
          {document.sectionPath?.length ? ` / ${document.sectionPath.join(" / ")}` : ""}
        </CardDescription>
        <CardAction className="flex gap-1">
          <Badge variant="outline">{document.sourceKind}</Badge>
          <Badge variant="secondary">{document.retrievalReason}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <dt className="text-muted-foreground">Raw score</dt>
            <dd className="m-0 font-mono tabular-nums">{formatScore(document.rawScore)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Provenance</dt>
            <dd className="m-0">{document.provenance}</dd>
          </div>
        </dl>
        <pre className="m-0 max-h-72 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
          {document.content}
        </pre>
        {document.metadata && Object.keys(document.metadata).length ? (
          <pre className="m-0 max-h-40 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {JSON.stringify(document.metadata, null, 2)}
          </pre>
        ) : null}
      </CardContent>
    </Card>
  );
}

function EvidenceCard({ title, content }: { title: string; content: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <pre className="m-0 max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
          {content || "None"}
        </pre>
      </CardContent>
    </Card>
  );
}

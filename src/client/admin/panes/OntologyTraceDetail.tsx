import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface OntologyEntityTrace {
  name: string;
  type: string;
  articleSlug?: string;
  aliases: string[];
  identifiers: Array<{ scheme: string; value: string }>;
  description?: string;
}

interface OntologyRelationTrace {
  subject: string;
  predicate: string;
  object: string;
  objectSlug?: string;
  objectIsLiteral: boolean;
  source?: string;
  confidence?: number;
  inferredFrom?: string;
}

export interface OntologyExtractionTrace {
  entities: OntologyEntityTrace[];
  relations: OntologyRelationTrace[];
  categories: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeOntologyExtraction(
  value: unknown,
): OntologyExtractionTrace | undefined {
  const extraction = asRecord(value);
  if (!extraction) return undefined;

  const entities = Array.isArray(extraction.entities)
    ? extraction.entities.flatMap((value): OntologyEntityTrace[] => {
        const entity = asRecord(value);
        const name = typeof entity?.name === "string" ? entity.name : "";
        const type = typeof entity?.type === "string" ? entity.type : "";
        if (!name || !type) return [];
        return [
          {
            name,
            type,
            articleSlug:
              typeof entity?.articleSlug === "string"
                ? entity.articleSlug
                : undefined,
            aliases: Array.isArray(entity?.aliases)
              ? entity.aliases.filter(
                  (alias): alias is string => typeof alias === "string",
                )
              : [],
            identifiers: Array.isArray(entity?.identifiers)
              ? entity.identifiers.flatMap((value) => {
                  const identifier = asRecord(value);
                  return typeof identifier?.scheme === "string" &&
                    typeof identifier.value === "string"
                    ? [{ scheme: identifier.scheme, value: identifier.value }]
                    : [];
                })
              : [],
            description:
              typeof entity?.description === "string"
                ? entity.description
                : undefined,
          },
        ];
      })
    : [];

  const relations = Array.isArray(extraction.relations)
    ? extraction.relations.flatMap((value): OntologyRelationTrace[] => {
        const relation = asRecord(value);
        const subject =
          typeof relation?.subject === "string" ? relation.subject : "";
        const predicate =
          typeof relation?.predicate === "string" ? relation.predicate : "";
        const object =
          typeof relation?.object === "string" ? relation.object : "";
        if (!subject || !predicate || !object) return [];
        return [
          {
            subject,
            predicate,
            object,
            objectSlug:
              typeof relation?.objectSlug === "string"
                ? relation.objectSlug
                : undefined,
            objectIsLiteral: relation?.objectIsLiteral === true,
            source:
              typeof relation?.source === "string"
                ? relation.source
                : undefined,
            confidence:
              typeof relation?.confidence === "number"
                ? relation.confidence
                : undefined,
            inferredFrom:
              typeof relation?.inferredFrom === "string"
                ? relation.inferredFrom
                : undefined,
          },
        ];
      })
    : [];

  const categories = Array.isArray(extraction.categories)
    ? extraction.categories.filter(
        (category): category is string => typeof category === "string",
      )
    : [];

  return { entities, relations, categories };
}

export function OntologyFacts({
  extraction,
}: {
  extraction: OntologyExtractionTrace;
}) {
  return (
    <>
      <Card size="sm">
        <CardHeader>
          <CardTitle>Ontology facts</CardTitle>
          <CardDescription>
            {extraction.relations.length} relations gathered for this article.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Subject</TableHead>
                <TableHead>Predicate</TableHead>
                <TableHead>Object</TableHead>
                <TableHead>Evidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {extraction.relations.map((relation, index) => (
                <TableRow
                  key={`${relation.subject}-${relation.predicate}-${relation.object}-${index}`}
                >
                  <TableCell>{relation.subject}</TableCell>
                  <TableCell>{relation.predicate}</TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <span>{relation.object}</span>
                      {relation.objectSlug && (
                        <span className="text-muted-foreground">
                          {relation.objectSlug}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <div className="flex flex-wrap gap-1">
                        {relation.source && (
                          <Badge variant="outline">{relation.source}</Badge>
                        )}
                        {relation.objectIsLiteral && (
                          <Badge variant="secondary">literal</Badge>
                        )}
                        {relation.confidence != null && (
                          <Badge variant="secondary">
                            {Math.round(relation.confidence * 100)}% confidence
                          </Badge>
                        )}
                      </div>
                      {relation.inferredFrom && (
                        <span className="whitespace-normal text-muted-foreground">
                          {relation.inferredFrom}
                        </span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Entities</CardTitle>
          <CardDescription>
            {extraction.entities.length} entities identified by the extraction.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {extraction.entities.map((entity, index) => (
                <TableRow key={`${entity.name}-${entity.type}-${index}`}>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <span>{entity.name}</span>
                      {entity.articleSlug && (
                        <span className="text-muted-foreground">
                          {entity.articleSlug}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{entity.type}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1 whitespace-normal">
                      {entity.description && <span>{entity.description}</span>}
                      {entity.aliases.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          <span className="text-muted-foreground">Aliases</span>
                          {entity.aliases.map((alias) => (
                            <Badge key={alias} variant="secondary">
                              {alias}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {entity.identifiers.map((identifier) => (
                        <span key={`${identifier.scheme}-${identifier.value}`}>
                          <span className="text-muted-foreground">
                            {identifier.scheme}
                          </span>{" "}
                          {identifier.value}
                        </span>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Categories</CardTitle>
          <CardDescription>
            {extraction.categories.length} category tags assigned.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1">
            {extraction.categories.map((category) => (
              <Badge key={category} variant="secondary">
                {category}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </>
  );
}

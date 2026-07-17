import { memo, useEffect, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import { Badge } from "@/components/ui/badge";
import { FieldError } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { PromptMeta, RuleDefinition, RuleSpec } from "./types";

const markdown = new MarkdownIt({ html: false, linkify: false });

export const RulesPreview = memo(function RulesPreview({
  prompt,
  system,
  user,
  rules,
  localRules,
}: {
  prompt: PromptMeta;
  system: string;
  user: string;
  rules: RuleSpec;
  localRules: RuleDefinition[];
}) {
  const [text, setText] = useState("");
  const [tierCounts, setTierCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestRef.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      fetch(`/api/admin/prompt/${prompt.scope}/${prompt.key}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ system, user, rules, localRules }),
      })
        .then(async (response) => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok)
            throw new Error(data.error ?? `error ${response.status}`);
          return data;
        })
        .then((data) => {
          if (requestRef.current !== requestId) return;
          setText(data.text ?? "");
          setTierCounts(data.tierCounts ?? {});
          setError(null);
        })
        .catch((reason) => {
          if (requestRef.current === requestId)
            setError(
              reason instanceof Error ? reason.message : "preview failed",
            );
        })
        .finally(() => {
          if (requestRef.current === requestId) setLoading(false);
        });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [localRules, prompt.key, prompt.scope, rules, system, user]);

  const html = useMemo(() => markdown.render(text), [text]);
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-input p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Assembled prompt preview</p>
          <p className="text-xs text-muted-foreground">
            Final system and user text with the selected rules inserted.
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {([1, 2, 3, 4] as const).map((tier) => (
            <Badge key={tier} variant="outline">
              T{tier} {tierCounts[tier] ?? 0}
            </Badge>
          ))}
          {loading ? <Badge variant="secondary">Updating…</Badge> : null}
        </div>
      </div>
      {error ? <FieldError>{error}</FieldError> : null}
      <Tabs defaultValue="rendered">
        <TabsList variant="line">
          <TabsTrigger value="rendered">Rendered</TabsTrigger>
          <TabsTrigger value="source">Source</TabsTrigger>
        </TabsList>
        <TabsContent value="rendered">
          <div
            className="prose-halu prose prose-sm max-h-96 max-w-none overflow-auto font-serif"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </TabsContent>
        <TabsContent value="source">
          <pre
            className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap"
            aria-label={`${prompt.key} assembled prompt source`}
          >
            {text}
          </pre>
        </TabsContent>
      </Tabs>
    </div>
  );
});

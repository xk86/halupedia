import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PromptEditorCard } from "../prompts/PromptEditorCard";
import type { PromptList, PromptMeta } from "../prompts/types";

type PromptViewMode = "single" | "all";

function promptId(prompt: PromptMeta): string {
  return `${prompt.scope}:${prompt.key}`;
}

function normalizePrompt(prompt: PromptMeta): PromptMeta {
  return {
    ...prompt,
    description:
      prompt.description ??
      "User-defined prompt with no registered runtime description.",
    usedBy: Array.isArray(prompt.usedBy) ? prompt.usedBy : [],
  };
}

function PromptEditorPaneComponent() {
  const [promptList, setPromptList] = useState<PromptList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<PromptViewMode>("single");

  const loadList = useCallback(async () => {
    setListError(null);
    try {
      const res = await fetch("/api/admin/prompts");
      if (!res.ok) throw new Error(`error ${res.status}`);
      const raw: PromptList = await res.json();
      const data = {
        runnable: raw.runnable.map(normalizePrompt),
        shared: raw.shared.map(normalizePrompt),
      };
      setPromptList(data);
      setSelectedId((current) => {
        const prompts = [...data.runnable, ...data.shared];
        return prompts.some((prompt) => promptId(prompt) === current)
          ? current
          : prompts[0]
            ? promptId(prompts[0])
            : null;
      });
    } catch (err: any) {
      setListError(err?.message ?? "failed to load prompts");
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const prompts = useMemo(
    () => (promptList ? [...promptList.runnable, ...promptList.shared] : []),
    [promptList],
  );
  const selectedPrompt =
    prompts.find((prompt) => promptId(prompt) === selectedId) ?? null;
  const selectItems = Object.fromEntries(
    prompts.map((prompt) => [promptId(prompt), prompt.key]),
  );

  return (
    <Card size="sm" data-testid="prompt-editor-pane">
      <CardHeader>
        <CardTitle>
          <h2>Prompt editor</h2>
        </CardTitle>
        <CardDescription>
          Edit TOML-backed prompt templates. Changes reload the runtime.
        </CardDescription>
        <CardAction className="flex flex-wrap items-center justify-end gap-2">
          <Badge variant="secondary">{prompts.length} prompts</Badge>
          <ToggleGroup
            value={[viewMode]}
            onValueChange={(values) => {
              const value = values[0];
              if (value === "single" || value === "all") setViewMode(value);
            }}
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Prompt display"
          >
            <ToggleGroupItem value="single">One prompt</ToggleGroupItem>
            <ToggleGroupItem value="all">All prompts</ToggleGroupItem>
          </ToggleGroup>
        </CardAction>
      </CardHeader>

      <CardContent className="flex min-w-0 flex-col gap-4">
        {listError ? <FieldError>{listError}</FieldError> : null}

        {viewMode === "single" ? (
          <Field>
            <FieldLabel htmlFor="prompt-selector">Prompt</FieldLabel>
            <Select
              value={selectedId}
              onValueChange={(value) =>
                setSelectedId((value as string | null) ?? null)
              }
              disabled={!promptList || prompts.length === 0}
              items={selectItems}
            >
              <SelectTrigger id="prompt-selector" className="w-full">
                <SelectValue placeholder="Loading prompts…" />
              </SelectTrigger>
              <SelectContent>
                {promptList && promptList.runnable.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>Runnable</SelectLabel>
                    {promptList.runnable.map((prompt) => (
                      <SelectItem key={prompt.key} value={promptId(prompt)}>
                        {prompt.key}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
                {promptList && promptList.shared.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>Shared</SelectLabel>
                    {promptList.shared.map((prompt) => (
                      <SelectItem key={prompt.key} value={promptId(prompt)}>
                        {prompt.key}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        {viewMode === "single" && selectedPrompt ? (
          <PromptEditorCard
            key={promptId(selectedPrompt)}
            prompt={selectedPrompt}
          />
        ) : null}

        {viewMode === "all" ? (
          <div
            className="flex min-w-0 flex-col gap-4"
            data-testid="all-prompt-editors"
          >
            {prompts.map((prompt) => (
              <PromptEditorCard key={promptId(prompt)} prompt={prompt} />
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export const PromptEditorPane = memo(PromptEditorPaneComponent);

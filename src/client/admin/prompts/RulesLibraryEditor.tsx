import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FieldError } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CategoryEditor } from "./CategoryEditor";
import { RuleEditor } from "./RuleEditor";
import type { RuleCategory, RuleDefinition } from "./types";

export const RulesLibraryEditor = memo(function RulesLibraryEditor({
  categories,
  rules,
  onSaved,
}: {
  categories: RuleCategory[];
  rules: RuleDefinition[];
  onSaved: (categories: RuleCategory[], rules: RuleDefinition[]) => void;
}) {
  const [draftCategories, setDraftCategories] = useState(categories);
  const [draftRules, setDraftRules] = useState(rules);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ruleRefRenames = useRef(new Map<string, string>());
  const [selectedCategory, setSelectedCategory] = useState(
    categories[0]?.id ?? "",
  );
  const dirty = useMemo(
    () =>
      JSON.stringify([draftCategories, draftRules]) !==
      JSON.stringify([categories, rules]),
    [categories, draftCategories, draftRules, rules],
  );

  useEffect(() => {
    setDraftCategories(categories);
    setDraftRules(rules);
    setSelectedCategory((current) =>
      categories.some((category) => category.id === current)
        ? current
        : (categories[0]?.id ?? ""),
    );
    ruleRefRenames.current.clear();
  }, [categories, rules]);

  const recordRuleRefRename = (from: string, to: string) => {
    let chained = false;
    for (const [original, current] of ruleRefRenames.current) {
      if (current !== from) continue;
      chained = true;
      if (original === to) ruleRefRenames.current.delete(original);
      else ruleRefRenames.current.set(original, to);
    }
    if (!chained && from !== to) ruleRefRenames.current.set(from, to);
  };

  const visibleRules = useMemo(
    () => draftRules.filter((rule) => rule.category === selectedCategory),
    [draftRules, selectedCategory],
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/rules/library", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          categories: draftCategories.map(
            ({ rules: _rules, ...category }) => category,
          ),
          rules: draftRules,
          renames: [...ruleRefRenames.current].map(([from, to]) => ({ from, to })),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(data.error ?? `error ${response.status}`);
      const nextCategories = (data.categories ?? []).map(
        (category: RuleCategory) => ({ ...category, rules: [] }),
      );
      setDraftCategories(nextCategories);
      setDraftRules(data.rules ?? []);
      ruleRefRenames.current.clear();
      onSaved(nextCategories, data.rules ?? []);
      setMessage("Rule library saved — runtime reloaded.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Rule library</CardTitle>
        <CardDescription>
          Edit shared categories, rules, overrides, and structured examples.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="rules">
          <TabsList>
            <TabsTrigger value="rules">
              Rules <Badge variant="secondary">{draftRules.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="categories">
              Categories{" "}
              <Badge variant="secondary">{draftCategories.length}</Badge>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="rules" className="flex flex-col gap-3 pt-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Select
                value={selectedCategory}
                onValueChange={(value) => setSelectedCategory(String(value))}
                items={Object.fromEntries(
                  draftCategories.map((category) => [
                    category.id,
                    category.title,
                  ]),
                )}
              >
                <SelectTrigger aria-label="Rule category" className="min-w-56">
                  <SelectValue placeholder="Rule category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {draftCategories.map((category) => (
                      <SelectItem key={category.id} value={category.id}>
                        {category.title} (
                        {
                          draftRules.filter(
                            (rule) => rule.category === category.id,
                          ).length
                        }
                        )
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setDraftRules((current) => [
                    ...current,
                    {
                      id: "",
                      category: selectedCategory || draftCategories[0]?.id,
                      tier: 2,
                      text: "",
                    },
                  ])
                }
              >
                <Plus data-icon="inline-start" />
                Add rule
              </Button>
            </div>
            {visibleRules.map((rule) => {
              const index = draftRules.indexOf(rule);
              return (
                <RuleEditor
                  key={`${rule.category}-${rule.id}-${index}`}
                  rule={rule}
                  categories={draftCategories}
                  availableRules={draftRules}
                  onChange={(next) => {
                    const from = rule.category && rule.id
                      ? `${rule.category}/${rule.id}`
                      : null;
                    const to = next.category && next.id
                      ? `${next.category}/${next.id}`
                      : null;
                    if (from && to && from !== to) recordRuleRefRename(from, to);
                    setDraftRules((current) => {
                      return current.map((item, itemIndex) => {
                        const updated = itemIndex === index ? next : item;
                        return from && to && updated.overrides?.includes(from)
                          ? {
                              ...updated,
                              overrides: updated.overrides.map((ref) =>
                                ref === from ? to : ref,
                              ),
                            }
                          : updated;
                      });
                    });
                  }}
                  onDelete={() =>
                    setDraftRules((current) =>
                      current.filter((_, itemIndex) => itemIndex !== index),
                    )
                  }
                />
              );
            })}
          </TabsContent>
          <TabsContent value="categories" className="flex flex-col gap-2 pt-2">
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setDraftCategories((current) => [
                    ...current,
                    {
                      id: "",
                      title: "",
                      description: "",
                      order: current.length * 10,
                      rules: [],
                    },
                  ])
                }
              >
                <Plus data-icon="inline-start" />
                Add category
              </Button>
            </div>
            {draftCategories.map((category, index) => (
              <CategoryEditor
                key={`${category.id}-${index}`}
                category={category}
                onChange={(next) => {
                  setDraftCategories((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? next : item,
                    ),
                  );
                  if (next.id !== category.id) {
                    setDraftRules((current) =>
                      current.map((rule) =>
                        rule.category === category.id
                          ? { ...rule, category: next.id }
                          : rule,
                      ),
                    );
                  }
                }}
                onDelete={() => {
                  setDraftCategories((current) =>
                    current.filter((_, itemIndex) => itemIndex !== index),
                  );
                  setDraftRules((current) =>
                    current.filter((rule) => rule.category !== category.id),
                  );
                }}
              />
            ))}
          </TabsContent>
        </Tabs>
      </CardContent>
      <CardFooter className="flex-wrap gap-2 border-t">
        <Button type="button" onClick={save} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save rule library"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!dirty || saving}
          onClick={() => {
            setDraftCategories(categories);
            setDraftRules(rules);
            ruleRefRenames.current.clear();
            setError(null);
          }}
        >
          Reset
        </Button>
        {message ? <span className="text-sm">{message}</span> : null}
        {error ? <FieldError>{error}</FieldError> : null}
      </CardFooter>
    </Card>
  );
});

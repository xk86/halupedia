import { memo } from "react";
import { Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RuleEditor } from "./RuleEditor";
import type { RuleCategory, RuleDefinition, RuleSpec } from "./types";
import { humanizeRuleId } from "./ruleUtils";

export const PromptRulesConfig = memo(function PromptRulesConfig({
  rules,
  localRules,
  categories,
  availableRules,
  onChange,
}: {
  rules: RuleSpec;
  localRules: RuleDefinition[];
  categories: RuleCategory[];
  availableRules: RuleDefinition[];
  onChange: (rules: RuleSpec, localRules: RuleDefinition[]) => void;
}) {
  const selectedCategories = new Set(rules.categories);
  const selectedRules = new Set(rules.rules ?? []);
  const categoryTitles = new Map(
    categories.map((category) => [category.id, category.title]),
  );
  const individualRules = availableRules.filter(
    (rule) => rule.category && !selectedCategories.has(rule.category),
  );
  const activeCategories = categories.filter((category) =>
    selectedCategories.has(category.id),
  );

  const changeCategories = (category: string, checked: boolean) => {
    const categories = checked
      ? [...rules.categories, category]
      : rules.categories.filter((value) => value !== category);
    const remainingRules = (rules.rules ?? []).filter(
      (ref) => !checked || !ref.startsWith(`${category}/`),
    );
    onChange(
      {
        categories,
        ...(remainingRules.length ? { rules: remainingRules } : {}),
      },
      localRules,
    );
  };

  const changeRule = (ref: string, checked: boolean) => {
    const next = checked
      ? [...(rules.rules ?? []), ref]
      : (rules.rules ?? []).filter((value) => value !== ref);
    onChange(
      { categories: rules.categories, ...(next.length ? { rules: next } : {}) },
      localRules,
    );
  };

  return (
    <FieldGroup className="gap-4">
      <Field>
        <div className="flex items-center justify-between gap-2">
          <div>
            <FieldLabel>Shared categories</FieldLabel>
            <FieldDescription>
              Each category adds all of its rules.
            </FieldDescription>
          </div>
          <Popover>
            <PopoverTrigger
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <Plus data-icon="inline-start" />
              Choose categories
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-[38rem] max-w-[90vw] gap-2 p-2"
            >
              <div className="grid max-h-80 gap-1 overflow-y-auto p-1 md:grid-cols-2">
                {categories.map((category) => (
                  <Field
                    key={category.id}
                    orientation="horizontal"
                    className="items-start rounded-md p-2"
                  >
                    <Checkbox
                      id={`prompt-rule-category-${category.id}`}
                      checked={selectedCategories.has(category.id)}
                      onCheckedChange={(checked) =>
                        changeCategories(category.id, checked === true)
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <FieldLabel
                          htmlFor={`prompt-rule-category-${category.id}`}
                        >
                          {category.title}
                        </FieldLabel>
                        <Badge variant="outline">{category.rules.length}</Badge>
                      </div>
                      <FieldDescription className="line-clamp-2">
                        {category.description}
                      </FieldDescription>
                    </div>
                  </Field>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        {activeCategories.length === 0 ? (
          <p className="rounded-md border border-dashed border-input p-3 text-sm text-muted-foreground">
            No shared categories selected.
          </p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {activeCategories.map((category) => (
              <div
                key={category.id}
                className="flex min-w-0 items-start gap-2 rounded-md border border-input p-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{category.title}</span>
                    <Badge variant="outline">{category.rules.length}</Badge>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {category.description}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${category.title}`}
                  onClick={() => changeCategories(category.id, false)}
                >
                  <X />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Field>

      <Field>
        <div className="flex items-center justify-between gap-2">
          <div>
            <FieldLabel>Individual shared rules</FieldLabel>
            <FieldDescription>
              Use only when the whole category would be too broad.
            </FieldDescription>
          </div>
          <Popover>
            <PopoverTrigger
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <Plus data-icon="inline-start" />
              Choose rules
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-[34rem] max-w-[90vw] gap-2 p-2"
            >
              <div className="grid max-h-72 gap-1 overflow-y-auto p-1 md:grid-cols-2">
                {individualRules.map((rule) => {
                  const ref = `${rule.category}/${rule.id}`;
                  return (
                    <Field key={ref} orientation="horizontal" className="p-1">
                      <Checkbox
                        id={`prompt-rule-${ref}`}
                        checked={selectedRules.has(ref)}
                        onCheckedChange={(checked) =>
                          changeRule(ref, checked === true)
                        }
                      />
                      <FieldLabel
                        htmlFor={`prompt-rule-${ref}`}
                        className="min-w-0 font-normal"
                      >
                        <span className="block truncate">
                          {humanizeRuleId(rule.id)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {categoryTitles.get(rule.category ?? "") ??
                            "Shared rule"}
                        </span>
                      </FieldLabel>
                    </Field>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        {(rules.rules ?? []).length === 0 ? (
          <p className="rounded-md border border-dashed border-input p-3 text-sm text-muted-foreground">
            No individual rules. This prompt uses whole categories only.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {(rules.rules ?? []).map((ref) => {
              const rule = availableRules.find(
                (candidate) => `${candidate.category}/${candidate.id}` === ref,
              );
              return (
                <div
                  key={ref}
                  className="flex items-center gap-1 rounded-md border border-input py-1 pr-1 pl-2 text-sm"
                >
                  <span>
                    {humanizeRuleId(rule?.id ?? ref.split("/").at(-1) ?? ref)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${humanizeRuleId(rule?.id ?? ref)}`}
                    onClick={() => changeRule(ref, false)}
                  >
                    <X />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Field>

      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Prompt-only exceptions</p>
          <p className="text-xs text-muted-foreground">
            Keep reusable behavior in a shared category.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            onChange(rules, [...localRules, { id: "", tier: 2, text: "" }])
          }
        >
          <Plus data-icon="inline-start" />
          Add prompt-only rule
        </Button>
      </div>
      {localRules.map((rule, index) => (
        <RuleEditor
          key={`${rule.id}-${index}`}
          rule={rule}
          categories={categories}
          availableRules={availableRules}
          showCategory={false}
          onChange={(next) =>
            onChange(
              rules,
              localRules.map((item, itemIndex) =>
                itemIndex === index ? next : item,
              ),
            )
          }
          onDelete={() =>
            onChange(
              rules,
              localRules.filter((_, itemIndex) => itemIndex !== index),
            )
          }
        />
      ))}
    </FieldGroup>
  );
});

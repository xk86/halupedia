import { memo } from "react";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PromptRuleCategorySelector } from "./PromptRuleCategorySelector";
import type { RuleCategory, RuleSpec } from "./types";

export const PromptRulesConfig = memo(function PromptRulesConfig({
  rules,
  categories,
  onChange,
}: {
  rules: RuleSpec;
  categories: RuleCategory[];
  onChange: (rules: RuleSpec) => void;
}) {
  const importedCategories = new Set(rules.categories);
  const selectedRules = new Set(rules.rules ?? []);
  const activeCategories = categories.filter((category) =>
    importedCategories.has(category.id),
  );
  const availableCategories = categories.filter(
    (category) => !importedCategories.has(category.id),
  );

  const changeCategory = (category: string, checked: boolean) => {
    const nextCategories = checked
      ? [...rules.categories, category]
      : rules.categories.filter((value) => value !== category);
    const nextRules = checked
      ? (rules.rules ?? [])
      : (rules.rules ?? []).filter((ref) => !ref.startsWith(`${category}/`));

    onChange({
      categories: nextCategories,
      ...(nextRules.length ? { rules: nextRules } : {}),
    });
  };

  const changeRule = (ref: string, checked: boolean) => {
    const nextRules = checked
      ? [...(rules.rules ?? []), ref]
      : (rules.rules ?? []).filter((value) => value !== ref);

    onChange({
      categories: rules.categories,
      ...(nextRules.length ? { rules: nextRules } : {}),
    });
  };

  return (
    <FieldGroup className="gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <FieldLabel>Rule namespaces</FieldLabel>
          <FieldDescription>
            Import a category, expand it, then enable only the rules this prompt
            uses.
          </FieldDescription>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 self-end">
          <Badge variant="secondary">
            {rules.categories.length} imported · {(rules.rules ?? []).length}{" "}
            enabled
          </Badge>
          <Select
            value={null}
            onValueChange={(category) => {
              if (category) changeCategory(String(category), true);
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="Add category"
              data-testid="add-rule-category"
              disabled={availableCategories.length === 0}
            >
              <Plus data-icon="inline-start" />
              <SelectValue
                placeholder={
                  availableCategories.length === 0
                    ? "All categories added"
                    : "Add category"
                }
              />
            </SelectTrigger>
            <SelectContent
              align="end"
              alignItemWithTrigger={false}
              className="max-h-72"
            >
              <SelectGroup>
                <SelectLabel>Add rule namespace</SelectLabel>
                {availableCategories.map((category) => {
                  return (
                    <SelectItem key={category.id} value={category.id}>
                      {category.title}
                    </SelectItem>
                  );
                })}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>

      {activeCategories.length === 0 ? (
        <FieldDescription className="rounded-md border border-dashed border-input p-2">
          No rule namespaces imported. Add a category to expose its rules.
        </FieldDescription>
      ) : (
        <FieldGroup className="grid items-start gap-2 md:grid-cols-2">
          {activeCategories.map((category) => (
            <PromptRuleCategorySelector
              key={category.id}
              category={category}
              selectedRules={selectedRules}
              onRemove={() => changeCategory(category.id, false)}
              onRuleChange={changeRule}
            />
          ))}
        </FieldGroup>
      )}
    </FieldGroup>
  );
});

import { memo } from "react";
import { Badge } from "@/components/ui/badge";
import {
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
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

  const changeCategory = (category: string, checked: boolean) => {
    const nextCategories = checked
      ? [...rules.categories, category]
      : rules.categories.filter((value) => value !== category);
    const nextRules = checked
      ? (rules.rules ?? [])
      : (rules.rules ?? []).filter(
          (ref) => !ref.startsWith(`${category}/`),
        );

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
      <div className="flex items-start justify-between gap-3">
        <div>
          <FieldLabel>Rule namespaces</FieldLabel>
          <FieldDescription>
            Import a category, expand it, then enable only the rules this prompt
            uses.
          </FieldDescription>
        </div>
        <Badge variant="secondary" className="shrink-0">
          {rules.categories.length} imported · {(rules.rules ?? []).length}{" "}
          enabled
        </Badge>
      </div>

      <FieldGroup className="gap-2">
        {categories.map((category) => (
          <PromptRuleCategorySelector
            key={category.id}
            category={category}
            imported={importedCategories.has(category.id)}
            selectedRules={selectedRules}
            onImportChange={(checked) =>
              changeCategory(category.id, checked)
            }
            onRuleChange={changeRule}
          />
        ))}
      </FieldGroup>
    </FieldGroup>
  );
});

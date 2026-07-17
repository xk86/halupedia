import { memo, useState } from "react";
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

/** The two ref prefixes a category owns in the raw rules list: its plain
 *  "category/id" refs and its "!category/id" exclusions. Does not include
 *  the wildcard ref itself ("category/*"), which callers strip separately. */
function categoryRefPrefixes(category: string): [string, string] {
  return [`${category}/`, `!${category}/`];
}

function stripCategory(refs: string[], category: string): string[] {
  const [plain, excluded] = categoryRefPrefixes(category);
  return refs.filter((ref) => !ref.startsWith(plain) && !ref.startsWith(excluded));
}

/** How many of a category's rules are effectively selected right now,
 *  whichever encoding is in play: an explicit list, or a wildcard minus
 *  whatever's been individually excluded from it. */
function countSelected(category: RuleCategory, rawRules: string[]): number {
  const wildcardRef = `${category.id}/*`;
  if (!rawRules.includes(wildcardRef)) {
    const selected = new Set(rawRules);
    return category.rules.filter((rule) => selected.has(`${category.id}/${rule.id}`)).length;
  }
  const excluded = new Set(
    rawRules
      .filter((ref) => ref.startsWith(`!${category.id}/`))
      .map((ref) => ref.slice(1)),
  );
  return category.rules.filter((rule) => !excluded.has(`${category.id}/${rule.id}`)).length;
}

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
  const rawRules = rules.rules ?? [];
  const selectedRules = new Set(rawRules);
  const activeCategories = categories.filter((category) =>
    importedCategories.has(category.id),
  );
  const availableCategories = categories.filter(
    (category) => !importedCategories.has(category.id),
  );

  // Remembers each category's explicit per-rule selection from just before it
  // was last collapsed into a "category/*" wildcard, so toggling "Select
  // all" off restores exactly what was picked — as long as nothing was
  // excluded while wildcarded (see toggleWildcard). Session-local UI
  // convenience only — PromptEditorCard remounts this component (via its own
  // `key`) whenever the prompt being edited changes.
  const [priorSelectionByCategory, setPriorSelectionByCategory] = useState<
    Record<string, string[]>
  >({});

  const changeCategory = (category: string, checked: boolean) => {
    const nextCategories = checked
      ? [...rules.categories, category]
      : rules.categories.filter((value) => value !== category);
    const nextRules = checked ? rawRules : stripCategory(rawRules, category);

    if (!checked) {
      setPriorSelectionByCategory((prev) => {
        const { [category]: _removed, ...rest } = prev;
        return rest;
      });
    }

    onChange({
      categories: nextCategories,
      ...(nextRules.length ? { rules: nextRules } : {}),
    });
  };

  // ref is always a plain "category/id" — the wildcard/exclusion encoding is
  // an implementation detail of this category's current selection mode, not
  // something the caller (a rule checkbox) needs to know about.
  const changeRule = (ref: string, checked: boolean) => {
    const category = ref.split("/", 1)[0]!;
    const wildcardRef = `${category}/*`;
    const excludeRef = `!${ref}`;
    const isWildcard = rawRules.includes(wildcardRef);

    let nextRules: string[];
    if (isWildcard) {
      // Under a wildcard, a rule is included by default; unchecking it adds
      // a "!category/id" exclusion instead of removing a plain ref (there
      // isn't one to remove), and re-checking removes that exclusion.
      nextRules = checked
        ? rawRules.filter((value) => value !== excludeRef)
        : rawRules.includes(excludeRef)
          ? rawRules
          : [...rawRules, excludeRef];
    } else {
      nextRules = checked
        ? [...rawRules, ref]
        : rawRules.filter((value) => value !== ref);
    }

    onChange({
      categories: rules.categories,
      ...(nextRules.length ? { rules: nextRules } : {}),
    });
  };

  const toggleWildcard = (category: string, checked: boolean) => {
    const wildcardRef = `${category}/*`;
    const [, excludedPrefix] = categoryRefPrefixes(category);
    const categoryRules = categories.find((c) => c.id === category)?.rules ?? [];
    const allRefs = categoryRules.map((rule) => `${category}/${rule.id}`);

    if (checked) {
      // Remember the explicit selection this wildcard is replacing so
      // switching it back off can restore it exactly, provided nothing gets
      // excluded in the meantime (see below).
      const explicit = rawRules.filter(
        (ref) => ref.startsWith(`${category}/`) && ref !== wildcardRef,
      );
      setPriorSelectionByCategory((prev) => ({ ...prev, [category]: explicit }));
      const nextRules = [...stripCategory(rawRules, category), wildcardRef];
      onChange({ categories: rules.categories, rules: nextRules });
      return;
    }

    // Turning off: rules individually excluded while wildcarded represent a
    // deliberate choice made *during* the wildcard, not the pre-wildcard
    // selection — honor those over stale memory by expanding to the current
    // effective set (every rule minus what's excluded). Only fall back to
    // remembered pre-wildcard selection (or, absent that, the full list) when
    // nothing was excluded, so a no-op on/off round-trip still restores
    // exactly what was there before.
    const excludedIds = new Set(
      rawRules.filter((ref) => ref.startsWith(excludedPrefix)).map((ref) => ref.slice(1)),
    );
    const restored =
      excludedIds.size > 0
        ? allRefs.filter((ref) => !excludedIds.has(ref))
        : (priorSelectionByCategory[category] ?? allRefs);
    const nextRules = [...stripCategory(rawRules, category), ...restored];
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
            {rules.categories.length} imported ·{" "}
            {activeCategories.reduce(
              (total, category) => total + countSelected(category, rawRules),
              0,
            )}{" "}
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
              wildcard={selectedRules.has(`${category.id}/*`)}
              excludedRefs={
                new Set(
                  rawRules
                    .filter((ref) => ref.startsWith(`!${category.id}/`))
                    .map((ref) => ref.slice(1)),
                )
              }
              onRemove={() => changeCategory(category.id, false)}
              onRuleChange={changeRule}
              onWildcardToggle={(checked) => toggleWildcard(category.id, checked)}
            />
          ))}
        </FieldGroup>
      )}
    </FieldGroup>
  );
});

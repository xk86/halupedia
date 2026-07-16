import { memo } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { RuleEditor } from "./RuleEditor";
import type { RuleCategory, RuleDefinition, RuleSpec } from "./types";
import { parseSelectorList } from "./ruleUtils";

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
  return (
    <FieldGroup className="gap-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="rules-include">Include selectors</FieldLabel>
          <Textarea
            id="rules-include"
            value={rules.include.join("\n")}
            onChange={(event) =>
              onChange(
                { ...rules, include: parseSelectorList(event.target.value) },
                localRules,
              )
            }
            className="min-h-24 font-mono text-xs"
            placeholder={"tone\ncanon@1-2\nformatting/no_raw_html"}
          />
          <FieldDescription>
            One selector per line: category, tier range, or category/rule.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="rules-exclude">Exclude selectors</FieldLabel>
          <Textarea
            id="rules-exclude"
            value={(rules.exclude ?? []).join("\n")}
            onChange={(event) => {
              const exclude = parseSelectorList(event.target.value);
              onChange(
                {
                  include: rules.include,
                  ...(exclude.length ? { exclude } : {}),
                },
                localRules,
              );
            }}
            className="min-h-24 font-mono text-xs"
            placeholder="tone/no_whimsy"
          />
          <FieldDescription>
            Resolved after includes. Leave empty for no exclusions.
          </FieldDescription>
        </Field>
      </div>

      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Prompt-local rules</p>
          <p className="text-xs text-muted-foreground">
            Stored as [[local_rule]] and available only to this prompt.
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
          Add local rule
        </Button>
      </div>
      {localRules.length === 0 ? (
        <p className="rounded-md border border-dashed border-input p-3 text-sm text-muted-foreground">
          No prompt-local rules.
        </p>
      ) : null}
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

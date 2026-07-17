import { memo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { humanizeRuleId } from "./ruleUtils";
import type { RuleCategory } from "./types";

export const PromptRuleCategorySelector = memo(
  function PromptRuleCategorySelector({
    category,
    imported,
    selectedRules,
    onImportChange,
    onRuleChange,
  }: {
    category: RuleCategory;
    imported: boolean;
    selectedRules: Set<string>;
    onImportChange: (checked: boolean) => void;
    onRuleChange: (ref: string, checked: boolean) => void;
  }) {
    const [open, setOpen] = useState(false);
    const importId = `prompt-rule-category-${category.id}`;
    const selectedCount = category.rules.filter((rule) =>
      selectedRules.has(`${category.id}/${rule.id}`),
    ).length;

    return (
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        data-imported={imported}
        className={cn(
          "rounded-md border border-input transition-opacity",
          !imported && "opacity-50",
        )}
      >
        <div className="flex items-start gap-3 p-3">
          <Checkbox
            id={importId}
            checked={imported}
            onCheckedChange={(checked) => {
              const nextImported = checked === true;
              if (nextImported) setOpen(true);
              onImportChange(nextImported);
            }}
          />
          <FieldContent className="min-w-0">
            <FieldLabel
              htmlFor={importId}
              aria-label={`Import ${category.title}`}
            >
              {category.title}
            </FieldLabel>
            <FieldDescription className="line-clamp-2">
              {category.description}
            </FieldDescription>
          </FieldContent>
          <Badge variant={selectedCount ? "secondary" : "outline"}>
            {selectedCount} / {category.rules.length}
          </Badge>
          <CollapsibleTrigger
            type="button"
            aria-label={`${open ? "Collapse" : "Expand"} ${category.title} rules`}
            className="group/trigger -m-1 cursor-pointer rounded-md p-1 hover:bg-muted"
          >
            <ChevronDown
              aria-hidden
              className="size-4 transition-transform group-not-data-[panel-open]/trigger:-rotate-90"
            />
          </CollapsibleTrigger>
        </div>

        <CollapsibleContent>
          <FieldGroup className="gap-1 border-t border-input p-2">
            {category.rules.map((rule) => {
              const ref = `${category.id}/${rule.id}`;
              const selected = selectedRules.has(ref);
              const ruleId = `prompt-rule-${category.id}-${rule.id}`;

              return (
                <Field
                  key={ref}
                  orientation="horizontal"
                  data-disabled={!imported}
                  data-selected={selected}
                  className={cn(
                    "items-start rounded-md p-2 transition-opacity hover:bg-muted/50",
                    !selected && "opacity-50",
                  )}
                >
                  <Checkbox
                    id={ruleId}
                    checked={selected}
                    disabled={!imported}
                    onCheckedChange={(checked) =>
                      onRuleChange(ref, checked === true)
                    }
                  />
                  <FieldContent className="min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <FieldLabel htmlFor={ruleId} className="font-normal">
                        {humanizeRuleId(rule.id)}
                      </FieldLabel>
                      <Badge variant="outline">Tier {rule.tier}</Badge>
                    </div>
                    <FieldDescription>{rule.text}</FieldDescription>
                  </FieldContent>
                </Field>
              );
            })}
          </FieldGroup>
        </CollapsibleContent>
      </Collapsible>
    );
  },
);

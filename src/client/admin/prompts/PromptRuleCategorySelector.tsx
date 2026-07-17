import { memo, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { humanizeRuleId } from "./ruleUtils";
import type { RuleCategory } from "./types";

export const PromptRuleCategorySelector = memo(
  function PromptRuleCategorySelector({
    category,
    selectedRules,
    wildcard,
    excludedRefs,
    onRemove,
    onRuleChange,
    onWildcardToggle,
  }: {
    category: RuleCategory;
    selectedRules: Set<string>;
    /** Whether this category is selected via "category/*" rather than an
     *  explicit per-rule list. */
    wildcard: boolean;
    /** Refs excluded from the wildcard via "!category/id" — meaningless when
     *  `wildcard` is false. */
    excludedRefs: Set<string>;
    onRemove: () => void;
    onRuleChange: (ref: string, checked: boolean) => void;
    onWildcardToggle: (checked: boolean) => void;
  }) {
    const [open, setOpen] = useState(false);
    const [confirmingRemove, setConfirmingRemove] = useState(false);
    const selectedCount = wildcard
      ? category.rules.length - excludedRefs.size
      : category.rules.filter((rule) => selectedRules.has(`${category.id}/${rule.id}`))
          .length;

    return (
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className={cn(
          "self-start rounded-md border border-input",
          open && "md:col-span-2",
        )}
      >
        <div className="flex items-start gap-2 p-2">
          <FieldContent className="min-w-0 gap-0">
            <FieldLabel>{category.title}</FieldLabel>
            <FieldDescription className="truncate">
              {category.description}
            </FieldDescription>
          </FieldContent>
          <Badge variant={selectedCount ? "secondary" : "outline"}>
            {selectedCount} / {category.rules.length}
          </Badge>
          <CollapsibleTrigger
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon-xs" }),
              "group/trigger",
            )}
            aria-label={`${open ? "Collapse" : "Expand"} ${category.title} rules`}
          >
            <ChevronDown
              aria-hidden
              className="transition-transform group-not-data-[panel-open]/trigger:-rotate-90"
            />
          </CollapsibleTrigger>
          <Popover open={confirmingRemove} onOpenChange={setConfirmingRemove}>
            <PopoverTrigger
              className={buttonVariants({ variant: "ghost", size: "icon-xs" })}
              aria-label={`Remove ${category.title}`}
            >
              <X />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 gap-2 p-3">
              <FieldDescription>
                Remove <strong>{category.title}</strong> and its selected rules
                from this prompt?
              </FieldDescription>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmingRemove(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    setConfirmingRemove(false);
                    onRemove();
                  }}
                >
                  Remove
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <CollapsibleContent>
          <Separator />
          <Field
            orientation="horizontal"
            className="items-center gap-2 border-b border-input p-1.5"
          >
            <Checkbox
              id={`prompt-rule-wildcard-${category.id}`}
              checked={wildcard}
              onCheckedChange={(checked) => onWildcardToggle(checked === true)}
            />
            <FieldContent className="min-w-0 gap-0">
              <FieldLabel
                htmlFor={`prompt-rule-wildcard-${category.id}`}
                className="font-normal"
              >
                Select all ({category.id}/*)
              </FieldLabel>
              <FieldDescription>
                {wildcard
                  ? excludedRefs.size > 0
                    ? `Every rule in this category except ${excludedRefs.size} unchecked below, including ones added later.`
                    : "Every rule in this category, including ones added later. Uncheck any rule below to exclude it."
                  : "Import every current and future rule in this category as one wildcard entry."}
              </FieldDescription>
            </FieldContent>
          </Field>
          <FieldGroup className="grid gap-0 p-1 md:grid-cols-2">
            {category.rules.map((rule) => {
              const ref = `${category.id}/${rule.id}`;
              const selected = wildcard ? !excludedRefs.has(ref) : selectedRules.has(ref);
              const ruleId = `prompt-rule-${category.id}-${rule.id}`;

              return (
                <Field
                  key={ref}
                  orientation="horizontal"
                  data-selected={selected}
                  className={cn(
                    "items-start rounded-md p-1.5 transition-opacity hover:bg-muted/50",
                    !selected && "opacity-50",
                  )}
                >
                  <Checkbox
                    id={ruleId}
                    checked={selected}
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
                    <FieldDescription className="line-clamp-2">
                      {rule.text}
                    </FieldDescription>
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

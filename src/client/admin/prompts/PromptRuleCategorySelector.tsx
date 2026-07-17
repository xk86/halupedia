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

/** Tier 1 is "never break" (most severe) down to tier 4 "suggested" (least
 *  severe) — map that onto the existing badge variants rather than inventing
 *  new colors. */
const TIER_BADGE_VARIANT = {
  1: "destructive",
  2: "warn",
  3: "secondary",
  4: "outline",
} as const;

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
        <CollapsibleTrigger
          render={<div />}
          nativeButton={false}
          className="group/trigger flex w-full items-start gap-2 p-2 text-left"
          aria-label={`${open ? "Collapse" : "Expand"} ${category.title} rules`}
        >
          <FieldContent className="min-w-0 gap-0">
            <FieldLabel className="truncate">{category.title}</FieldLabel>
            <FieldDescription className="truncate">
              {category.description}
            </FieldDescription>
          </FieldContent>
          <Badge
            variant={selectedCount ? "secondary" : "outline"}
            className="shrink-0"
          >
            {selectedCount} / {category.rules.length}
          </Badge>
          <ChevronDown
            aria-hidden
            className="mt-1 shrink-0 transition-transform group-not-data-[panel-open]/trigger:-rotate-90"
          />
          <Popover open={confirmingRemove} onOpenChange={setConfirmingRemove}>
            <PopoverTrigger
              className={buttonVariants({ variant: "ghost", size: "icon-xs" })}
              aria-label={`Remove ${category.title}`}
              onClick={(e) => e.stopPropagation()}
            >
              <X />
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-64 gap-2 p-3"
              onClick={(e) => e.stopPropagation()}
            >
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
        </CollapsibleTrigger>

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
          <FieldGroup className="grid gap-0 p-1 sm:grid-cols-2 xl:grid-cols-3">
            {category.rules.map((rule) => {
              const ref = `${category.id}/${rule.id}`;
              const selected = wildcard ? !excludedRefs.has(ref) : selectedRules.has(ref);
              const ruleId = `prompt-rule-${category.id}-${rule.id}`;

              return (
                <Field
                  key={ref}
                  data-selected={selected}
                  className={cn(
                    "grid min-w-0 grid-cols-[auto_1fr_auto] items-start gap-x-2 gap-y-0 rounded-md p-1.5 transition-opacity hover:bg-muted/50",
                    !selected && "opacity-50",
                  )}
                >
                  <Checkbox
                    id={ruleId}
                    checked={selected}
                    onCheckedChange={(checked) =>
                      onRuleChange(ref, checked === true)
                    }
                    className="mt-0.5"
                  />
                  <FieldLabel
                    htmlFor={ruleId}
                    className="min-w-0 truncate font-normal"
                  >
                    {humanizeRuleId(rule.id)}
                  </FieldLabel>
                  <Badge variant={TIER_BADGE_VARIANT[rule.tier]} className="shrink-0">
                    Tier {rule.tier}
                  </Badge>
                  <FieldDescription className="col-start-2 col-end-4 line-clamp-2">
                    {rule.text}
                  </FieldDescription>
                </Field>
              );
            })}
          </FieldGroup>
        </CollapsibleContent>
      </Collapsible>
    );
  },
);

import { memo } from "react";
import { Plus, Trash2 } from "lucide-react";
import { MarkdownEditor } from "../../MarkdownEditor";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { RuleCategory, RuleDefinition } from "./types";
import { slugifyRuleId } from "./ruleUtils";

const TIER_LABELS = {
  1: "1 — Never break",
  2: "2 — Required",
  3: "3 — Default",
  4: "4 — Suggested",
} as const;

export const RuleEditor = memo(function RuleEditor({
  rule,
  categories,
  availableRules,
  onChange,
  onDelete,
  showCategory = true,
}: {
  rule: RuleDefinition;
  categories: RuleCategory[];
  availableRules: RuleDefinition[];
  onChange: (rule: RuleDefinition) => void;
  onDelete: () => void;
  showCategory?: boolean;
}) {
  const ownRef = rule.category ? `${rule.category}/${rule.id}` : null;
  const overrideOptions = availableRules.filter(
    (candidate) =>
      candidate.category && `${candidate.category}/${candidate.id}` !== ownRef,
  );
  const updateText = (text: string) => {
    onChange({
      ...rule,
      text,
      id: rule.id || slugifyRuleId(text.split(/\s+/).slice(0, 7).join(" ")),
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-md border border-input p-3">
      <FieldGroup className="gap-3">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_10rem_10rem_auto]">
          {showCategory ? (
            <Field>
              <FieldLabel>Category</FieldLabel>
              <Select
                value={rule.category ?? null}
                onValueChange={(value) =>
                  onChange({ ...rule, category: String(value) })
                }
                items={Object.fromEntries(
                  categories.map((category) => [category.id, category.title]),
                )}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {categories.map((category) => (
                      <SelectItem key={category.id} value={category.id}>
                        {category.title}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <div />
          )}
          <Field>
            <FieldLabel>Tier</FieldLabel>
            <Select
              value={String(rule.tier)}
              onValueChange={(value) =>
                onChange({
                  ...rule,
                  tier: Number(value) as RuleDefinition["tier"],
                })
              }
              items={TIER_LABELS}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {([1, 2, 3, 4] as const).map((tier) => (
                    <SelectItem key={tier} value={String(tier)}>
                      {TIER_LABELS[tier]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Rule id</FieldLabel>
            <Input
              value={rule.id}
              onChange={(event) =>
                onChange({ ...rule, id: slugifyRuleId(event.target.value) })
              }
              placeholder="generated_from_text"
              className="font-mono"
            />
          </Field>
          <Field className="justify-end">
            <FieldLabel className="sr-only">Delete rule</FieldLabel>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={onDelete}
              aria-label="Delete rule"
            >
              <Trash2 />
            </Button>
          </Field>
        </div>

        <Field>
          <FieldLabel>Rule text</FieldLabel>
          <MarkdownEditor
            ariaLabel={`${rule.id || "new"} rule text`}
            value={rule.text}
            onChange={updateText}
            minRows={4}
            maxRows={12}
          />
        </Field>

        {overrideOptions.length > 0 ? (
          <Field>
            <FieldLabel>Overrides</FieldLabel>
            <Popover>
              <PopoverTrigger
                className={buttonVariants({
                  variant: "secondary",
                  className: "w-full justify-between font-normal",
                })}
              >
                Choose rules
                <span className="font-mono text-xs text-muted-foreground">
                  {rule.overrides?.length ?? 0} selected
                </span>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-[32rem] max-w-[90vw] gap-2 p-2"
              >
                <FieldDescription>
                  Rules superseded when both are selected.
                </FieldDescription>
                <div className="grid max-h-64 gap-2 overflow-y-auto p-1 md:grid-cols-2">
                  {overrideOptions.map((candidate) => {
                    const ref = `${candidate.category}/${candidate.id}`;
                    return (
                      <Field key={ref} orientation="horizontal">
                        <Checkbox
                          id={`override-${rule.id}-${ref}`}
                          checked={rule.overrides?.includes(ref) ?? false}
                          onCheckedChange={(checked) =>
                            onChange({
                              ...rule,
                              overrides: checked
                                ? [...(rule.overrides ?? []), ref]
                                : (rule.overrides ?? []).filter(
                                    (value) => value !== ref,
                                  ),
                            })
                          }
                        />
                        <FieldLabel
                          htmlFor={`override-${rule.id}-${ref}`}
                          className="font-mono text-xs font-normal"
                        >
                          {ref}
                        </FieldLabel>
                      </Field>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
          </Field>
        ) : null}

        <Separator />
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">Worked examples</p>
            <p className="text-xs text-muted-foreground">
              Each example has explicit framing and a quoted body.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onChange({
                ...rule,
                examples: [
                  ...(rule.examples ?? []),
                  { description: "", text: "" },
                ],
              })
            }
          >
            <Plus data-icon="inline-start" />
            Add example
          </Button>
        </div>
        {(rule.examples ?? []).map((example, index) => (
          <div key={index} className="grid gap-2 rounded-md bg-muted/40 p-2">
            <div className="flex gap-2">
              <Input
                value={example.description}
                onChange={(event) =>
                  onChange({
                    ...rule,
                    examples: rule.examples?.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, description: event.target.value }
                        : item,
                    ),
                  })
                }
                placeholder="Condition or context for this example"
                aria-label={`Example ${index + 1} description`}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Delete example ${index + 1}`}
                onClick={() =>
                  onChange({
                    ...rule,
                    examples: rule.examples?.filter(
                      (_, itemIndex) => itemIndex !== index,
                    ),
                  })
                }
              >
                <Trash2 />
              </Button>
            </div>
            <MarkdownEditor
              ariaLabel={`Example ${index + 1} body`}
              value={example.text}
              onChange={(text) =>
                onChange({
                  ...rule,
                  examples: rule.examples?.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, text } : item,
                  ),
                })
              }
              minRows={3}
              maxRows={8}
            />
          </div>
        ))}
      </FieldGroup>
    </div>
  );
});

import { memo } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { RuleCategory } from "./types";
import { slugifyRuleId } from "./ruleUtils";

export const CategoryEditor = memo(function CategoryEditor({
  category,
  onChange,
  onDelete,
}: {
  category: RuleCategory;
  onChange: (category: RuleCategory) => void;
  onDelete: () => void;
}) {
  return (
    <div className="grid items-end gap-2 rounded-md border border-input p-2 md:grid-cols-[12rem_1fr_2fr_6rem_auto]">
      <Field>
        <FieldLabel>Id</FieldLabel>
        <Input
          className="font-mono"
          value={category.id}
          onChange={(event) =>
            onChange({ ...category, id: slugifyRuleId(event.target.value) })
          }
          placeholder="from_title"
        />
      </Field>
      <Field>
        <FieldLabel>Title</FieldLabel>
        <Input
          value={category.title}
          onChange={(event) =>
            onChange({
              ...category,
              title: event.target.value,
              id: category.id || slugifyRuleId(event.target.value),
            })
          }
        />
      </Field>
      <Field>
        <FieldLabel>Description</FieldLabel>
        <Input
          value={category.description}
          onChange={(event) =>
            onChange({ ...category, description: event.target.value })
          }
        />
      </Field>
      <Field>
        <FieldLabel>Order</FieldLabel>
        <Input
          type="number"
          value={category.order}
          onChange={(event) =>
            onChange({ ...category, order: Number(event.target.value) })
          }
        />
      </Field>
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={onDelete}
        aria-label={`Delete ${category.title || "category"}`}
      >
        <Trash2 />
      </Button>
    </div>
  );
});

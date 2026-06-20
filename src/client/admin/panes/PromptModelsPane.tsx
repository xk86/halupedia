import { memo } from "react";
import { Pane } from "../Pane";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface PromptModelAssociation {
  key: string;
  model: "heavy" | "light";
  modelName: string;
  baseUrl: string;
  thinking: boolean;
}

interface Props {
  associations: PromptModelAssociation[];
  savingKey: string | null;
  onUpdate: (key: string, model: "heavy" | "light", thinking: boolean) => void;
}

function PromptModelsPaneComponent({
  associations,
  savingKey,
  onUpdate,
}: Props) {
  return (
    <Pane
      id="prompt-models"
      title="Prompt Models"
      count={`${associations.length} prompts`}
      wide
    >
      {associations.length ? (
        <Table className="text-xs [&_td]:px-1.5 [&_td]:py-1 [&_th]:h-7 [&_th]:px-1.5">
          <TableHeader>
            <TableRow>
              <TableHead>Prompt</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Thinking</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {associations.map((item) => (
              <TableRow key={item.key}>
                <TableCell className="font-mono">{item.key}</TableCell>
                <TableCell>
                  <Select
                    value={item.model}
                    disabled={savingKey !== null}
                    onValueChange={(v) =>
                      onUpdate(item.key, v as "heavy" | "light", item.thinking)
                    }
                  >
                    <SelectTrigger size="sm" className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="heavy">heavy</SelectItem>
                      <SelectItem value="light">light</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell title={item.baseUrl}>{item.modelName}</TableCell>
                <TableCell>
                  <label className="flex items-center gap-1.5 font-mono text-[0.78rem] text-ink uppercase">
                    <Checkbox
                      checked={item.thinking}
                      disabled={savingKey !== null}
                      onCheckedChange={(c) =>
                        onUpdate(item.key, item.model, c === true)
                      }
                    />
                    {item.thinking ? "on" : "off"}
                  </label>
                </TableCell>
                <TableCell className="font-mono">
                  {savingKey === item.key ? "saving" : "saved"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="sb-copy">No prompt model configuration found.</p>
      )}
    </Pane>
  );
}

export const PromptModelsPane = memo(PromptModelsPaneComponent);

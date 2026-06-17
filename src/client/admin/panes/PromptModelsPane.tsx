import { Pane } from "../Pane";
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

export function PromptModelsPane({ associations, savingKey, onUpdate }: Props) {
  return (
    <Pane
      id="prompt-models"
      title="Prompt Models"
      count={`${associations.length} prompts`}
      wide
    >
      {associations.length ? (
        <Table>
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
                  <select
                    className="admin-model-select"
                    value={item.model}
                    disabled={savingKey !== null}
                    onChange={(e) =>
                      onUpdate(
                        item.key,
                        e.target.value as "heavy" | "light",
                        item.thinking,
                      )
                    }
                  >
                    <option value="heavy">heavy</option>
                    <option value="light">light</option>
                  </select>
                </TableCell>
                <TableCell title={item.baseUrl}>{item.modelName}</TableCell>
                <TableCell>
                  <label className="admin-thinking-toggle">
                    <input
                      type="checkbox"
                      checked={item.thinking}
                      disabled={savingKey !== null}
                      onChange={(e) =>
                        onUpdate(item.key, item.model, e.target.checked)
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

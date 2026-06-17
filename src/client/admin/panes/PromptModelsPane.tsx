import { Pane } from "../Pane";
import { AdminTable } from "../AdminTable";

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
        <AdminTable>
          <thead>
            <tr>
              <th>Prompt</th>
              <th>Role</th>
              <th>Model</th>
              <th>Thinking</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {associations.map((item) => (
              <tr key={item.key}>
                <td>{item.key}</td>
                <td>
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
                </td>
                <td title={item.baseUrl}>{item.modelName}</td>
                <td>
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
                </td>
                <td>{savingKey === item.key ? "saving" : "saved"}</td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      ) : (
        <p className="sb-copy">No prompt model configuration found.</p>
      )}
    </Pane>
  );
}

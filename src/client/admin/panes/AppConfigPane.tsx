import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { RotateCcw, Save } from "lucide-react";
import { Pane } from "../Pane";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
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
import { Slider } from "@/components/ui/slider";

type ConfigValue = string | number | boolean;
type FieldKind = "boolean" | "number" | "string" | "select" | "secret";

interface ConfigField {
  table: string;
  key: string;
  label: string;
  description: string;
  kind: FieldKind;
  value: ConfigValue;
  configured: boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  restartRequired?: boolean;
}

interface ConfigSection {
  id: string;
  title: string;
  description: string;
  fields: ConfigField[];
}

interface ConfigPayload {
  sections: ConfigSection[];
}

const fieldPath = (field: ConfigField) => `${field.table}.${field.key}`;

function valuesFromPayload(
  payload: ConfigPayload,
): Record<string, ConfigValue> {
  return Object.fromEntries(
    payload.sections.flatMap((section) =>
      section.fields.map((field) => [fieldPath(field), field.value]),
    ),
  );
}

function AppConfigPaneComponent() {
  const [payload, setPayload] = useState<ConfigPayload | null>(null);
  const [values, setValues] = useState<Record<string, ConfigValue>>({});
  const [savedValues, setSavedValues] = useState<Record<string, ConfigValue>>(
    {},
  );
  const [busySection, setBusySection] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/config");
      const next = (await response.json()) as ConfigPayload & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(next.error ?? `HTTP ${response.status}`);
      const nextValues = valuesFromPayload(next);
      setPayload(next);
      setValues(nextValues);
      setSavedValues(nextValues);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirtyPaths = useMemo(
    () =>
      new Set(
        Object.keys(values).filter(
          (path) => values[path] !== savedValues[path],
        ),
      ),
    [savedValues, values],
  );

  const saveSection = useCallback(
    async (section: ConfigSection) => {
      const updates = section.fields
        .filter((field) => dirtyPaths.has(fieldPath(field)))
        .map((field) => ({
          path: fieldPath(field),
          value: values[fieldPath(field)],
        }));
      if (updates.length === 0) return;
      setBusySection(section.id);
      setMessage(null);
      try {
        const response = await fetch("/api/admin/config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates }),
        });
        const result = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        if (!response.ok)
          throw new Error(result.error ?? `HTTP ${response.status}`);
        await load();
        setMessage(`${section.title} saved and runtime reloaded.`);
      } catch (saveError) {
        setError(
          saveError instanceof Error ? saveError.message : String(saveError),
        );
      } finally {
        setBusySection(null);
      }
    },
    [dirtyPaths, load, values],
  );

  const resetSection = useCallback(
    (section: ConfigSection) => {
      setValues((current) => {
        const next = { ...current };
        for (const field of section.fields)
          next[fieldPath(field)] = savedValues[fieldPath(field)];
        return next;
      });
    },
    [savedValues],
  );

  return (
    <Pane
      id="app-config"
      title="Application configuration"
      description="Every runtime app.toml setting. Model roles, hosts, prompts, and image generation keep their richer editors in the Models and Prompts tabs."
      count={
        payload
          ? `${payload.sections.reduce((count, section) => count + section.fields.length, 0)} settings`
          : "loading"
      }
    >
      {error ? <FieldError>{error}</FieldError> : null}
      {message ? (
        <p className="text-sm text-muted-foreground">{message}</p>
      ) : null}
      {!payload ? (
        <p className="text-sm text-muted-foreground">Loading configuration…</p>
      ) : (
        <div data-testid="config-sections" className="grid min-w-0 gap-3">
          {payload.sections.map((section) => {
            const sectionDirty = section.fields.some((field) =>
              dirtyPaths.has(fieldPath(field)),
            );
            return (
              <Card key={section.id} size="sm">
                <CardHeader>
                  <CardTitle>{section.title}</CardTitle>
                  <CardDescription>{section.description}</CardDescription>
                  <Badge variant={sectionDirty ? "default" : "outline"}>
                    {sectionDirty
                      ? "Unsaved"
                      : `${section.fields.length} settings`}
                  </Badge>
                </CardHeader>
                <CardContent className="min-w-0">
                  <FieldGroup
                    data-testid={`config-fields-${section.id}`}
                    className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-x-4 gap-y-3"
                  >
                    {section.fields.map((field) => (
                      <ConfigControl
                        key={fieldPath(field)}
                        field={field}
                        value={values[fieldPath(field)]}
                        onChange={(value) =>
                          setValues((current) => ({
                            ...current,
                            [fieldPath(field)]: value,
                          }))
                        }
                      />
                    ))}
                  </FieldGroup>
                </CardContent>
                <CardFooter className="justify-end gap-2 border-t">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!sectionDirty || busySection !== null}
                    onClick={() => resetSection(section)}
                  >
                    <RotateCcw data-icon="inline-start" />
                    Reset
                  </Button>
                  <Button
                    size="sm"
                    disabled={!sectionDirty || busySection !== null}
                    onClick={() => void saveSection(section)}
                  >
                    <Save data-icon="inline-start" />
                    {busySection === section.id ? "Saving…" : "Save section"}
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
    </Pane>
  );
}

function ConfigControl({
  field,
  value,
  onChange,
}: {
  field: ConfigField;
  value: ConfigValue;
  onChange: (value: ConfigValue) => void;
}) {
  const id = `config-${field.table}-${field.key}`.replaceAll(".", "-");
  if (field.kind === "boolean") {
    return (
      <Field orientation="horizontal" className="min-w-0 gap-2 self-start py-1">
        <Checkbox
          id={id}
          checked={Boolean(value)}
          onCheckedChange={(checked) => onChange(checked)}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <FieldLabel className="text-xs" htmlFor={id}>
            {field.label}
          </FieldLabel>
          <FieldDescription className="text-xs leading-snug">
            {field.description}
          </FieldDescription>
        </div>
      </Field>
    );
  }

  return (
    <Field className="min-w-0 gap-1.5 self-start">
      <div className="flex min-w-0 items-center gap-2">
        <FieldLabel className="min-w-0 text-xs" htmlFor={id}>
          {field.label}
        </FieldLabel>
        {field.restartRequired ? (
          <Badge variant="outline">Restart</Badge>
        ) : null}
      </div>
      <FieldDescription className="text-xs leading-snug">
        {field.description}
      </FieldDescription>
      {field.kind === "select" ? (
        <Select
          value={String(value)}
          onValueChange={(next) => onChange(next ?? "")}
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {field.options?.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : field.kind === "number" ? (
        <div className="flex min-w-0 items-center gap-2">
          {field.min !== undefined && field.max !== undefined ? (
            <Slider
              aria-label={field.label}
              value={[Number(value)]}
              min={field.min}
              max={field.max}
              step={field.step}
              onValueChange={(next) =>
                onChange(
                  typeof next === "number" ? next : (next[0] ?? field.min ?? 0),
                )
              }
            />
          ) : null}
          <Input
            id={id}
            className={
              field.min !== undefined && field.max !== undefined
                ? "w-24 shrink-0"
                : undefined
            }
            type="number"
            value={Number(value)}
            min={field.min}
            max={field.max}
            step={field.step}
            onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
          />
        </div>
      ) : (
        <Input
          id={id}
          type={field.kind === "secret" ? "password" : "text"}
          value={String(value)}
          placeholder={
            field.kind === "secret" && field.configured
              ? "Configured — enter to replace"
              : undefined
          }
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
    </Field>
  );
}

export const AppConfigPane = memo(AppConfigPaneComponent);

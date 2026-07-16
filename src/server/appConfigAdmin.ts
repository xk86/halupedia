import type { AppConfig } from "./types";
import { setTomlTableValue, type TomlValue } from "./tomlEdit";
import {
  CONFIG_DESCRIPTORS,
  CONFIG_SECTIONS,
  configFieldKind,
  type ConfigDescriptor,
  type ConfigFieldKind,
} from "./configSchema";

export type AppConfigFieldKind = ConfigFieldKind;

const UI_DESCRIPTORS = CONFIG_DESCRIPTORS.filter((descriptor) => descriptor.ui);

const FIELD_BY_PATH = new Map(
  UI_DESCRIPTORS.map((descriptor) => [`${descriptor.table}.${descriptor.key}`, descriptor]),
);

function valueAtPath(config: AppConfig, table: string, key: string): TomlValue {
  let value: unknown = config;
  for (const segment of table.split(".")) {
    value = (value as Record<string, unknown>)[segment];
  }
  return (value as Record<string, TomlValue>)[key];
}

export function appConfigAdminPayload(config: AppConfig) {
  return {
    sections: CONFIG_SECTIONS.map((section) => ({
      ...section,
      fields: UI_DESCRIPTORS.filter((descriptor) => descriptor.ui?.section === section.id).map(
        (descriptor) => {
          const kind = configFieldKind(descriptor);
          const value = valueAtPath(config, descriptor.table, descriptor.key);
          return {
            table: descriptor.table,
            key: descriptor.key,
            label: descriptor.ui!.label,
            description: descriptor.ui!.description,
            kind,
            min: descriptor.ui!.min,
            max: descriptor.ui!.max,
            step: descriptor.ui!.step,
            options: descriptor.ui!.options,
            restartRequired: descriptor.ui!.restartRequired,
            value: kind === "secret" ? "" : value,
            configured: kind === "secret" ? Boolean(value) : true,
          };
        },
      ),
    })),
  };
}

function normalizeValue(descriptor: ConfigDescriptor, path: string, value: unknown): TomlValue {
  const kind = configFieldKind(descriptor);
  if (kind === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
    return value;
  }
  if (kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
    const { min, max, step } = descriptor.ui ?? {};
    if (min !== undefined && value < min) throw new Error(`${path} must be at least ${min}`);
    if (max !== undefined && value > max) throw new Error(`${path} must be at most ${max}`);
    return step !== undefined && step >= 1 ? Math.floor(value) : value;
  }
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  if (kind === "select" && !descriptor.ui?.options?.includes(value)) throw new Error(`${path} is not an allowed option`);
  if (kind === "secret" && value.length === 0) throw new Error(`${path} cannot be blank`);
  return value;
}

export function updateAppConfigToml(source: string, path: string, value: unknown): string {
  const descriptor = FIELD_BY_PATH.get(path);
  if (!descriptor) throw new Error(`unknown app config field: ${path}`);

  const normalized = normalizeValue(descriptor, path, value);
  return setTomlTableValue(source, descriptor.table, descriptor.key, normalized);
}

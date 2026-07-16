import test from "node:test";
import assert from "node:assert/strict";
import { appConfigAdminPayload, updateAppConfigToml } from "../src/server/appConfigAdmin";
import { loadConfig } from "../src/server/config";
import { CONFIG_DESCRIPTORS, CONFIG_SECTIONS } from "../src/server/configSchema";

test("every UI config descriptor resolves against the loaded AppConfig and a known section", () => {
  const app = loadConfig().app as unknown as Record<string, unknown>;
  const sectionIds = new Set(CONFIG_SECTIONS.map((section) => section.id));

  for (const descriptor of CONFIG_DESCRIPTORS.filter((d) => d.ui)) {
    const table = descriptor.table
      .split(".")
      .reduce<unknown>((acc, segment) => (acc as Record<string, unknown> | undefined)?.[segment], app);
    assert.ok(
      table && typeof table === "object" && descriptor.key in (table as Record<string, unknown>),
      `${descriptor.table}.${descriptor.key} does not resolve against AppConfig`,
    );
    assert.ok(
      sectionIds.has(descriptor.ui!.section),
      `${descriptor.table}.${descriptor.key} references unknown section ${descriptor.ui!.section}`,
    );
  }
});

test("app config admin payload exposes every supported field and masks secrets", () => {
  const payload = appConfigAdminPayload(loadConfig().app);
  const fields = payload.sections.flatMap((section) => section.fields);

  assert.ok(fields.length >= 50);
  assert.equal(new Set(fields.map((field) => `${field.table}.${field.key}`)).size, fields.length);
  assert.equal(fields.find((field) => field.key === "llm_api_key")?.value, "");
  assert.equal(fields.find((field) => field.key === "llm_api_key")?.configured, true);
});

test("app config edits preserve surrounding TOML and validate types and ranges", () => {
  const source = [
    "# keep me",
    "[rag]",
    "min_score = 0.25 # old note",
    "",
    "[server]",
    "port = 8787",
    "",
  ].join("\n");

  const updated = updateAppConfigToml(source, "rag.min_score", 0.42);
  assert.match(updated, /^# keep me/m);
  assert.match(updated, /^min_score = 0.42$/m);
  assert.match(updated, /^port = 8787$/m);
  assert.throws(() => updateAppConfigToml(source, "rag.min_score", 2), /at most 1/);
  assert.throws(() => updateAppConfigToml(source, "rag.enabled", "yes"), /must be a boolean/);
  assert.throws(() => updateAppConfigToml(source, "rag.not_real", 1), /unknown app config field/);
});

test("app config select fields reject values outside their allowlist", () => {
  assert.throws(
    () => updateAppConfigToml("", "pipeline.trace.level", "everything"),
    /not an allowed option/,
  );
  assert.match(
    updateAppConfigToml("", "pipeline.trace.level", "debug"),
    /\[pipeline\.trace\]\nlevel = "debug"/,
  );
});

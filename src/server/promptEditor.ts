import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parse } from "smol-toml";
import { getPromptUsage } from "./promptUsage";
import { removeTomlTableKey, setTomlTableValue } from "./tomlEdit";
import type { RuleDef, RuleSpec, RuleTier } from "./rules/types";

function parseRulesField(raw: Record<string, unknown>): RuleSpec | undefined {
  const r = raw.rules as { include?: unknown; exclude?: unknown } | undefined;
  if (!r || !Array.isArray(r.include)) return undefined;
  const include = r.include.filter((v): v is string => typeof v === "string");
  const exclude = Array.isArray(r.exclude)
    ? r.exclude.filter((v): v is string => typeof v === "string")
    : undefined;
  return { include, ...(exclude && exclude.length > 0 ? { exclude } : {}) };
}

function parseLocalRulesField(raw: Record<string, unknown>): RuleDef[] | undefined {
  const entries = raw.local_rule as
    | Array<{ id?: unknown; tier?: unknown; text?: unknown; overrides?: unknown }>
    | undefined;
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  return entries
    .filter((e) => typeof e.id === "string" && typeof e.tier === "number" && typeof e.text === "string")
    .map((e) => ({
      id: e.id as string,
      tier: e.tier as RuleTier,
      text: e.text as string,
      ...(Array.isArray(e.overrides)
        ? { overrides: e.overrides.filter((v): v is string => typeof v === "string") }
        : {}),
    }));
}

// Matches a `key = """…"""` OR `key = '''…'''` multiline string assignment so a
// re-save can replace either quoting style in place.
const TRIPLE_QUOTE_RE = (key: string) =>
  new RegExp(`(^${key}\\s*=\\s*)("""[\\s\\S]*?"""|'''[\\s\\S]*?''')`, "m");

/**
 * Serialize an arbitrary string as a TOML multiline value. Prompts are plain
 * text and may contain backslashes, quotes, `{{vars}}`, JSON, etc. — none of
 * which we want TOML to reinterpret. A literal string (`'''…'''`) processes no
 * escapes, so it round-trips the bytes exactly; it's used whenever the text has
 * no `'''` delimiter. Otherwise we fall back to a basic string (`"""…"""`) and
 * escape backslashes and triple-quote runs. The result is therefore *always*
 * valid TOML regardless of the input.
 */
export function tomlMultilineValue(value: string): string {
  const body = value.replace(/\n+$/, "");
  if (!body.includes("'''")) {
    return `'''\n${body}\n'''`;
  }
  const escaped = body.replace(/\\/g, "\\\\").replace(/"""/g, '""\\"');
  return `"""\n${escaped}\n"""`;
}

export function replaceTomlTripleQuoted(
  source: string,
  key: string,
  value: string,
): string {
  const pattern = TRIPLE_QUOTE_RE(key);
  const replacement = `${key} = ${tomlMultilineValue(value)}`;
  if (pattern.test(source)) {
    return source.replace(pattern, replacement);
  }
  return `${source.trimEnd()}\n${replacement}\n`;
}

export interface PromptFileMeta {
  key: string;
  scope: "runnable" | "shared";
  description: string;
  usedBy: string[];
  model?: "heavy" | "light";
  thinking?: boolean;
  json?: boolean;
  hasModes: boolean;
}

export interface PromptFileContent extends PromptFileMeta {
  system: string;
  user: string;
  path: string;
  rules?: RuleSpec;
  /** Read-only in the admin editor for now — [[local_rule]] is an
   *  array-of-tables and setTomlTableValue only edits single tables. */
  localRules?: RuleDef[];
}

export interface ArticleImagePresetContent {
  key: string;
  label: string;
  selectionWhen?: string;
  recommendedAspectRatios: string[];
  allowText?: boolean;
  system: string;
  user: string;
  path: string;
  model?: "heavy" | "light";
  thinking?: boolean;
  json?: boolean;
}

const ROOT = process.cwd();
const PROMPT_DIR = resolve(ROOT, "config", "prompts");
const SHARED_DIR = resolve(PROMPT_DIR, "shared");
const ARTICLE_IMAGE_PRESET_DIR = resolve(PROMPT_DIR, "article_image_presets");

function promptDir(scope: "runnable" | "shared"): string {
  return scope === "shared" ? SHARED_DIR : PROMPT_DIR;
}

function safeKey(key: string): boolean {
  return /^[a-z0-9_]+$/i.test(key);
}

export function listPromptFiles(): { runnable: PromptFileMeta[]; shared: PromptFileMeta[] } {
  function readMeta(dir: string, scope: "runnable" | "shared"): PromptFileMeta[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".toml"))
      .sort()
      .map((file) => {
        const key = basename(file, ".toml");
        const raw = parse(readFileSync(resolve(dir, file), "utf8")) as Record<string, unknown>;
        const usage = getPromptUsage(scope, key);
        return {
          key,
          scope,
          ...usage,
          model: raw.model === "light" ? "light" : raw.model === "heavy" ? "heavy" : undefined,
          thinking: typeof raw.thinking === "boolean" ? raw.thinking : undefined,
          json: typeof raw.json === "boolean" ? raw.json : undefined,
          hasModes: typeof raw.modes === "object" && raw.modes !== null,
        };
      });
  }
  return {
    runnable: readMeta(PROMPT_DIR, "runnable"),
    shared: readMeta(SHARED_DIR, "shared"),
  };
}

export function readPromptFile(
  scope: "runnable" | "shared",
  key: string,
): PromptFileContent | null {
  if (!safeKey(key)) return null;
  const dir = promptDir(scope);
  const path = resolve(dir, `${key}.toml`);
  if (!existsSync(path)) return null;
  const raw = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const usage = getPromptUsage(scope, key);
  return {
    key,
    scope,
    ...usage,
    system: typeof raw.system === "string" ? raw.system : "",
    user: typeof raw.user === "string" ? raw.user : "",
    model: raw.model === "light" ? "light" : raw.model === "heavy" ? "heavy" : undefined,
    thinking: typeof raw.thinking === "boolean" ? raw.thinking : undefined,
    json: typeof raw.json === "boolean" ? raw.json : undefined,
    hasModes: typeof raw.modes === "object" && raw.modes !== null,
    path: `config/prompts${scope === "shared" ? "/shared" : ""}/${key}.toml`,
    rules: parseRulesField(raw),
    localRules: parseLocalRulesField(raw),
  };
}

export function writePromptFile(
  scope: "runnable" | "shared",
  key: string,
  system: string,
  user: string,
  rules?: RuleSpec,
): { error: string } | null {
  if (!safeKey(key)) return { error: "invalid key" };
  const dir = promptDir(scope);
  const path = resolve(dir, `${key}.toml`);
  if (!existsSync(path)) return { error: "prompt not found" };

  let source = readFileSync(path, "utf8");
  source = replaceTomlTripleQuoted(source, "system", system);
  source = replaceTomlTripleQuoted(source, "user", user);
  if (rules) {
    source = setTomlTableValue(source, "rules", "include", rules.include);
    source =
      rules.exclude && rules.exclude.length > 0
        ? setTomlTableValue(source, "rules", "exclude", rules.exclude)
        : removeTomlTableKey(source, "rules", "exclude");
  }
  writeFileSync(path, source);
  return null;
}

function readTomlPromptContent(path: string, key: string, displayPath: string): Omit<ArticleImagePresetContent, "label"> {
  const raw = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return {
    key,
    selectionWhen: typeof raw.selection_when === "string" ? raw.selection_when : undefined,
    recommendedAspectRatios: Array.isArray(raw.recommended_aspect_ratios)
      ? raw.recommended_aspect_ratios
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim().toLowerCase())
          .filter((value) => safeKey(value))
      : [],
    allowText: typeof raw.allow_text === "boolean" ? raw.allow_text : undefined,
    system: typeof raw.system === "string" ? raw.system : "",
    user: typeof raw.user === "string" ? raw.user : "",
    model: raw.model === "light" ? "light" : raw.model === "heavy" ? "heavy" : undefined,
    thinking: typeof raw.thinking === "boolean" ? raw.thinking : undefined,
    json: typeof raw.json === "boolean" ? raw.json : undefined,
    path: displayPath,
  };
}

export function listArticleImagePresetFiles(): ArticleImagePresetContent[] {
  if (!existsSync(ARTICLE_IMAGE_PRESET_DIR)) return [];
  return readdirSync(ARTICLE_IMAGE_PRESET_DIR)
    .filter((f) => f.endsWith(".toml"))
    .sort()
    .map((file) => {
      const key = basename(file, ".toml");
      const path = resolve(ARTICLE_IMAGE_PRESET_DIR, file);
      return {
        ...readTomlPromptContent(path, key, `config/prompts/article_image_presets/${key}.toml`),
        label: key,
      };
    });
}

export function readArticleImagePresetFile(key: string): ArticleImagePresetContent | null {
  if (!safeKey(key) || key === "default" || key === "documentary_photo" || key === "article_image") return null;
  const path = resolve(ARTICLE_IMAGE_PRESET_DIR, `${key}.toml`);
  if (!existsSync(path)) return null;
  return {
    ...readTomlPromptContent(path, key, `config/prompts/article_image_presets/${key}.toml`),
    label: key,
  };
}

function writeTomlPromptFile(
  path: string,
  system: string,
  user: string,
  options: { model?: "heavy" | "light"; thinking?: boolean; json?: boolean; allowText?: boolean } = {},
): void {
  const source = [
    `model = "${options.model ?? "light"}"`,
    `thinking = ${options.thinking === true ? "true" : "false"}`,
    `json = ${options.json === true ? "true" : "false"}`,
    options.allowText === undefined ? "" : `allow_text = ${options.allowText ? "true" : "false"}`,
    "",
    `system = ${tomlMultilineValue(system)}`,
    "",
    `user = ${tomlMultilineValue(user)}`,
    "",
  ].join("\n");
  writeFileSync(path, source);
}

export function createArticleImagePresetFile(
  key: string,
  system: string,
  user: string,
  options: { model?: "heavy" | "light"; thinking?: boolean; json?: boolean; allowText?: boolean } = {},
): { error: string } | ArticleImagePresetContent {
  if (!safeKey(key)) return { error: "invalid key" };
  if (key === "default" || key === "documentary_photo" || key === "article_image") {
    return { error: "base image preset is reserved" };
  }
  mkdirSync(ARTICLE_IMAGE_PRESET_DIR, { recursive: true });
  const path = resolve(ARTICLE_IMAGE_PRESET_DIR, `${key}.toml`);
  if (existsSync(path)) return { error: "preset already exists" };
  writeTomlPromptFile(path, system, user, options);
  const created = readArticleImagePresetFile(key);
  return created ?? { error: "prompt was created but could not be read" };
}

export function writeArticleImagePresetFile(
  key: string,
  system: string,
  user: string,
): { error: string } | null {
  if (!safeKey(key)) return { error: "invalid key" };
  if (key === "default" || key === "documentary_photo" || key === "article_image") {
    return { error: "base image preset is edited through article_image" };
  }
  const path = resolve(ARTICLE_IMAGE_PRESET_DIR, `${key}.toml`);
  if (!existsSync(path)) return { error: "preset not found" };
  let source = readFileSync(path, "utf8");
  source = replaceTomlTripleQuoted(source, "system", system);
  source = replaceTomlTripleQuoted(source, "user", user);
  writeFileSync(path, source);
  return null;
}

export function deleteArticleImagePresetFile(key: string): { error: string } | null {
  if (!safeKey(key)) return { error: "invalid key" };
  if (key === "default" || key === "documentary_photo" || key === "article_image") {
    return { error: "base image preset cannot be deleted" };
  }
  const path = resolve(ARTICLE_IMAGE_PRESET_DIR, `${key}.toml`);
  if (!existsSync(path)) return { error: "preset not found" };
  unlinkSync(path);
  return null;
}

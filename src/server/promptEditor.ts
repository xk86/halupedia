import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parse } from "smol-toml";

const TRIPLE_QUOTE_RE = (key: string) =>
  new RegExp(`(^${key}\\s*=\\s*""")[\\s\\S]*?(""")`, "m");

export function replaceTomlTripleQuoted(
  source: string,
  key: string,
  value: string,
): string | null {
  if (value.includes('"""')) return null;
  const pattern = TRIPLE_QUOTE_RE(key);
  const replacement = `${key} = """\n${value}\n"""`;
  if (pattern.test(source)) {
    return source.replace(pattern, replacement);
  }
  return `${source.trimEnd()}\n${replacement}\n`;
}

export interface PromptFileMeta {
  key: string;
  scope: "runnable" | "shared";
  model?: "heavy" | "light";
  thinking?: boolean;
  json?: boolean;
  hasModes: boolean;
}

export interface PromptFileContent extends PromptFileMeta {
  system: string;
  user: string;
  path: string;
}

const ROOT = process.cwd();
const PROMPT_DIR = resolve(ROOT, "config", "prompts");
const SHARED_DIR = resolve(PROMPT_DIR, "shared");

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
        return {
          key,
          scope,
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
  return {
    key,
    scope,
    system: typeof raw.system === "string" ? raw.system : "",
    user: typeof raw.user === "string" ? raw.user : "",
    model: raw.model === "light" ? "light" : raw.model === "heavy" ? "heavy" : undefined,
    thinking: typeof raw.thinking === "boolean" ? raw.thinking : undefined,
    json: typeof raw.json === "boolean" ? raw.json : undefined,
    hasModes: typeof raw.modes === "object" && raw.modes !== null,
    path: `config/prompts${scope === "shared" ? "/shared" : ""}/${key}.toml`,
  };
}

export function writePromptFile(
  scope: "runnable" | "shared",
  key: string,
  system: string,
  user: string,
): { error: string } | null {
  if (!safeKey(key)) return { error: "invalid key" };
  const dir = promptDir(scope);
  const path = resolve(dir, `${key}.toml`);
  if (!existsSync(path)) return { error: "prompt not found" };

  let source = readFileSync(path, "utf8");
  const nextSystem = replaceTomlTripleQuoted(source, "system", system);
  if (nextSystem === null) return { error: 'system text must not contain """' };
  source = nextSystem;
  const nextUser = replaceTomlTripleQuoted(source, "user", user);
  if (nextUser === null) return { error: 'user text must not contain """' };
  writeFileSync(path, nextUser);
  return null;
}

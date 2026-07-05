import { jsonrepair } from "jsonrepair";
import type { PromptConfig } from "./types";

const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function getPrompt(config: PromptConfig, key: string) {
  const prompt = config.prompts[key];
  if (!prompt) {
    throw new Error(`missing prompt template: ${key}`);
  }
  return {
    system: resolveSharedRefs(prompt.system, config),
    user: resolveSharedRefs(prompt.user, config),
    model: prompt.model ?? "heavy",
    thinking: prompt.thinking ?? false,
    json: prompt.json ?? false,
  };
}

export function getSharedPrompt(config: PromptConfig, key: string) {
  const prompt = config.shared[key];
  if (!prompt) {
    throw new Error(`missing shared prompt template: ${key}`);
  }
  return {
    system: resolveSharedRefs(prompt.system, config),
    user: resolveSharedRefs(prompt.user, config),
  };
}

function resolveSharedRefs(
  template: string,
  config: PromptConfig,
  depth = 0,
): string {
  if (depth > 4) return template;
  const resolved = template.replace(TEMPLATE_RE, (match, ref: string) => {
    const shared = config.shared[ref];
    return shared ? shared.system : match;
  });
  return resolved !== template
    ? resolveSharedRefs(resolved, config, depth + 1)
    : resolved;
}

export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(TEMPLATE_RE, (_match, key: string) => {
    return vars[key] ?? "";
  });
}

/**
 * Strip a Markdown code fence from model output. Tolerates a *missing* closing
 * fence, which happens when the response is truncated (finish_reason=length)
 * mid-JSON — so the opening ```json is still removed and the body stays parseable.
 */
export function stripJsonFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?[ \t]*\r?\n?/i, "")
    .replace(/\r?\n?```$/, "")
    .trim();
}

/**
 * Parse model output that is meant to be JSON but frequently isn't quite:
 * fenced, truncated (finish_reason=length), or trailed by prose. Strips fences,
 * tries a strict parse, then falls back to `jsonrepair` — which closes open
 * strings/arrays/objects, salvaging the complete leading entries of a truncated
 * array. Returns `null` when nothing usable survives; callers MUST handle null
 * rather than let a parse error abort the whole operation.
 */
export function parseJsonLoose(raw: string): unknown {
  const text = stripJsonFences(raw);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Not strictly valid — try to repair (handles truncation + minor syntax).
  }
  try {
    return JSON.parse(jsonrepair(text));
  } catch {
    return null;
  }
}

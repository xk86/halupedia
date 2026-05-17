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
  };
}

function resolveSharedRefs(
  template: string,
  config: PromptConfig,
  depth = 0,
): string {
  if (depth > 4) return template;
  const resolved = template.replace(TEMPLATE_RE, (match, ref: string) => {
    const shared = config.prompts[ref];
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

const JSON_FENCE_RE = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/;

export function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const match = JSON_FENCE_RE.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

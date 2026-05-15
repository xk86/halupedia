import type { PromptConfig } from "./types";

export function getPrompt(config: PromptConfig, key: string) {
  const prompt = config.prompts[key];
  if (!prompt) {
    throw new Error(`missing prompt template: ${key}`);
  }
  return prompt;
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    return vars[key] ?? "";
  });
}

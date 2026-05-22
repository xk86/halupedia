/**
 * Centralized prompt registry.
 *
 * Wraps the existing TOML-based prompt config in a LangChain
 * `ChatPromptTemplate` so:
 *
 *   - Templates are loaded once, hashed, and exposed by name.
 *   - Rendering a template returns the system+user text along with the
 *     template hash and a render hash — both stored in the trace so we
 *     can detect prompt drift across model versions.
 *   - Application code (workflow nodes) constructs the *variable bag*;
 *     templates themselves stay dumb — no conditionals, no helpers,
 *     just `{{var}}` interpolation as today.
 *
 * The runtime contract: `getRegistry(config).render(key, vars)` returns
 * a `RenderedPrompt` shaped exactly like the `state.renderedPrompt`
 * field so a render-node can write it straight into the pipeline state.
 */

import { createHash } from "node:crypto";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { PromptConfig, PromptTemplate } from "../../types";
import type { RenderedPrompt } from "../state";

export interface PromptEntry {
  key: string;
  /** The originating PromptTemplate record (after shared-ref resolution). */
  resolved: PromptTemplate;
  /** ChatPromptTemplate; usable directly with LangChain runnables. */
  template: ChatPromptTemplate;
  /** Content hash of the resolved system+user text (template version id). */
  hash: string;
}

export interface PromptRegistry {
  list(): string[];
  get(key: string): PromptEntry;
  /**
   * Render `key` with the given variable bag. Returns a value shaped like
   * `PipelineState.renderedPrompt` so it can be written directly to state.
   */
  render(
    key: string,
    variables: Record<string, unknown>,
  ): RenderedPrompt;
}

/**
 * Build a registry from the already-loaded prompt config. Cheap and pure;
 * call once per workflow run or cache at the application level.
 */
export function buildPromptRegistry(config: PromptConfig): PromptRegistry {
  const entries = new Map<string, PromptEntry>();

  for (const [key, prompt] of Object.entries(config.prompts)) {
    const resolved = resolveSharedRefs(prompt, config);
    const hash = hashTemplate(resolved);
    // LangChain expects `{var}` not `{{var}}`. We adopt a thin pre-conversion:
    // any `{{name}}` becomes `{name}` (LC syntax) and any literal `{`/`}` is
    // escaped. This keeps the existing TOML format unchanged.
    const lcSystem = toLangchainSyntax(resolved.system);
    const lcUser = toLangchainSyntax(resolved.user);
    const template = ChatPromptTemplate.fromMessages([
      ["system", lcSystem],
      ["user", lcUser],
    ]);
    entries.set(key, { key, resolved, template, hash });
  }

  return {
    list() {
      return [...entries.keys()].sort();
    },
    get(key) {
      const entry = entries.get(key);
      if (!entry) {
        throw new Error(`prompt registry: unknown key '${key}'`);
      }
      return entry;
    },
    render(key, variables) {
      const entry = entries.get(key);
      if (!entry) {
        throw new Error(`prompt registry: unknown key '${key}'`);
      }
      // Use a plain string-interpolation path so we keep the existing
      // `{{var}}` semantics (missing → empty string) instead of LC's stricter
      // behavior. The ChatPromptTemplate above is exposed for callers that
      // want to use LC runnables directly; `render` is the boring path that
      // matches today's `renderTemplate` from prompts.ts.
      const system = interpolate(entry.resolved.system, variables);
      const user = interpolate(entry.resolved.user, variables);
      const renderedHash = createHash("sha256")
        .update(`${system}\n---\n${user}`)
        .digest("hex")
        .slice(0, 16);
      return {
        key,
        templateHash: entry.hash,
        role: entry.resolved.model === "light" ? "light" : "heavy",
        system,
        user,
        renderedHash,
        variables: variables as Record<string, unknown>,
        thinking: entry.resolved.thinking ?? false,
        json: entry.resolved.json ?? false,
      };
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function interpolate(
  template: string,
  variables: Record<string, unknown>,
): string {
  return template.replace(TEMPLATE_RE, (_match, key: string) => {
    const v = variables[key];
    if (v == null) return "";
    return typeof v === "string" ? v : String(v);
  });
}

function resolveSharedRefs(
  prompt: PromptTemplate,
  config: PromptConfig,
  depth = 0,
): PromptTemplate {
  if (depth > 4) return prompt;
  const next: PromptTemplate = {
    system: substituteShared(prompt.system, config),
    user: substituteShared(prompt.user, config),
    model: prompt.model,
    thinking: prompt.thinking,
    json: prompt.json,
  };
  if (next.system === prompt.system && next.user === prompt.user) return next;
  return resolveSharedRefs(next, config, depth + 1);
}

function substituteShared(text: string, config: PromptConfig): string {
  return text.replace(TEMPLATE_RE, (match, ref: string) => {
    const shared = config.shared[ref];
    return shared ? shared.system : match;
  });
}

function hashTemplate(prompt: PromptTemplate): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        system: prompt.system,
        user: prompt.user,
        model: prompt.model ?? "heavy",
        thinking: prompt.thinking ?? false,
        json: prompt.json ?? false,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * Translate `{{var}}` into LangChain's `{var}` (and escape literal braces).
 * Used only when constructing the ChatPromptTemplate; the boring `render`
 * path keeps the original `{{var}}` syntax verbatim.
 */
function toLangchainSyntax(input: string): string {
  // Escape any single braces that are not part of a `{{var}}` pair.
  const escaped = input
    .replace(/\{(?!\{)/g, "{{")
    .replace(/(?<!\})\}/g, "}}");
  // Now convert our `{{var}}` (which became `{{{{var}}}}` after the escape)
  // back into LC's `{var}`.
  return escaped.replace(/\{\{\{\{\s*([a-zA-Z0-9_]+)\s*\}\}\}\}/g, "{$1}");
}

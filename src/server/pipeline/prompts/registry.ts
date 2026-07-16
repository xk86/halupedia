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
import { assembleRules } from "../../rules/assemble";
import { buildRulesPromptTrace, type RulesPromptTrace } from "../../rules/trace";

export interface PromptEntry {
  key: string;
  /** The originating PromptTemplate record (after shared-ref *and* rules
   *  resolution — `{{rules}}` is already replaced with assembled text). */
  resolved: PromptTemplate;
  /** Shared-ref-resolved but *before* `{{rules}}` substitution. Kept around
   *  so `render()` can recompute the rules block for a prompt whose rule
   *  selection varies per call (see `RenderRuntimeOptions.extraInclude`)
   *  without re-running shared-ref resolution. */
  baseResolved: PromptTemplate;
  /** ChatPromptTemplate; usable directly with LangChain runnables. */
  template: ChatPromptTemplate;
  /** Content hash of the resolved system+user text *and* the resolved rule
   *  set (template version id) — see `hashTemplate`. */
  hash: string;
  /** Set only for prompts that declare `[rules]`/local rules. */
  rulesTrace?: RulesPromptTrace;
}

export interface RenderRuntimeOptions {
  /** Extra rule selectors resolved together with the prompt's static
   *  `[rules].include` in one combined `assembleRules` pass — for rules
   *  that vary per render call (e.g. full vs. partial rewrite scope) rather
   *  than per prompt. Runs override/dedupe resolution and produces one
   *  unified `rulesTrace` across the static and per-call rules, instead of
   *  splicing in a second, untracked block of rule text. */
  extraInclude?: string[];
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
    runtimeOptions?: RenderRuntimeOptions,
  ): RenderedPrompt;
}

/**
 * Build a registry from the already-loaded prompt config. Cheap and pure;
 * call once per workflow run or cache at the application level.
 */
export function buildPromptRegistry(config: PromptConfig): PromptRegistry {
  const entries = new Map<string, PromptEntry>();

  for (const [key, prompt] of Object.entries(config.prompts)) {
    const baseResolved = resolveSharedRefs(prompt, config);
    let resolved = baseResolved;

    // Most prompts' `[rules]`/local rules don't vary by render-time
    // variables, so this default assembly is resolved once here rather than
    // per-render. A prompt whose rule selection *does* vary per call (e.g.
    // full vs. partial rewrite scope) passes `extraInclude` to `render()`,
    // which recomputes from `baseResolved` instead of reusing this.
    let rulesTrace: RulesPromptTrace | undefined;
    let rulesHash: string | undefined;
    if (prompt.rules || prompt.localRules) {
      const assembled = assembleRules(config.ruleLibrary, prompt.rules ?? { include: [] }, {
        localRules: prompt.localRules,
        promptKey: key,
      });
      resolved = {
        ...resolved,
        system: substituteRules(resolved.system, assembled.text),
        user: substituteRules(resolved.user, assembled.text),
      };
      rulesTrace = buildRulesPromptTrace(assembled, key);
      rulesHash = assembled.hash;
    }

    const hash = hashTemplate(resolved, rulesHash);
    // LangChain expects `{var}` not `{{var}}`. We adopt a thin pre-conversion:
    // any `{{name}}` becomes `{name}` (LC syntax) and any literal `{`/`}` is
    // escaped. This keeps the existing TOML format unchanged.
    const lcSystem = toLangchainSyntax(resolved.system);
    const lcUser = toLangchainSyntax(resolved.user);
    const template = ChatPromptTemplate.fromMessages([
      ["system", lcSystem],
      ["user", lcUser],
    ]);
    entries.set(key, { key, resolved, baseResolved, template, hash, rulesTrace });
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
    render(key, variables, runtimeOptions) {
      const entry = entries.get(key);
      if (!entry) {
        throw new Error(`prompt registry: unknown key '${key}'`);
      }

      let resolved = entry.resolved;
      let rulesTrace = entry.rulesTrace;
      let templateHash = entry.hash;
      if (runtimeOptions?.extraInclude?.length) {
        const prompt = config.prompts[key];
        const spec = {
          include: [...(prompt?.rules?.include ?? []), ...runtimeOptions.extraInclude],
          exclude: prompt?.rules?.exclude,
        };
        const assembled = assembleRules(config.ruleLibrary, spec, {
          localRules: prompt?.localRules,
          promptKey: key,
        });
        resolved = {
          ...entry.baseResolved,
          system: substituteRules(entry.baseResolved.system, assembled.text),
          user: substituteRules(entry.baseResolved.user, assembled.text),
        };
        rulesTrace = buildRulesPromptTrace(assembled, key);
        templateHash = hashTemplate(resolved, assembled.hash);
      }

      // Use a plain string-interpolation path so we keep the existing
      // `{{var}}` semantics (missing → empty string) instead of LC's stricter
      // behavior. The ChatPromptTemplate above is exposed for callers that
      // want to use LC runnables directly; `render` is the boring path that
      // matches today's `renderTemplate` from prompts.ts.
      const system = interpolate(resolved.system, variables);
      const user = interpolate(resolved.user, variables);
      const renderedHash = createHash("sha256")
        .update(`${system}\n---\n${user}`)
        .digest("hex")
        .slice(0, 16);
      return {
        key,
        templateHash,
        role: resolved.model === "light" ? "light" : "heavy",
        system,
        user,
        renderedHash,
        variables: variables as Record<string, unknown>,
        thinking: resolved.thinking ?? false,
        json: resolved.json ?? false,
        rulesTrace,
      };
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const RULES_PLACEHOLDER_RE = /\{\{\s*rules\s*\}\}/g;

/** Replace the `{{rules}}` placeholder with the assembled rule text. Static —
 *  resolved once at registry-build time, unlike `{{var}}` template vars which
 *  are resolved per-render. */
function substituteRules(template: string, rulesText: string): string {
  return template.replace(RULES_PLACEHOLDER_RE, rulesText);
}

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

/**
 * `rulesHash` (the assembled rule set's own hash, see `assembleRules`) is
 * folded in alongside the static system/user text so that editing a rule in
 * `config/rules/*.toml` — which changes `prompt.system` only *after*
 * `{{rules}}` substitution, i.e. already reflected in `prompt.system` here —
 * is still visible as drift even though the *source* prompt file on disk
 * didn't change. Passing it explicitly (rather than relying on it already
 * being baked into `prompt.system`) keeps this hash meaningful even if a
 * future caller hashes the pre-substitution template.
 */
function hashTemplate(prompt: PromptTemplate, rulesHash?: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        system: prompt.system,
        user: prompt.user,
        model: prompt.model ?? "heavy",
        thinking: prompt.thinking ?? false,
        json: prompt.json ?? false,
        rulesHash,
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

import { jsonrepair } from "jsonrepair";
import type { PromptConfig } from "./types";
import type { Logger } from "./logger";
import { assembleRules } from "./rules/assemble";
import { buildRulesPromptTrace, type RulesPromptTrace } from "./rules/trace";

const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const RULES_PLACEHOLDER_RE = /\{\{\s*rules\s*\}\}/g;

/**
 * Non-pipeline call sites (e.g. `generateArticleSummary` in index.ts) don't
 * go through a workflow node, so they have no `pipeline_nodes` trace row to
 * attach a `rulesPromptTrace` to. Passing `logger` gets the assembled rule
 * set logged through the same `Logger` every other LLM call already uses
 * (see `llm.chat_request` in llm.ts) — the trace-DB path is for pipeline
 * callers, which get `rulesTrace` on the return value instead (see
 * `registry.ts`'s `render()` for the pipeline equivalent of this function).
 */
export function getPrompt(config: PromptConfig, key: string, logger?: Logger) {
  const prompt = config.prompts[key];
  if (!prompt) {
    throw new Error(`missing prompt template: ${key}`);
  }

  let rulesText = "";
  let rulesTrace: RulesPromptTrace | undefined;
  if (prompt.rules || prompt.localRules) {
    const assembled = assembleRules(config.ruleLibrary, prompt.rules ?? { include: [] }, {
      localRules: prompt.localRules,
      promptKey: key,
    });
    rulesText = assembled.text;
    rulesTrace = buildRulesPromptTrace(assembled, key);
    logger?.info("rules.assembled", {
      prompt: key,
      included: assembled.included.length,
      dropped: assembled.dropped.length,
      conflicts: assembled.conflicts.length,
      hash: assembled.hash,
    });
  }

  return {
    system: prompt.system.replace(RULES_PLACEHOLDER_RE, rulesText),
    user: prompt.user.replace(RULES_PLACEHOLDER_RE, rulesText),
    model: prompt.model ?? "heavy",
    thinking: prompt.thinking ?? false,
    json: prompt.json ?? false,
    rulesTrace,
  };
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
 * Repair LaTeX command backslashes that the model emitted without doubling.
 *
 * Inside a JSON string, `\text` / `\times` / `\tau` are *invalid* JSON: `\t` is
 * the tab escape, so strict `JSON.parse` silently yields a literal TAB + "ext"
 * (and `\neq` → newline, `\beta` → backspace, `\frac` → formfeed, `\rho` → CR).
 * Models routinely emit single-backslash TeX, so double any odd-length run of
 * backslashes that precedes a letter-word (a LaTeX-command shape) — an even run
 * is already a correctly-escaped literal backslash and is left as-is.
 *
 * This is lossy for a *genuine* control escape immediately followed by a word
 * (e.g. a real tab in `"\tafter"` becomes literal `\t`), so it is opt-in and
 * only used where values are short scientific tokens, never multi-line prose.
 */
function preserveLatexBackslashes(json: string): string {
  return json.replace(/(\\+)(?=[a-zA-Z]{2,})/g, (run) =>
    run.length % 2 === 1 ? run + "\\" : run,
  );
}

/**
 * Parse model output that is meant to be JSON but frequently isn't quite:
 * fenced, truncated (finish_reason=length), or trailed by prose. Strips fences,
 * tries a strict parse, then falls back to `jsonrepair` — which closes open
 * strings/arrays/objects, salvaging the complete leading entries of a truncated
 * array. Returns `null` when nothing usable survives; callers MUST handle null
 * rather than let a parse error abort the whole operation.
 *
 * Pass `preserveLatex` for payloads whose string values carry TeX (e.g. ontology
 * fact objects like `\text{SiO}_2`); see {@link preserveLatexBackslashes}. Leave
 * it off for prose/body payloads where `\n` legitimately means a newline.
 */
export function parseJsonLoose(
  raw: string,
  options: { preserveLatex?: boolean } = {},
): unknown {
  let text = stripJsonFences(raw);
  if (!text) return null;
  if (options.preserveLatex) text = preserveLatexBackslashes(text);
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

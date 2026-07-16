/**
 * Builds the `rulesPromptTrace` captured by render nodes — which rules were
 * assembled into a prompt, which were dropped by an `overrides`, and any
 * mutual-override conflicts. Mirrors `buildRagPromptTrace` in
 * `pipeline/ragTrace.ts`: the admin trace should show exactly what the model
 * received, not a reconstruction from the current (possibly since-edited)
 * rule library.
 */
import type { AssembledRules } from "./types";

export interface RulesPromptTrace {
  promptKey: string;
  included: AssembledRules["included"];
  dropped: AssembledRules["dropped"];
  conflicts: AssembledRules["conflicts"];
  tierCounts: AssembledRules["tierCounts"];
  hash: string;
}

export function buildRulesPromptTrace(
  assembled: AssembledRules,
  promptKey: string,
): RulesPromptTrace {
  return {
    promptKey,
    included: assembled.included,
    dropped: assembled.dropped,
    conflicts: assembled.conflicts,
    tierCounts: assembled.tierCounts,
    hash: assembled.hash,
  };
}

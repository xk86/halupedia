/**
 * Auto-review pass over one article's pending ontology suggestions.
 *
 * Deterministic format checks run first and always win (an item that trips
 * one is never sent to the model). Everything still eligible is presented to
 * the model in abstract "label: value" form — never JSON — one indexed line
 * per item, and the model returns a pass/fail verdict per item plus (when
 * present) the proposed entity-type change. Passing relation suggestions are
 * merged into the ontology; a passing type change is applied. Anything that
 * fails — deterministically or by the model — is left in place for manual
 * review; nothing here ever deletes a suggestion.
 */
import type { DatabaseSync } from "node:sqlite";
import type { LlmRouter } from "../llm";
import type { Logger } from "../logger";
import type { LlmInvocationMetadata, PromptConfig } from "../types";
import { getPrompt, parseJsonLoose, renderTemplate } from "../prompts";
import {
  applyOntologySuggestions,
  listOntologySuggestions,
  updateOntologySuggestionObject,
  type OntologySuggestion,
} from "./suggestions";
import {
  deleteOntologyTypeSuggestion,
  getOntologyTypeSuggestion,
} from "./suggestions";
import { listArticleEntityFacts, updateArticleEntityType } from "./store";
import type { OntologyVocabulary } from "./vocabulary";

export type ReviewVerdict = "pass" | "fail";

export interface OntologyReviewItemResult {
  id: number;
  label: string;
  object: string;
  verdict: ReviewVerdict;
  reason: string;
  source: "deterministic" | "llm";
}

export interface OntologyReviewTypeResult {
  suggestedType: string;
  verdict: ReviewVerdict;
  reason: string;
  source: "deterministic" | "llm";
}

export interface OntologyReviewResult {
  verdict: "pass" | "partial" | "fail";
  passed: number;
  failed: number;
  items: OntologyReviewItemResult[];
  type: OntologyReviewTypeResult | null;
}

export interface OntologyReviewCallInfo {
  /** False when every item was resolved deterministically (no model call). */
  called: boolean;
  durationMs: number;
  error?: Error;
  promptText?: string;
  responseText?: string;
  promptChars?: number;
  metadata?: LlmInvocationMetadata;
  thinking?: boolean;
  jsonMode?: boolean;
}

export interface OntologyReviewOptions {
  llm: LlmRouter;
  prompts: PromptConfig;
  vocab: OntologyVocabulary;
  logger?: Logger;
  /** Fail a relation whose label (predicate) exceeds this many words. */
  keyMaxWords: number;
  onReviewed?: (slug: string, info: OntologyReviewCallInfo) => void;
}

// A bare machine identifier leaking into a value slot instead of a
// human-readable value — e.g. "podal-mystique" or "podal_mystique" instead of
// "Podal Mystique". This is NOT the same thing as a real slug (this codebase's
// slugs are kebab-case only — see slug.ts); it also catches underscore-joined
// "title as URL" strings a model sometimes emits. Requires an actual separator
// so ordinary lowercase words ("unknown") don't false-positive. Auto-fixed
// rather than failed — see `humanizeMachineString` below.
const MACHINE_ID_RE = /^[a-z0-9]+([-_][a-z0-9]+)+$/;

/** Title-cases a machine-identifier-shaped string ("podal_mystique" ->
 *  "Podal Mystique"); returns null when `value` isn't shaped like one, so the
 *  caller can leave ordinary text untouched. */
function humanizeMachineString(value: string): string | null {
  const trimmed = value.trim();
  if (!MACHINE_ID_RE.test(trimmed)) return null;
  return trimmed
    .split(/[-_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function deterministicRelationFail(
  suggestion: OntologySuggestion,
  label: string,
  keyMaxWords: number,
): string | null {
  const object = suggestion.object.trim();
  if (!suggestion.subject.trim() || !label.trim() || !object) return "empty field";
  if (object.toLowerCase() === suggestion.subject.trim().toLowerCase()) {
    return "value equals the article's own title";
  }
  const wordCount = label.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount > keyMaxWords) return `label too long (${wordCount} words)`;
  return null;
}

function labelFor(vocab: OntologyVocabulary, predicate: string): string {
  return vocab.predicates.get(predicate)?.label ?? predicate.replace(/_/g, " ");
}

/** The model doesn't reliably stick to lowercase "pass"/"fail" (observed:
 *  "Pass", "PASS "); match case/whitespace-insensitively rather than treating
 *  every non-exact-match as a spurious fail. */
function isPassVerdict(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "pass";
}

// Small/local models routinely fail an item over concerns explicitly outside
// its remit, no matter how bluntly the prompt forbids it — negative
// instructions ("don't judge X") are unreliable on light local models. This
// review is meant to be a near-rubber-stamp (expect ~98% of well-formed facts
// to pass): format problems (slug-shape, length) are already deterministically
// cleared before an item reaches the model, and content plausibility
// ("is this a recognizable entity", "is this redundant/vague/unclear
// phrasing", "is this a duplicate") is simply not this review's job — the
// extraction step already vetted the fact against the article. A fail whose
// own stated reason falls into either bucket is the model overstepping, not a
// real problem: override it back to a pass rather than losing an otherwise-
// good fact to a hallucinated gate.
const OUT_OF_SCOPE_REASON_RE =
  /\b(slug|machine|identifier|url|too\s*long|overlong|length|redundant|duplicate|unclear|vague|ambigu\w*|generic|recogni[sz]\w*|(?:valid|real|plausible|legitimate)\s+(?:category|entity|concept|topic)|unclear\s+phrasing)\b/i;

function isOutOfScopeComplaint(reason: unknown): boolean {
  return typeof reason === "string" && OUT_OF_SCOPE_REASON_RE.test(reason);
}

export async function reviewArticleSuggestions(
  db: DatabaseSync,
  slug: string,
  options: OntologyReviewOptions,
): Promise<OntologyReviewResult> {
  const suggestions = listOntologySuggestions(db, slug);
  const typeSuggestion = getOntologyTypeSuggestion(db, slug);
  const { entity } = listArticleEntityFacts(db, slug);
  const currentType = entity?.entityType ?? "thing";
  const articleTitle = entity?.canonicalName ?? slug;

  const items: OntologyReviewItemResult[] = [];
  const eligible: Array<{ suggestion: OntologySuggestion; label: string }> = [];
  for (const suggestion of suggestions) {
    // Fix a machine-identifier-shaped value in place before anything else
    // evaluates it — a formatting artifact to repair, not a reason to fail.
    const humanized = humanizeMachineString(suggestion.object);
    if (humanized) {
      updateOntologySuggestionObject(db, suggestion.id, humanized);
      suggestion.object = humanized;
    }
    const label = labelFor(options.vocab, suggestion.predicate);
    const failReason = deterministicRelationFail(suggestion, label, options.keyMaxWords);
    if (failReason) {
      items.push({
        id: suggestion.id,
        label,
        object: suggestion.object,
        verdict: "fail",
        reason: failReason,
        source: "deterministic",
      });
    } else {
      eligible.push({ suggestion, label });
    }
  }

  let typeResult: OntologyReviewTypeResult | null = null;
  let typeEligible = false;
  if (typeSuggestion) {
    if (!options.vocab.entityTypes.has(typeSuggestion.suggestedType)) {
      typeResult = {
        suggestedType: typeSuggestion.suggestedType,
        verdict: "fail",
        reason: "type is no longer in the vocabulary",
        source: "deterministic",
      };
    } else if (typeSuggestion.suggestedType === currentType) {
      typeResult = {
        suggestedType: typeSuggestion.suggestedType,
        verdict: "fail",
        reason: "matches the current type",
        source: "deterministic",
      };
    } else {
      typeEligible = true;
    }
  }

  let callInfo: OntologyReviewCallInfo = { called: false, durationMs: 0 };
  if (eligible.length > 0 || typeEligible) {
    const itemsBlock = eligible
      .map((entry, i) => `${i + 1}. ${entry.label}: ${entry.suggestion.object}`)
      .join("\n");
    const typeChangeBlock = typeEligible
      ? `${currentType} -> ${typeSuggestion!.suggestedType}`
      : "(none)";
    const templateVars = {
      article_title: articleTitle,
      items: itemsBlock || "(none)",
      type_change: typeChangeBlock,
    };

    const startedAt = Date.now();
    let promptText: string | undefined;
    let responseText: string | undefined;
    let promptChars: number | undefined;
    let metadata: LlmInvocationMetadata | undefined;
    let resolvedRole: "heavy" | "light" = "light";
    let thinking: boolean | undefined;
    let jsonMode: boolean | undefined;
    let parsed: { items?: unknown; type?: unknown } | null = null;
    let callError: Error | undefined;
    try {
      const prompt = getPrompt(options.prompts, "ontology_review");
      resolvedRole = prompt.model === "heavy" ? "heavy" : "light";
      thinking = prompt.thinking;
      jsonMode = prompt.json;
      const systemPrompt = renderTemplate(prompt.system, templateVars);
      const userPrompt = renderTemplate(prompt.user, templateVars);
      promptText = `### System\n${systemPrompt}\n\n### User\n${userPrompt}`;
      promptChars = systemPrompt.length + userPrompt.length;
      metadata = options.llm.metadataFor?.(resolvedRole);
      const raw = await options.llm.chat(resolvedRole, systemPrompt, userPrompt, {
        thinking,
        jsonMode,
      });
      responseText = raw;
      parsed = parseJsonLoose(raw) as { items?: unknown; type?: unknown } | null;
      if (parsed === null) {
        options.logger?.warn?.("ontology.review_unparseable", { slug });
      }
    } catch (err) {
      callError = err instanceof Error ? err : new Error(String(err));
      options.logger?.warn?.("ontology.review_failed", { slug, error: callError.message });
    }
    callInfo = {
      called: true,
      durationMs: Date.now() - startedAt,
      error: callError,
      promptText,
      responseText,
      promptChars,
      metadata,
      thinking,
      jsonMode,
    };

    const verdictByIndex = new Map<number, { verdict: ReviewVerdict; reason: string }>();
    for (const raw of Array.isArray(parsed?.items) ? parsed!.items : []) {
      const entry = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const index = typeof entry.index === "number" ? entry.index : Number(entry.index);
      if (!Number.isInteger(index)) continue;
      const reason = typeof entry.reason === "string" ? entry.reason : "";
      if (isPassVerdict(entry.verdict)) {
        verdictByIndex.set(index, { verdict: "pass", reason });
      } else if (isOutOfScopeComplaint(reason)) {
        verdictByIndex.set(index, { verdict: "pass", reason: "out-of-scope concern overridden" });
      } else {
        verdictByIndex.set(index, { verdict: "fail", reason });
      }
    }
    eligible.forEach((entry, i) => {
      const modelVerdict = verdictByIndex.get(i + 1);
      items.push({
        id: entry.suggestion.id,
        label: entry.label,
        object: entry.suggestion.object,
        verdict: modelVerdict?.verdict ?? "fail",
        reason: modelVerdict?.reason || (callError ? "review call failed" : "no verdict returned"),
        source: "llm",
      });
    });

    if (typeEligible) {
      const rawType = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).type : undefined;
      const typeEntry = rawType && typeof rawType === "object" ? (rawType as Record<string, unknown>) : null;
      const modelReason =
        typeEntry && typeof typeEntry.reason === "string"
          ? typeEntry.reason
          : callError
            ? "review call failed"
            : "no verdict returned";
      let verdict: ReviewVerdict;
      let reason: string;
      if (isPassVerdict(typeEntry?.verdict)) {
        verdict = "pass";
        reason = modelReason;
      } else if (isOutOfScopeComplaint(modelReason)) {
        verdict = "pass";
        reason = "out-of-scope concern overridden";
      } else {
        verdict = "fail";
        reason = modelReason;
      }
      typeResult = { suggestedType: typeSuggestion!.suggestedType, verdict, reason, source: "llm" };
    }
  }

  const passedIds = items.filter((item) => item.verdict === "pass").map((item) => item.id);
  if (passedIds.length > 0) {
    applyOntologySuggestions(db, slug, "merge", passedIds);
  }
  if (typeResult?.verdict === "pass") {
    updateArticleEntityType(db, slug, typeResult.suggestedType);
    deleteOntologyTypeSuggestion(db, slug);
  }

  for (const item of items) {
    options.logger?.info?.("ontology.review_verdict", {
      slug,
      id: item.id,
      label: item.label,
      verdict: item.verdict,
      reason: item.reason,
      source: item.source,
    });
  }
  if (typeResult) {
    options.logger?.info?.("ontology.review_type_verdict", {
      slug,
      suggestedType: typeResult.suggestedType,
      verdict: typeResult.verdict,
      reason: typeResult.reason,
      source: typeResult.source,
    });
  }

  const passed = items.filter((i) => i.verdict === "pass").length + (typeResult?.verdict === "pass" ? 1 : 0);
  const failed = items.filter((i) => i.verdict === "fail").length + (typeResult?.verdict === "fail" ? 1 : 0);
  const verdict: OntologyReviewResult["verdict"] =
    failed === 0 ? "pass" : passed === 0 ? "fail" : "partial";

  options.onReviewed?.(slug, callInfo);

  return { verdict, passed, failed, items, type: typeResult };
}

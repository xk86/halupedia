/**
 * Auto-review pass over one article's pending ontology suggestions.
 *
 * Deterministic format checks run first and always win (an item that trips
 * one is never sent to the model). Everything still eligible is presented to
 * the model in abstract "label: value" form — never JSON — one indexed line
 * per item, alongside the article's own text, and the model returns a
 * pass/fail verdict per item plus (when present) the proposed entity-type
 * change. Beyond the format checks, the model's only job is grounding: is the
 * fact actually stated in the article, and does it describe the article's own
 * subject rather than some other entity the article merely mentions in
 * passing (see the prompt's "different entity" fail condition) — it is
 * explicitly not a taste/style/recognizability judge (see
 * `OUT_OF_SCOPE_REASON_RE` below). Passing relation suggestions are merged
 * into the ontology; a passing type change is applied. A failure is never
 * deleted, but it is marked settled so it stops being re-reviewed every
 * pass: a deterministic failure (malformed, clearly invalid) is marked
 * `discarded`; an LLM judgment-call failure is marked `human_review`
 * (still visible for a person to decide manually).
 */
import type { DatabaseSync } from "node:sqlite";
import { getArticle } from "../db";
import type { LlmRouter } from "../llm";
import type { Logger } from "../logger";
import type { LlmInvocationMetadata, PromptConfig } from "../types";
import { getPrompt, parseJsonLoose, renderTemplate } from "../prompts";
import {
  applyOntologySuggestions,
  listOntologySuggestions,
  setOntologySuggestionsStatus,
  updateOntologySuggestionObject,
  type OntologySuggestion,
} from "./suggestions";
import {
  deleteOntologyTypeSuggestion,
  getOntologyTypeSuggestion,
  setOntologyTypeSuggestionStatus,
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
// "title as URL" strings a model sometimes emits, whatever characters (word
// content, apostrophes, digits, ...) happen to sit between the separators. A
// string with any spaces is ordinary prose (a stray "-"/"_" in it is just
// markdown/emphasis) and is left alone; only hyphen/underscore-joined,
// space-free strings look machine-generated. Auto-fixed rather than failed —
// see `humanizeMachineString` below.
function looksLikeMachineId(value: string): boolean {
  return /[-_]/.test(value) && !/\s/.test(value);
}

/** Title-cases a machine-identifier-shaped string ("podal_mystique" ->
 *  "Podal Mystique"); returns null when `value` isn't shaped like one, so the
 *  caller can leave ordinary text untouched. */
function humanizeMachineString(value: string): string | null {
  const trimmed = value.trim();
  if (!looksLikeMachineId(trimmed)) return null;
  return trimmed
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function deterministicRelationFail(
  suggestion: OntologySuggestion,
  label: string,
  keyMaxWords: number,
  articleTitle: string,
): string | null {
  const object = suggestion.object.trim();
  if (!suggestion.subject.trim() || !label.trim() || !object) return "empty field";
  // Compare against the article's actual (authoritative) title, not the
  // fact's own extracted `subject` text — those two aren't always the same
  // string (a "Today's News: <date>" digest article's subject is often
  // recorded as just the bare date, e.g. for an `occurred_on` fact), and
  // comparing against the wrong one flags a perfectly legitimate fact as a
  // self-reference just because two unrelated strings happen to match.
  if (object.toLowerCase() === articleTitle.trim().toLowerCase()) {
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
// cleared before an item reaches the model, and taste/style plausibility
// ("is this a recognizable entity", "is this redundant/vague/unclear
// phrasing", "is this a duplicate") is simply not this review's job.
// Grounding — is the fact actually stated in the article, does it describe
// the article's own subject rather than some other entity mentioned in
// passing — IS the model's job and is deliberately excluded from this
// override; only the taste/style/format buckets above get auto-reversed. A
// fail whose own stated reason falls into one of those buckets is the model
// overstepping, not a real problem: override it back to a pass rather than
// losing an otherwise-good fact to a hallucinated gate.
const OUT_OF_SCOPE_REASON_RE =
  /\b(slug|machine|identifier|url|too\s*long|overlong|length|redundant|duplicate|unclear|vague|ambigu\w*|generic|recogni[sz]\w*|(?:valid|real|plausible|legitimate)\s+(?:category|entity|concept|topic)|unclear\s+phrasing)\b/i;

function isOutOfScopeComplaint(reason: unknown): boolean {
  return typeof reason === "string" && OUT_OF_SCOPE_REASON_RE.test(reason);
}

// The prompt's one narrow fail condition is "character-for-character
// identical to the article's own title" — but light models routinely fail
// this over a mere substring/containment relationship (the value is a date
// that also appears inside a longer title, say) rather than true equality.
// Since we can check the real strings ourselves, don't trust the model's
// characterization: only honor a title-equality fail when the value truly is
// the exact title, and override any other one back to a pass.
const OWN_TITLE_REASON_RE = /\b(identical\w*|equal\w*|equiv\w*|same|match\w*)\b.{0,40}\btitle\b/i;

function isFalseOwnTitleComplaint(reason: unknown, object: string, articleTitle: string): boolean {
  if (typeof reason !== "string" || !OWN_TITLE_REASON_RE.test(reason)) return false;
  return object.trim().toLowerCase() !== articleTitle.trim().toLowerCase();
}

export async function reviewArticleSuggestions(
  db: DatabaseSync,
  slug: string,
  options: OntologyReviewOptions,
): Promise<OntologyReviewResult> {
  // Only re-evaluate suggestions still awaiting a verdict — a discarded or
  // human_review fact is already settled and must not be re-sent to the
  // model just because this article has other, still-pending suggestions.
  const suggestions = listOntologySuggestions(db, slug).filter(
    (suggestion) => suggestion.status === "pending",
  );
  // A discarded or human_review type suggestion is already settled — like the
  // `pending`-only filter on facts above, it must not be re-evaluated (and
  // re-failed) on every pass just because the row is still there.
  const typeSuggestionRow = getOntologyTypeSuggestion(db, slug);
  const typeSuggestion = typeSuggestionRow?.status === "pending" ? typeSuggestionRow : null;
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
    const failReason = deterministicRelationFail(suggestion, label, options.keyMaxWords, articleTitle);
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
    // Grounding text for the two content checks below (unsupported-by-text,
    // misattributed-to-another-entity) — same cap `deriveLlmExtraction` uses
    // for the extraction prompt's article body.
    const article = getArticle(db, slug);
    const articleBody = (article?.markdown || article?.plain_text || "").slice(0, 12000);
    const templateVars = {
      article_title: articleTitle,
      article_body: articleBody || "(article text unavailable)",
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
        // See llmExtract.ts's identical comment: metadataFor above only
        // reflects the configured primary host, not the one dispatch
        // actually picked among fallback candidates.
        onHostAssigned: (hostId) => {
          if (metadata) metadata = { ...metadata, host: hostId };
        },
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

    const rawByIndex = new Map<number, { verdict: unknown; reason: string }>();
    for (const raw of Array.isArray(parsed?.items) ? parsed!.items : []) {
      const entry = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const index = typeof entry.index === "number" ? entry.index : Number(entry.index);
      if (!Number.isInteger(index)) continue;
      const reason = typeof entry.reason === "string" ? entry.reason : "";
      rawByIndex.set(index, { verdict: entry.verdict, reason });
    }
    const verdictByIndex = new Map<number, { verdict: ReviewVerdict; reason: string }>();
    eligible.forEach((entry, i) => {
      const modelRaw = rawByIndex.get(i + 1);
      if (!modelRaw) return;
      if (isPassVerdict(modelRaw.verdict)) {
        verdictByIndex.set(i + 1, { verdict: "pass", reason: modelRaw.reason });
      } else if (isOutOfScopeComplaint(modelRaw.reason)) {
        verdictByIndex.set(i + 1, { verdict: "pass", reason: "out-of-scope concern overridden" });
      } else if (isFalseOwnTitleComplaint(modelRaw.reason, entry.suggestion.object, articleTitle)) {
        verdictByIndex.set(i + 1, { verdict: "pass", reason: "title-equality complaint overridden (not actually identical)" });
      } else {
        verdictByIndex.set(i + 1, { verdict: "fail", reason: modelRaw.reason });
      }
    });
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
  const discardedIds = items
    .filter((item) => item.verdict === "fail" && item.source === "deterministic")
    .map((item) => item.id);
  if (discardedIds.length > 0) {
    setOntologySuggestionsStatus(db, slug, "discarded", discardedIds);
  }
  const humanReviewIds = items
    .filter((item) => item.verdict === "fail" && item.source === "llm")
    .map((item) => item.id);
  if (humanReviewIds.length > 0) {
    setOntologySuggestionsStatus(db, slug, "human_review", humanReviewIds);
  }
  if (typeResult?.verdict === "pass") {
    updateArticleEntityType(db, slug, typeResult.suggestedType);
    deleteOntologyTypeSuggestion(db, slug);
  } else if (typeResult?.verdict === "fail") {
    // Mirror the fact handling above: a failure is never left `pending` —
    // that left the suggestion to be silently re-reviewed (and re-failed)
    // every single pass, forever. Settle it the same way: a deterministic
    // fail (bad vocab, no-op type) is discarded outright; an LLM judgment
    // call is kept visible for a human to decide.
    setOntologyTypeSuggestionStatus(
      db,
      slug,
      typeResult.source === "deterministic" ? "discarded" : "human_review",
    );
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

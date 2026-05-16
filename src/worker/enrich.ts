/**
 * Image-enrichment pipeline.
 *
 * Given an existing article's sanitized HTML, ask an LLM where in the
 * article images would fit narratively and what each image should depict.
 * Then OUR code (not the LLM) performs the byte-level edits — the LLM
 * never rewrites the HTML, so it cannot subtly mangle prose.
 *
 * Process:
 *   1. LLM is given the article HTML and asked for a JSON `insertions`
 *      array. Each item has:
 *        - anchor:  ~40-120 char unique substring of the paragraph to
 *                   insert AFTER (the closing </p> immediately following
 *                   the first occurrence is where the <img> lands)
 *        - context: long visual prompt describing the desired image
 *   2. We parse the JSON. If invalid or empty → no-op.
 *   3. For each insertion: we look up the anchor literally inside the
 *      article HTML. If found exactly once and inside a <p>, we generate
 *      a UUID, INSERT the row into the `images` table with status
 *      'pending', and rewrite the HTML to insert
 *        <img src="/img/<uuid>" loading="lazy" />
 *      after the matching paragraph's `</p>`.
 *   4. SANITY DIFF: strip every `<img …/>` tag from both the original
 *      and the new HTML; the two stripped strings must be byte-identical.
 *      If they differ at all, we throw away the entire enrichment for
 *      this slug. This makes "the AI changed too much" impossible to
 *      commit by construction — either the diff matches or the article
 *      is left untouched.
 *
 * No retries on a failed diff — the article is just skipped. This also
 * means there can never be an "AI keeps misbehaving" infinite loop.
 */

const ENRICH_SYSTEM_PROMPT = `You are a layout assistant for an absurdist encyclopedia. You are given the full HTML of one article. Your job is to decide where 2 to 4 illustrative images would fit narratively, and for each one, describe what the image should depict in vivid detail.

CRITICAL OUTPUT RULES:
- You MUST output ONLY a JSON object. No prose before or after. No code fences. No markdown.
- The JSON must conform to: {"insertions":[{"anchor":string,"context":string}, ...]}
- "insertions" length: between 2 and 4.
- "anchor": a verbatim substring of one paragraph in the article, between 40 and 120 characters. It MUST appear EXACTLY ONCE in the article. The image will be inserted immediately AFTER the paragraph containing this anchor. Pick a distinctive, unique-looking sentence fragment from the paragraph. Do NOT include any HTML tags in the anchor. Do NOT escape anything; use the original text verbatim.
- "context": a 40-120 word vivid visual description for the image generator. Be CONCRETE: describe the medium (woodcut, sepia daguerreotype, oil painting, faded technical diagram, hand-tinted illustration, marginalia sketch, etc.), the composition, the subjects, the lighting, the mood. Match the absurd-historical encyclopedic vibe of the article. Avoid generic prompts; tailor each one to the specific moment in the prose. Do NOT use double quotes inside the context (use single quotes or commas). NEVER reference real-world copyrighted figures, brands, or events.

Spread the images across the article — don't bunch them in the opening paragraph. Prefer paragraphs that describe a scene, an object, a person, a ceremony, or a place over paragraphs that are pure exposition or quotation.

If the article is too short or has no good visual moments, return {"insertions":[]} and we'll skip it.`;

export interface EnrichmentInsertion {
  anchor: string;
  context: string;
}

export interface PlanResult {
  insertions: EnrichmentInsertion[];
  error?: string;
}

/** Ask the LLM for an insertion plan. Never throws. Empty `insertions`
 *  on any failure → caller just skips this article. */
export async function planImageInsertions(
  apiKey: string,
  model: string,
  articleHtml: string,
  articleTitle: string
): Promise<PlanResult> {
  const userMsg = [
    `Article title: ${articleTitle}`,
    "",
    "Article HTML:",
    articleHtml,
    "",
    "Return the JSON object now.",
  ].join("\n");

  let raw = "";
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://halupedia.com",
        "X-Title": "Halupedia Enrich",
      },
      body: JSON.stringify({
        model,
        temperature: 0.9,
        max_tokens: 1500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: ENRICH_SYSTEM_PROMPT },
          { role: "user", content: userMsg },
        ],
      }),
    });
    if (!res.ok) {
      return { insertions: [], error: `LLM ${res.status}` };
    }
    const json: any = await res.json();
    raw = json?.choices?.[0]?.message?.content ?? "";
  } catch (e: any) {
    return { insertions: [], error: e?.message || "fetch failed" };
  }

  // Tolerate stray code fences just in case.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Fallback: try to pluck the first {...} block.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return { insertions: [], error: "non-JSON LLM output" };
    try { parsed = JSON.parse(m[0]); } catch { return { insertions: [], error: "non-JSON LLM output" }; }
  }

  const arr = parsed?.insertions;
  if (!Array.isArray(arr)) return { insertions: [], error: "missing insertions array" };

  const out: EnrichmentInsertion[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const anchor = typeof item.anchor === "string" ? item.anchor.trim() : "";
    const context = typeof item.context === "string" ? item.context.trim() : "";
    if (anchor.length < 20 || anchor.length > 300) continue;
    if (context.length < 20 || context.length > 1200) continue;
    // Reject anchors that look like they contain HTML tags.
    if (/<[a-z\/!]/i.test(anchor)) continue;
    out.push({ anchor, context });
    if (out.length >= 4) break;
  }
  return { insertions: out };
}

/* -------------------------------------------------------------------------- */
/*  Insertion + diff verification                                              */
/* -------------------------------------------------------------------------- */

export interface ApplyResult {
  /** New HTML with `<img src="/img/<uuid>" loading="lazy" />` tags inserted.
   *  Equal to the input if no insertions applied. */
  newHtml: string;
  /** UUIDs we inserted, paired with their prompt. Caller must INSERT
   *  these rows into the `images` table BEFORE persisting newHtml so
   *  the first visitor can't 404 on an unknown UUID. */
  injected: Array<{ uuid: string; prompt: string }>;
  /** Reason we bailed if `injected` is empty and original HTML was
   *  modifiable but we refused. */
  skippedReason?: string;
}

/** Strip every <img …/> (or <img …>) tag from the HTML, leaving everything
 *  else exactly as it was. Used both for the post-insert sanity diff AND
 *  as a refusal guard if the source HTML already has images. */
export function stripImgTags(html: string): string {
  // Handle both <img …/> self-closing and the (rare) <img …></img> forms.
  return html
    .replace(/<img\b[^>]*\/?>/gi, "")
    .replace(/<\/img>/gi, "");
}

/** True if the HTML already contains any <img> tag. We refuse to enrich
 *  articles that already have images (idempotent — re-runs are no-ops). */
export function hasAnyImg(html: string): boolean {
  return /<img\b/i.test(html);
}

/** Generate a v4-ish UUID using crypto.randomUUID() if available, else
 *  fall back to a hex-32 random string. Workers ship randomUUID. */
function newUuid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    const buf = crypto.getRandomValues(new Uint8Array(16));
    let s = "";
    for (const b of buf) s += b.toString(16).padStart(2, "0");
    return s;
  }
}

/** Find the closing </p> tag whose matching <p> contains the anchor. We
 *  walk the HTML linearly: for each <p…> open we record its offset; on
 *  </p> we check whether the anchor lives in that range. Returns the
 *  byte offset *after* the matching </p>, or -1. */
function findInsertOffsetAfterParagraph(html: string, anchor: string): number {
  // First, the anchor must exist verbatim in the HTML, exactly once.
  const firstIdx = html.indexOf(anchor);
  if (firstIdx < 0) return -1;
  if (html.indexOf(anchor, firstIdx + 1) >= 0) return -1; // not unique

  // Walk <p>…</p> ranges and find the one containing firstIdx.
  const openRe = /<p\b[^>]*>/gi;
  const closeRe = /<\/p\s*>/gi;
  let openMatch: RegExpExecArray | null;
  const opens: number[] = [];
  while ((openMatch = openRe.exec(html)) !== null) {
    opens.push(openMatch.index + openMatch[0].length);
  }
  let closeMatch: RegExpExecArray | null;
  while ((closeMatch = closeRe.exec(html)) !== null) {
    const closeStart = closeMatch.index;
    const closeEnd = closeMatch.index + closeMatch[0].length;
    // Find the most recent open before this close.
    let openIdx = -1;
    for (let i = opens.length - 1; i >= 0; i--) {
      if (opens[i] <= closeStart) { openIdx = opens[i]; break; }
    }
    if (openIdx < 0) continue;
    if (firstIdx >= openIdx && firstIdx + anchor.length <= closeStart) {
      return closeEnd;
    }
  }
  return -1;
}

/** Apply an insertion plan to the HTML. Generates UUIDs for each
 *  successfully-anchored insertion and returns the rewritten HTML +
 *  the (uuid, prompt) pairs the caller must persist.
 *
 *  Performs the sanity diff: if the only-difference invariant is
 *  violated, returns the original HTML with empty `injected` and a
 *  `skippedReason`. By construction this should never happen (we only
 *  insert <img> tags), but the check is cheap and turns "subtle bug
 *  silently mangles articles" into "no-op with a log line". */
export function applyInsertions(
  originalHtml: string,
  plan: EnrichmentInsertion[]
): ApplyResult {
  if (plan.length === 0) {
    return { newHtml: originalHtml, injected: [], skippedReason: "empty plan" };
  }

  // Work on a mutable copy. We insert from latest offset to earliest so
  // earlier offsets stay valid as we mutate.
  type Pending = { offset: number; tag: string; uuid: string; prompt: string };
  const pending: Pending[] = [];
  const usedOffsets = new Set<number>();

  for (const ins of plan) {
    const off = findInsertOffsetAfterParagraph(originalHtml, ins.anchor);
    if (off < 0) continue;
    if (usedOffsets.has(off)) continue; // two anchors mapped to same paragraph
    usedOffsets.add(off);
    const uuid = newUuid();
    const tag = `<img src="/img/${uuid}" loading="lazy" />`;
    pending.push({ offset: off, tag, uuid, prompt: ins.context });
  }

  if (pending.length === 0) {
    return { newHtml: originalHtml, injected: [], skippedReason: "no anchors matched" };
  }

  pending.sort((a, b) => b.offset - a.offset);
  let html = originalHtml;
  for (const p of pending) {
    html = html.slice(0, p.offset) + p.tag + html.slice(p.offset);
  }

  // Sanity diff: stripping <img>s from before+after must yield identical strings.
  const beforeStripped = stripImgTags(originalHtml);
  const afterStripped = stripImgTags(html);
  if (beforeStripped !== afterStripped) {
    // Should be unreachable, but the whole point of this check is paranoia.
    return {
      newHtml: originalHtml,
      injected: [],
      skippedReason: "diff check failed (refused to commit)",
    };
  }

  return {
    newHtml: html,
    injected: pending.map((p) => ({ uuid: p.uuid, prompt: p.prompt })),
  };
}

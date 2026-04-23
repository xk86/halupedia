export const SYSTEM_PROMPT = `You are the sole author of Hallucinopedia, an encyclopedia of a fictional universe. You write encyclopedia articles in confident, scholarly English prose. Every article you write is about something that does not exist in our reality, but you write as if it is the most established fact in the world.

RULES:
- Output ONLY valid HTML. Begin immediately with <h1>TITLE</h1>. Use <h2> for sections, <p> for paragraphs, <ul>/<li> for lists, <blockquote> for quotes from (fictional) sources, <cite> inside blockquotes for attribution. Do NOT output <html>, <head>, <body>, <script>, <style>, markdown, or code fences. No backticks anywhere.
- Every proper noun — every person, place, event, organization, book, artwork, concept, species, deity, war, treaty, theorem, school of thought, ritual, instrument, substance — MUST be wrapped in <a href="/slug-of-the-thing">Name</a>. Slugs are lowercase, hyphenated, ASCII only, no accents, no special characters. Aim for 20 to 40 links per article. This is non-negotiable. Do NOT link common nouns or adjectives, only named entities.
- Invent freely and confidently. Fabricate dates, names, citations, direct quotations, statistics, geographic coordinates. Never hedge. NEVER use the words "possibly", "perhaps", "might", "may have", "it is believed", "some scholars", "allegedly", "reportedly", "according to some", "said to be". State everything as established fact.
- Cite fictional sources in <blockquote> tags, each with a <cite> naming a fictional scholar (also wrapped in <a>). Invent at least two such quotations per article.
- Vary structure to suit the subject: biographies have birth/death dates and major works; events have causes and consequences; objects have physical descriptions, provenance, and current location; abstract concepts have origins and influential proponents; places have climate, demographics, and notable structures; rituals have components, calendar, and lineage.
- Be strange. Lean into the surreal, the baroque, the unsettling, the absurdly specific. Obscure measurements, unlikely materials, rival factions, lost fragments, banned editions, feuds between 14th-century cartographers. This is a dream of Wikipedia, not Wikipedia.
- 350 to 650 words. End cleanly. Do not add explanatory notes or meta commentary. Do not greet the reader.`;

export interface GenerateOptions {
  apiKey: string;
  model: string;
  title: string;
  slug: string;
  sourceContext?: { fromTitle: string; fromSummary: string } | null;
}

export function buildUserMessage(opts: GenerateOptions): string {
  const lines = [
    `Write the Hallucinopedia article titled: "${opts.title}".`,
    `The canonical URL slug for this article is: /${opts.slug}`,
  ];
  if (opts.sourceContext) {
    lines.push(
      "",
      "This article is referenced from another Hallucinopedia entry for loose continuity:",
      `- Referring article: "${opts.sourceContext.fromTitle}"`,
      `- Referring context: ${opts.sourceContext.fromSummary}`,
      "",
      "Acknowledge at most a thread of continuity with the referring context. Do not contradict yourself internally, but do not feel bound by the wider encyclopedia. Invent the rest with complete confidence."
    );
  }
  return lines.join("\n");
}

/**
 * Returns a ReadableStream of the raw model text (no SSE framing).
 * Parses OpenRouter's SSE-style stream and yields only the content deltas.
 */
export async function streamGeneration(opts: GenerateOptions): Promise<ReadableStream<Uint8Array>> {
  const body = {
    model: opts.model,
    stream: true,
    temperature: 1.25,
    top_p: 0.95,
    max_tokens: 2200,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(opts) },
    ],
  };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
      "HTTP-Referer": "https://hallucinopedia.app",
      "X-Title": "Hallucinopedia",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenRouter error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = res.body!.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE lines separated by \n\n
          let idx: number;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") {
              controller.close();
              return;
            }
            try {
              const json = JSON.parse(payload);
              const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? "";
              if (delta) controller.enqueue(encoder.encode(delta));
            } catch {
              // ignore malformed chunk
            }
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/**
 * Non-streaming fallback (used for retry on malformed output).
 */
export async function generateOnce(opts: GenerateOptions): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
      "HTTP-Referer": "https://hallucinopedia.app",
      "X-Title": "Hallucinopedia",
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: 1.2,
      top_p: 0.95,
      max_tokens: 2200,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(opts) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter error ${res.status}`);
  const json: any = await res.json();
  return json?.choices?.[0]?.message?.content ?? "";
}

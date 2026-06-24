import type { DatabaseSync } from "node:sqlite";
import type { loadConfig } from "./config";
import type { AppConfig } from "./types";
import {
  getArticleByLookup,
  listHomepageNewsSourceArticles,
  listHomepageNewsTemporalArticles,
  listHomepageNewsWeatherPlaceCandidates,
  removeArticleMedia,
  saveArticle,
  type HomepageNewsWeatherPlaceCandidate,
} from "./db";
import type { LlmRouter } from "./llm";
import type { Logger } from "./logger";
import {
  extractInternalLinks,
  firstParagraphMarkdownFromArticle,
  markdownToPlainText,
  normalizeMarkdown,
  renderMarkdown,
  stripTopLevelSections,
} from "./markdown";
import { getPrompt, renderTemplate } from "./prompts";
import { retrieveContext, type RetrievedSourceArticle } from "./retrieval";
import { slugify } from "./slug";
import type { HomepageNews } from "./types";
import {
  getWorldDate,
  todaysNewsSlug,
  todaysNewsTitle,
  type WorldDate,
} from "./worldClock";

type PromptConfig = ReturnType<typeof loadConfig>["prompts"];
type RuntimeConfig = ReturnType<typeof loadConfig>;

const TODAYS_NEWS_GENERATOR_VERSION = "1";

interface SourceArticle {
  slug: string;
  title: string;
  summaryMarkdown: string;
  markdown: string;
  generatedAt: number;
  reason?: string;
  score?: number;
}

export async function ensureTodaysNewsArticle(
  db: DatabaseSync,
  llm: LlmRouter,
  runtime: RuntimeConfig,
  logger?: Logger,
): Promise<HomepageNews | null> {
  const worldDate = getWorldDate(runtime.app);
  const slug = todaysNewsSlug(worldDate);
  const existing = getArticleByLookup(db, slug);
  let shouldReplaceHeadlineImage = false;
  if (existing) {
    const existingNews = homepageNewsFromMarkdown(slug, existing.markdown, worldDate);
    if (
      hasCanonicalNewsHeading(existing.markdown, worldDate)
      && hasLinkedHeadlineStories(existing.markdown)
      && hasLinkedBriefHeadings(existing.markdown)
      && hasNewsServiceSections(existing.markdown)
      && existingNews.headlines.length >= 3
    ) {
      return existingNews;
    }
    shouldReplaceHeadlineImage = true;
  }

  const sources = await buildTodaysNewsLoreSources(db, llm, runtime, worldDate, slug, logger);
  if (sources.length === 0) return null;

  const title = todaysNewsTitle(worldDate);
  const markdown = await generateTodaysNewsMarkdown(
    llm,
    runtime.prompts,
    worldDate,
    title,
    sources,
  );
  const weatherPlaces = listHomepageNewsWeatherPlaceCandidates(db, worldDate.endsAt, 96);
  const normalized = linkNewsHeadlines(
    normalizeNewsMarkdown(markdown, title, worldDate, sources, weatherPlaces),
    sources,
  );
  const article = {
    slug,
    canonicalSlug: slug,
    title,
    markdown: normalized,
    html: renderMarkdown(normalized),
    summaryMarkdown: firstParagraphMarkdownFromArticle(normalized),
    plain_text: markdownToPlainText(normalized),
    generated_at: Date.now(),
  };
  const links = extractInternalLinks(normalized);
  saveArticle(db, article, links, [slug], {
    operation: "todays-news",
    instructions: `Generated daily news for ${worldDate.label}`,
  });
  if (shouldReplaceHeadlineImage) {
    removeArticleMedia(db, slug, 1);
  }
  return homepageNewsFromMarkdown(slug, normalized, worldDate);
}

async function buildTodaysNewsLoreSources(
  db: DatabaseSync,
  llm: LlmRouter,
  runtime: RuntimeConfig,
  worldDate: WorldDate,
  slug: string,
  logger?: Logger,
): Promise<SourceArticle[]> {
  const bySlug = new Map<string, SourceArticle>();
  const addSource = (article: SourceArticle) => {
    const existing = bySlug.get(article.slug);
    if (!existing) {
      bySlug.set(article.slug, article);
      return;
    }
    const reasons = new Set([
      ...(existing.reason ?? "").split(", ").filter(Boolean),
      ...(article.reason ?? "").split(", ").filter(Boolean),
    ]);
    bySlug.set(article.slug, {
      ...existing,
      summaryMarkdown: longestUsefulText(existing.summaryMarkdown, article.summaryMarkdown),
      markdown: longestUsefulText(existing.markdown, article.markdown),
      reason: [...reasons].join(", "),
      score: Math.max(existing.score ?? 0, article.score ?? 0) || undefined,
    });
  };

  for (const article of listHomepageNewsTemporalArticles(
    db,
    worldDate.endsAt,
    buildTemporalSearchTerms(worldDate),
    16,
  )) {
    addSource({ ...article, reason: "date match" });
  }

  const ragSources = await retrieveNewsWorldStateSources(db, llm, runtime, worldDate, slug, logger);
  for (const source of ragSources) {
    const article = getArticleByLookup(db, source.slug);
    addSource({
      slug: source.slug,
      title: source.title,
      summaryMarkdown: source.content,
      markdown: article?.markdown ?? source.content,
      generatedAt: article?.generated_at ?? 0,
      reason: isGeneratedNewsSlug(source.slug)
        ? "RAG world-state match, prior generated news"
        : "RAG world-state match",
      score: source.score,
    });
  }

  for (const article of listHomepageNewsSourceArticles(db, worldDate.endsAt, 8)) {
    addSource({ ...article, reason: "recent canon" });
  }

  const sorted = [...bySlug.values()].sort((a, b) => {
    const priority = sourcePriority(b) - sourcePriority(a);
    if (priority !== 0) return priority;
    return b.generatedAt - a.generatedAt;
  });
  logger?.info("homepage.todays_news_lore_sources", {
    slug,
    sources: sorted.length,
    temporal: sorted.filter((source) => source.reason?.includes("date match")).length,
    rag: sorted.filter((source) => source.reason?.includes("RAG world-state match")).length,
    recent: sorted.filter((source) => source.reason?.includes("recent canon")).length,
    picked: sorted.slice(0, 20).map((source) => source.slug).join(", "),
  });
  return sorted.slice(0, 20);
}

async function retrieveNewsWorldStateSources(
  db: DatabaseSync,
  llm: LlmRouter,
  runtime: RuntimeConfig,
  worldDate: WorldDate,
  slug: string,
  logger?: Logger,
): Promise<RetrievedSourceArticle[]> {
  const rag = runtime.app.rag;
  const query = [
    `news for ${worldDate.label}`,
    `${worldDate.monthName} ${worldDate.year}`,
    `ongoing world state during ${worldDate.monthName} ${worldDate.year}`,
    "current conditions aftermath disaster war election law crisis climate darkness blocked sun ash famine evacuation rationing quarantine",
    "events that are still happening, effects that last weeks or months, public notices, government response, infrastructure disruption",
  ].join("\n");
  const packet = await retrieveContext(
    db,
    llm,
    slug,
    buildTemporalSearchTerms(worldDate),
    rag.enabled,
    rag.mode,
    Math.max(rag.max_results, 12),
    Math.min(rag.min_score, 0.18),
    runtime.llm.embeddings.enabled,
    logger,
    query,
    { enabled: rag.summary_cap_enabled, chars: Math.max(rag.summary_cap_chars, 2200) },
  );
  return packet.sourceArticles;
}

function buildTemporalSearchTerms(worldDate: WorldDate): string[] {
  return [
    worldDate.label,
    `${worldDate.monthName} ${worldDate.dayOfMonth}, ${worldDate.year}`,
    `${worldDate.monthName} ${worldDate.year}`,
    String(worldDate.year),
    `day ${worldDate.day}`,
    `world day ${worldDate.day}`,
    `absolute world day ${worldDate.day}`,
    "ongoing",
    "aftermath",
    "month",
    "weeks",
  ];
}

function sourcePriority(article: SourceArticle): number {
  let priority = 0;
  if (article.reason?.includes("date match")) priority += 4;
  if (article.reason?.includes("RAG world-state match")) priority += 3 + (article.score ?? 0);
  if (article.reason?.includes("recent canon")) priority += 1;
  if (isGeneratedNewsSlug(article.slug)) priority -= 5;
  return priority;
}

function isGeneratedNewsSlug(slug: string): boolean {
  return /^todays-news-day-\d{6}/.test(slug);
}

function longestUsefulText(a: string, b: string): string {
  return (b?.trim().length ?? 0) > (a?.trim().length ?? 0) ? b : a;
}

async function generateTodaysNewsMarkdown(
  llm: LlmRouter,
  promptConfig: PromptConfig,
  worldDate: WorldDate,
  title: string,
  sources: SourceArticle[],
): Promise<string> {
  const prompt = getPrompt(promptConfig, "todays_news");
  return llm.chat(
    prompt.model,
    prompt.system,
    renderTemplate(prompt.user, {
      news_title: title,
      world_date: worldDate.label,
      world_day: String(worldDate.day),
      world_year: String(worldDate.year),
      world_month: worldDate.monthName,
      day_of_month: String(worldDate.dayOfMonth),
      lore_source_count: String(sources.length),
      source_articles: formatSourceArticlesForPrompt(sources),
    }),
    { thinking: prompt.thinking, jsonMode: prompt.json },
  );
}

function formatSourceArticlesForPrompt(sources: SourceArticle[]): string {
  return sources
    .map((article, index) => {
      const excerpt = article.summaryMarkdown?.trim()
        || firstParagraphMarkdownFromArticle(article.markdown)
        || article.markdown.replace(/\s+/g, " ").trim().slice(0, 600);
      return [
        `${index + 1}. ${article.title} (halu:${article.slug})`,
        `   Why included: ${article.reason ?? "canon"}`,
        article.score !== undefined ? `   RAG score: ${article.score.toFixed(3)}` : "",
        `   Generated at: ${new Date(article.generatedAt).toISOString()}`,
        `   Lore excerpt: ${excerpt.slice(0, 900)}`,
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function normalizeNewsMarkdown(
  raw: string,
  title: string,
  worldDate: WorldDate,
  sources: SourceArticle[],
  weatherPlaces: HomepageNewsWeatherPlaceCandidate[],
): string {
  const withoutFences = raw
    .trim()
    .replace(/^```(?:markdown)?\s*\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();
  const normalized = normalizeMarkdown(withoutFences);
  const withTitle = /^#\s+/m.test(normalized)
    ? normalized.replace(/^#\s+.+$/m, `# ${title}`).trim()
    : `# ${title}\n\n${normalized}`.trim();
  const withoutInternalMarkers = withTitle
    .replace(/<!--\s*todays-news-generator-version:\s*[^>]+-->/g, "")
    .trim();
  const withoutContext = stripTopLevelSections(withoutInternalMarkers, [
    "Context",
    "Edition Context",
    "Travel & Infrastructure",
    "Public Notices",
    "Culture & Sport",
    "Science Desk",
    "Corrections & Continuity",
    "Markets",
    "Weather",
    "Sources",
    "Source Notes",
  ]);
  return ensureNewsServiceSections(withoutContext, worldDate, sources, weatherPlaces);
}

function ensureNewsServiceSections(
  markdown: string,
  worldDate: WorldDate,
  sources: SourceArticle[],
  weatherPlaces: HomepageNewsWeatherPlaceCandidate[],
): string {
  return normalizeMarkdown([
    markdown.trim(),
    buildTravelInfrastructureSection(worldDate, sources),
    buildPublicNoticesSection(worldDate, sources),
    buildCultureSportSection(worldDate, sources),
    buildScienceDeskSection(worldDate, sources),
    buildMarketsSection(worldDate, sources),
    buildWeatherSection(worldDate, sources, weatherPlaces),
    buildCorrectionsContinuitySection(worldDate, sources),
  ].join("\n\n"));
}

function buildTravelInfrastructureSection(worldDate: WorldDate, sources: SourceArticle[]): string {
  const hazard = weatherHazardFromSources(sources);
  const links = marketSourceLinks(sources);
  const source = links[0] ?? "active world-state reports";
  return [
    "## Travel & Infrastructure",
    "",
    "| Network | Status | Advisory |",
    "| --- | --- | --- |",
    `| Interregional transit | Watch | ${escapeTableCell(`Build extra time around ${source}.`)} |`,
    `| Ports and freight | Delayed | ${escapeTableCell(hazard.travel)} |`,
    `| Civic services | Strained | ${escapeTableCell(`Confirm local notices before relying on normal schedules for ${worldDate.label}.`)} |`,
  ].join("\n");
}

function buildPublicNoticesSection(worldDate: WorldDate, sources: SourceArticle[]): string {
  const links = marketSourceLinks(sources);
  const primary = links[0] ?? "the current world-state";
  const secondary = links[1] ?? "local authorities";
  return [
    "## Public Notices",
    "",
    `- Residents should preserve article-linked guidance around ${primary} until the next edition supersedes it.`,
    `- Offices, schools, and guild desks should check whether ${secondary} changes opening hours or reporting duties.`,
    `- This edition covers ${worldDate.label}; later consequences should not be treated as resolved without newer canon.`,
  ].join("\n");
}

function buildCultureSportSection(worldDate: WorldDate, sources: SourceArticle[]): string {
  const links = marketSourceLinks(sources);
  const primary = links[0] ?? "today's public mood";
  const secondary = links[1] ?? "regional venues";
  return [
    "## Culture & Sport",
    "",
    `- Event organizers are adjusting programs around ${primary}, favoring shorter schedules and easier evacuation plans.`,
    `- Clubs and leagues near ${secondary} are expected to publish same-day venue guidance before major gatherings.`,
    `- Broadcasters are giving lighter segments less airtime while the ${worldDate.label} news cycle remains condition-heavy.`,
  ].join("\n");
}

function buildScienceDeskSection(worldDate: WorldDate, sources: SourceArticle[]): string {
  const signal = weatherSignalFromSources(sources);
  const links = marketSourceLinks(sources);
  const secondary = links[1] ?? "parallel field reports";
  return [
    "## Science Desk",
    "",
    `- Researchers are comparing ${signal} against ${secondary} for signs of a longer-running pattern.`,
    "- Instrument readings should be treated as provisional when civic disruption, weather anomalies, or cosmological effects overlap.",
    `- The next useful measurement window closes with the ${worldDate.label} edition cycle.`,
  ].join("\n");
}

function buildCorrectionsContinuitySection(worldDate: WorldDate, sources: SourceArticle[]): string {
  const links = marketSourceLinks(sources);
  const primary = links[0] ?? "today's source packet";
  return [
    "## Corrections & Continuity",
    "",
    `No formal correction is posted for ${worldDate.label}. Continuity notes from ${primary} should be treated as current until a later edition or normal article update narrows the facts.`,
  ].join("\n");
}

function buildMarketsSection(worldDate: WorldDate, sources: SourceArticle[]): string {
  return [
    "## Markets",
    "",
    `Global desks closed mixed on ${worldDate.label}, with continuity-sensitive contracts moving around ${marketSignalFromSources(sources)}.`,
    "",
    "| Ticker | Stock or index | Move | Desk note |",
    "| --- | --- | ---: | --- |",
    ...buildMarketRows(worldDate, sources).map((row) => `| ${escapeTableCell(row.ticker)} | ${escapeTableCell(row.name)} | ${escapeTableCell(row.move)} | ${escapeTableCell(row.note)} |`),
  ].join("\n");
}

interface MarketRow {
  ticker: string;
  name: string;
  move: string;
  note: string;
}

interface MarketCandidate {
  name: string;
  slug: string;
  theme: string;
}

function buildMarketRows(worldDate: WorldDate, sources: SourceArticle[]): MarketRow[] {
  const picked = buildMarketCandidates(sources)
    .sort((a, b) => {
      const score = deterministicScore(`${worldDate.day}:${a.name}:${a.slug}`)
        - deterministicScore(`${worldDate.day}:${b.name}:${b.slug}`);
      if (score !== 0) return score;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 6);
  const usedTickers = new Set<string>();

  return picked.map((candidate, index) => {
    const ticker = uniqueTickerForMarket(candidate.name, usedTickers);
    const seed = deterministicScore(`${worldDate.day}:${ticker}:${candidate.name}`);
    const up = seed % 6 !== 0 && (seed + index) % 7 !== 0;
    const magnitude = ((seed % 87) + 12) / 10;
    const arrow = up ? "🟢 +" : "🔴 -";
    const linkedName = candidate.slug
      ? `[${candidate.name}](halu:${candidate.slug} "${candidate.name}")`
      : candidate.name;
    return {
      ticker,
      name: linkedName,
      move: `${arrow}${magnitude.toFixed(1)}%`,
      note: `${candidate.theme}; daily desk draw from active canon.`,
    };
  });
}

function buildMarketCandidates(sources: SourceArticle[]): MarketCandidate[] {
  const byName = new Map<string, MarketCandidate>();
  const add = (name: string, slug: string, theme: string) => {
    const normalized = normalizeMarketName(name);
    if (!isUsefulMarketName(normalized)) return;
    const key = normalized.toLowerCase();
    if (!byName.has(key)) byName.set(key, { name: normalized, slug, theme });
  };

  for (const source of sources) {
    add(source.title, source.slug, marketThemeFromSource(source));
    for (const place of extractPlaceCandidates(source.title)) {
      add(`${place} Exchange`, source.slug, `Regional exposure tied to ${source.title}`);
    }
    for (const topic of extractMarketTopics(source)) {
      add(topic, source.slug, `Sector pressure tied to ${source.title}`);
    }
  }

  if (byName.size < 6) {
    for (const source of sources) {
      add(`${source.title} Logistics`, source.slug, `Transport and supply contracts tied to ${source.title}`);
      add(`${source.title} Relief`, source.slug, `Emergency procurement tied to ${source.title}`);
      add(`${source.title} Futures`, source.slug, `Forward pricing tied to ${source.title}`);
      add(`${source.title} Bonds`, source.slug, `Continuity debt tied to ${source.title}`);
      if (byName.size >= 8) break;
    }
  }

  if (byName.size === 0) {
    add("Continuity Desk Futures", "", "Broad civic risk basket");
    add("Emergency Lighting Trust", "", "Household adaptation suppliers");
    add("Interregional Freight Notes", "", "Trade and transit exposure");
    add("Municipal Shelter Bonds", "", "Public response debt");
    add("Weather Risk Contracts", "", "Climate and travel disruption");
    add("Public Works Index", "", "Infrastructure repair basket");
  }

  return [...byName.values()];
}

function extractMarketTopics(source: SourceArticle): string[] {
  const haystack = `${source.title} ${source.summaryMarkdown} ${source.markdown}`;
  const topics: string[] = [];
  const topicPatterns = [
    [/ash|volcano|smoke|darkness|sun/i, "Ashmask and Emergency Lighting"],
    [/harbor|port|shipping|ferry|canal|freight|transit/i, "Interregional Freight"],
    [/school|classroom|university|archive|library/i, "Civic Knowledge Services"],
    [/moon|tide|ocean|shore|flood/i, "Tide and Shore Futures"],
    [/king|sponsor|burger|calendar|date rights/i, "Calendar Sponsorship Rights"],
    [/mask|medicine|quarantine|hospital|relief/i, "Public Health Relief"],
    [/lamp|battery|power|grid|lighting/i, "Emergency Power Grid"],
    [/court|law|vote|council|committee/i, "Civic Continuity Bonds"],
  ] as const;
  for (const [pattern, topic] of topicPatterns) {
    if (pattern.test(haystack)) topics.push(topic);
  }
  return topics;
}

function marketThemeFromSource(source: SourceArticle): string {
  const haystack = `${source.title} ${source.summaryMarkdown} ${source.markdown}`;
  if (/ash|volcano|smoke|darkness|sun/i.test(haystack)) return "Disaster adaptation and visibility trade";
  if (/harbor|port|shipping|ferry|canal|freight|transit/i.test(haystack)) return "Trade route and freight exposure";
  if (/court|law|vote|council|committee/i.test(haystack)) return "Institutional continuity trade";
  if (/moon|tide|ocean|shore|flood/i.test(haystack)) return "Shoreline and tide-risk exposure";
  if (/school|archive|library|university/i.test(haystack)) return "Public knowledge and staffing trade";
  return "Broad canon-sensitive basket";
}

function uniqueTickerForMarket(name: string, used: Set<string>): string {
  const base = tickerForMarketName(name);
  let ticker = base;
  let suffix = 2;
  while (used.has(ticker)) {
    ticker = `${base.slice(0, Math.max(1, 5 - String(suffix).length))}${suffix}`;
    suffix += 1;
  }
  used.add(ticker);
  return ticker;
}

function tickerForMarketName(name: string): string {
  const words = normalizeMarketName(name)
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !/^(THE|AND|OF|A|AN|IN|ON|FOR|TO|FROM|WITH|INDEX|EXCHANGE|FUTURES|BONDS|TRUST|RIGHTS|NOTES)$/.test(word));
  const acronym = words.map((word) => word[0]).join("").slice(0, 5);
  if (acronym.length >= 3) return acronym;
  const compact = words.join("").replace(/[AEIOU]/g, "").slice(0, 5);
  return (compact || words.join("").slice(0, 5) || "MKT").padEnd(3, "X").slice(0, 5);
}

function normalizeMarketName(name: string): string {
  return stripMarkdownInline(name)
    .replace(/\s+/g, " ")
    .replace(/^[,.;:!?]+|[,.;:!?]+$/g, "")
    .trim();
}

function isUsefulMarketName(name: string): boolean {
  return Boolean(name && !/^(Today|News|Report|The|A|An|Weather|Markets)$/i.test(name));
}

function marketSourceLinks(sources: SourceArticle[]): string[] {
  const picked = sources
    .slice(0, 6)
    .map((source) => source.title.trim() ? `[${source.title}](halu:${source.slug} "${source.title}")` : "")
    .filter(Boolean);
  return picked;
}

function marketSignalFromSources(sources: SourceArticle[]): string {
  const picked = marketSourceLinks(sources).slice(0, 3);
  if (picked.length === 0) return "general civic risk, infrastructure pressure, and household adaptation trades";
  return picked.join(", ");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function buildWeatherSection(
  worldDate: WorldDate,
  sources: SourceArticle[],
  weatherPlaces: HomepageNewsWeatherPlaceCandidate[],
): string {
  const location = pickWeatherLocation(sources, weatherPlaces, worldDate);
  const signal = weatherSignalFromSources(sources);
  const hazard = weatherHazardFromSources(sources);
  return [
    "## Weather",
    "",
    `**Weather desk: ${location}**`,
    "",
    "| Metric | Report |",
    "| --- | --- |",
    `| Sky | ${hazard.sky} |`,
    `| Temperature | ${hazard.temperature} |`,
    `| Visibility | ${hazard.visibility} |`,
    `| Travel advisory | ${hazard.travel} |`,
    `| Canon driver | ${signal} |`,
    "",
    `Forecast confidence is moderate: this is an inferred local report for a daily lore-city draw, built from the active world conditions in today's lore packet rather than a separate meteorological archive.`,
  ].join("\n");
}

function weatherSignalFromSources(sources: SourceArticle[]): string {
  const source = sources.find((item) => /ash|sun|storm|rain|snow|heat|cold|fog|smoke|flood|tide|moon|volcano|weather/i.test(`${item.title} ${item.summaryMarkdown} ${item.markdown}`))
    ?? sources[0];
  if (!source) return "the active world-state rather than ordinary seasonal averages";
  return `[${source.title}](halu:${source.slug} "${source.title}")`;
}

function weatherHazardFromSources(sources: SourceArticle[]) {
  const haystack = sources.map((source) => `${source.title} ${source.summaryMarkdown} ${source.markdown}`).join("\n").toLowerCase();
  if (/ash|volcano|smoke|blocked the sun|darkness/.test(haystack)) {
    return {
      sky: "Ash-dimmed overcast with artificial-light glare.",
      temperature: "Below seasonal baseline under reduced sunlight.",
      visibility: "Poor; masks and lamp discipline advised.",
      travel: "Surface travel delayed by dust, darkness, and filter shortages.",
    };
  }
  if (/moon|tide|flood|shore|harbor|sea|ocean/.test(haystack)) {
    return {
      sky: "Broken cloud over unstable coastal air.",
      temperature: "Mild but rapidly shifting near exposed water.",
      visibility: "Fair inland, poor along spray-heavy waterfronts.",
      travel: "Harbor schedules and low-lying routes remain unreliable.",
    };
  }
  if (/heat|fire|sun|drought/.test(haystack)) {
    return {
      sky: "Hard bright haze with heat shimmer.",
      temperature: "Above seasonal baseline.",
      visibility: "Fair, degrading near dust and heat-plume corridors.",
      travel: "Outdoor work should rotate crews and preserve water reserves.",
    };
  }
  if (/snow|cold|ice|freeze/.test(haystack)) {
    return {
      sky: "Low gray ceiling with intermittent frozen precipitation.",
      temperature: "Below freezing in exposed districts.",
      visibility: "Variable; ice haze near transit corridors.",
      travel: "Delays expected on bridges, stairs, ramps, and unheated platforms.",
    };
  }
  return {
    sky: "Variable cloud with localized anomalies.",
    temperature: "Near the inferred seasonal baseline.",
    visibility: "Generally fair, with disruptions near headline-affected districts.",
    travel: "Allow extra time around civic, infrastructure, and emergency-response zones.",
  };
}

function pickWeatherLocation(
  sources: SourceArticle[],
  weatherPlaces: HomepageNewsWeatherPlaceCandidate[],
  worldDate: WorldDate,
): string {
  const lorePlaces = weatherPlaces
    .map((place) => ({
      name: normalizeWeatherPlaceName(place.name),
      slug: place.slug,
      weight: place.sourceKind === "article" ? 2 : 1,
    }))
    .filter((place) => isUsefulWeatherPlace(place.name));
  const fallbackPlaces = sources
    .flatMap((source) => extractPlaceCandidates(source.title).map((name) => ({
      name: normalizeWeatherPlaceName(name),
      slug: source.slug,
      weight: 0,
    })))
    .filter((place) => isUsefulWeatherPlace(place.name));
  const byName = new Map<string, { name: string; slug: string; weight: number }>();
  for (const place of [...lorePlaces, ...fallbackPlaces]) {
    const key = place.name.toLowerCase();
    const existing = byName.get(key);
    if (!existing || place.weight > existing.weight) byName.set(key, place);
  }
  const candidates = [...byName.values()];
  if (candidates.length === 0) return "the lead district";
  candidates.sort((a, b) => {
    const score = deterministicScore(`${worldDate.day}:${a.name}:${a.slug}`) - deterministicScore(`${worldDate.day}:${b.name}:${b.slug}`);
    if (score !== 0) return score;
    return a.name.localeCompare(b.name);
  });
  const picked = candidates[0];
  return picked.slug
    ? `[${picked.name}](halu:${picked.slug} "${picked.name}")`
    : picked.name;
}

function extractPlaceCandidates(title: string): string[] {
  const candidates: string[] = [];
  for (const match of title.matchAll(/\b(?:in|of|at|near|across|under|above)\s+([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,3})/g)) {
    candidates.push(match[1].trim());
  }
  for (const match of title.matchAll(/\b[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,2}\b/g)) {
    const value = match[0].trim();
    if (!/^(Today|News|Report|The|A|An)$/i.test(value)) candidates.push(value);
  }
  return candidates;
}

function normalizeWeatherPlaceName(name: string): string {
  return name
    .replace(/\s+/g, " ")
    .replace(/^[,.;:!?]+|[,.;:!?]+$/g, "")
    .trim();
}

function isUsefulWeatherPlace(name: string): boolean {
  return Boolean(name && !/^(Today|News|Report|The|A|An|Weather|Markets)$/i.test(name));
}

function deterministicScore(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function homepageNewsFromMarkdown(
  slug: string,
  markdown: string,
  worldDate: WorldDate,
): HomepageNews {
  return {
    slug,
    title: todaysNewsTitle(worldDate),
    worldDate: worldDate.label,
    worldDay: worldDate.day,
    generatorVersion: hasLinkedHeadlineStories(markdown) ? TODAYS_NEWS_GENERATOR_VERSION : undefined,
    summaryMarkdown: firstParagraphMarkdownFromArticle(markdown),
    headlines: extractHeadlines(markdown),
  };
}

export function isCurrentHomepageNews(
  news: Pick<HomepageNews, "slug" | "title" | "worldDate" | "generatorVersion"> | null | undefined,
  app: AppConfig,
  now?: number,
): boolean {
  if (!news) return false;
  const worldDate = getWorldDate(app, now);
  return (
    news.slug === todaysNewsSlug(worldDate)
    && news.title === todaysNewsTitle(worldDate)
    && news.worldDate === worldDate.label
    && news.generatorVersion === TODAYS_NEWS_GENERATOR_VERSION
  );
}

export function hasCurrentOrNoHomepageNews(
  news: Pick<HomepageNews, "slug" | "title" | "worldDate" | "generatorVersion"> | null | undefined,
  app: AppConfig,
  now?: number,
): boolean {
  return !news || isCurrentHomepageNews(news, app, now);
}

function hasCanonicalNewsHeading(markdown: string, worldDate: WorldDate): boolean {
  return markdown
    .split("\n")
    .some((line) => line.trim() === `# ${todaysNewsTitle(worldDate)}`);
}

function hasLinkedHeadlineStories(markdown: string): boolean {
  return extractHeadlines(markdown).every((headline) => headline.slug);
}

function hasNewsServiceSections(markdown: string): boolean {
  const travel = extractTopLevelSection(markdown, "Travel & Infrastructure");
  const notices = extractTopLevelSection(markdown, "Public Notices");
  const culture = extractTopLevelSection(markdown, "Culture & Sport");
  const science = extractTopLevelSection(markdown, "Science Desk");
  const markets = extractTopLevelSection(markdown, "Markets");
  const weather = extractTopLevelSection(markdown, "Weather");
  const corrections = extractTopLevelSection(markdown, "Corrections & Continuity");
  return Boolean(
    travel
      && notices
      && culture
      && science
      && markets
      && weather
      && corrections
      && /\| Network \| Status \| Advisory \|/.test(travel)
      && /\| Ticker \| Stock or index \| Move \| Desk note \|/.test(markets)
      && /\| Metric \| Report \|/.test(weather),
  );
}

function hasLinkedBriefHeadings(markdown: string): boolean {
  const section = extractTopLevelSection(markdown, "Briefs");
  return Boolean(section && /^###\s+\[[^\]]+\]\((?:halu|ref):/m.test(section));
}

export function relinkTodaysNewsBriefHeadings(markdown: string): string {
  const section = extractTopLevelSection(markdown, "Headlines");
  if (!section) return markdown;

  const storyByText = new Map<string, { text: string; target: string }>();
  for (const line of section.split("\n")) {
    const match = line
      .trim()
      .match(/^[-*]\s+\*\*\[([^\]]+)\]\(((?:halu|ref):[^) "\n]+)(?:\s+"[^"]*")?\)\*\*/);
    if (!match) continue;
    const text = normalizeHeadlineKey(match[1]);
    if (!text) continue;
    storyByText.set(text.toLowerCase(), { text, target: match[2] });
  }
  if (storyByText.size === 0) return markdown;

  const nextLines: string[] = [];
  let sectionName = "";
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (heading) sectionName = heading[1].trim().toLowerCase();

    if (sectionName === "briefs") {
      const briefHeading = line.match(/^###\s+(.+?)\s*#*\s*$/);
      if (briefHeading) {
        const text = normalizeHeadlineKey(stripMarkdownInline(briefHeading[1]));
        const story = storyByText.get(text.toLowerCase());
        if (story) {
          nextLines.push(`### [${story.text}](${story.target})`);
          continue;
        }
      }
    }

    nextLines.push(line);
  }

  return nextLines.join("\n").trim();
}

interface HeadlineLinkTarget {
  text: string;
  summary: string;
  slug: string;
}

function linkNewsHeadlines(markdown: string, sources: SourceArticle[]): string {
  const section = extractTopLevelSection(markdown, "Headlines");
  if (!section) return markdown;
  const targets = parseHeadlineLines(section, sources);
  if (targets.length === 0) return markdown;
  const targetByText = new Map(targets.map((target) => [normalizeHeadlineKey(target.text).toLowerCase(), target]));
  const nextLines: string[] = [];
  let sectionName = "";

  for (const line of markdown.split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (heading) sectionName = heading[1].trim().toLowerCase();

    if (sectionName === "headlines") {
      const parsed = parseHeadlineLine(line.trim(), sources);
      if (parsed) {
        const target = targetByText.get(normalizeHeadlineKey(parsed.text).toLowerCase());
        if (target) {
          const summary = parsed.summary ? `: ${parsed.summary}` : "";
          nextLines.push(`- **[${target.text}](halu:${target.slug} "${target.text}")**${summary}`);
          continue;
        }
      }
    }

    if (sectionName === "briefs") {
      const linkedBrief = linkedBriefHeading(line, targetByText);
      if (linkedBrief) {
        nextLines.push(...linkedBrief);
        continue;
      }
    }

    nextLines.push(line);
  }
  return nextLines.join("\n").trim();
}

function parseHeadlineLines(section: string, sources: SourceArticle[]): HeadlineLinkTarget[] {
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => parseHeadlineLine(line, sources))
    .filter((target): target is HeadlineLinkTarget => Boolean(target));
}

function parseHeadlineLine(
  line: string,
  sources: SourceArticle[],
): HeadlineLinkTarget | null {
  if (!/^[-*]\s+/.test(line)) return null;
  const clean = line.replace(/^[-*]\s+/, "").trim();
  const linked = clean.match(/^\*\*\[([^\]]+)\]\(halu:([^) "\n]+)(?:\s+"[^"]*")?\)\*\*:?\s*(.*)$/);
  if (linked) {
    const text = normalizeHeadlineKey(linked[1]);
    const existingSlug = linked[2].trim();
    return {
      text,
      slug: isGeneratedNewsSlug(existingSlug) ? headlineTopicSlug(text, sources) : existingSlug,
      summary: linked[3].trim(),
    };
  }
  const bold = clean.match(/^\*\*(.+?)\*\*:?\s*(.*)$/);
  if (!bold) {
    const text = clean.replace(/\*\*/g, "");
    return {
      text,
      slug: headlineTopicSlug(text, sources),
      summary: "",
    };
  }
  const text = normalizeHeadlineKey(bold[1]);
  return {
    text,
    slug: headlineTopicSlug(text, sources),
    summary: bold[2].trim(),
  };
}

function linkedBriefHeading(
  line: string,
  targetByText: Map<string, { text: string; slug: string }>,
): string[] | null {
  const heading = line.match(/^###\s+(.+?)\s*#*\s*$/);
  if (heading) {
    const text = normalizeHeadlineKey(heading[1]);
    const target = targetByText.get(text.toLowerCase());
    if (!target) return null;
    return [`### [${target.text}](halu:${target.slug} "${target.text}")`];
  }

  const bold = line.trim().match(/^\*\*(.+?)\*\*:?\s*(.*)$/);
  if (!bold) return null;
  const text = normalizeHeadlineKey(bold[1]);
  const target = targetByText.get(text.toLowerCase());
  if (!target) return null;
  return [
    `### [${target.text}](halu:${target.slug} "${target.text}")`,
    ...(bold[2].trim() ? [bold[2].trim()] : []),
  ];
}

function headlineTopicSlug(headline: string, sources: SourceArticle[]): string {
  const bestSource = pickHeadlineSource(headline, sources);
  return bestSource?.slug ?? (slugify(headline) || "news-topic");
}

function pickHeadlineSource(headline: string, sources: SourceArticle[]): SourceArticle | null {
  const words = meaningfulWords(headline);
  let best: { source: SourceArticle; score: number } | null = null;
  for (const source of sources) {
    if (isGeneratedNewsSlug(source.slug)) continue;
    const haystack = `${source.title} ${source.summaryMarkdown} ${source.markdown}`.toLowerCase();
    const score = words.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0)
      + (haystack.includes(headline.toLowerCase()) ? 3 : 0);
    if (!best || score > best.score) best = { source, score };
  }
  return best && best.score > 0 ? best.source : sources.find((source) => !isGeneratedNewsSlug(source.slug)) ?? null;
}

function meaningfulWords(value: string): string[] {
  return normalizeHeadlineKey(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !/^(with|from|into|under|over|after|before|today|news|report|says|amid)$/.test(word));
}

function stripMarkdownInline(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\(halu:[^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\(ref:[^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*/g, "")
    .trim();
}

function normalizeHeadlineKey(value: string): string {
  return stripMarkdownInline(value).replace(/:+$/g, "").trim();
}

function extractHeadlines(markdown: string): HomepageNews["headlines"] {
  const section = extractTopLevelSection(markdown, "Headlines");
  const headlines = section ? section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .slice(0, 6)
    .map((line) => {
      const clean = line.replace(/^[-*]\s+/, "").trim();
      const linked = clean.match(/^\*\*\[([^\]]+)\]\((?:halu|ref):([^) "\n]+)(?:\s+"[^"]*")?\)\*\*:?\s*(.*)$/);
      if (linked) {
        return {
          text: normalizeHeadlineKey(linked[1]),
          slug: linked[2].trim(),
          summary: linked[3].trim(),
        };
      }
      const match = clean.match(/^\*\*(.+?)\*\*:?\s*(.*)$/);
      if (!match) return { text: clean.replace(/\*\*/g, ""), summary: "" };
      return {
        text: normalizeHeadlineKey(match[1]),
        summary: match[2].trim(),
      };
    }) : [];

  if (headlines.length >= 3) return headlines;

  const seen = new Set(headlines.map((headline) => headline.text.toLowerCase()));
  for (const fallback of extractBriefHeadlines(markdown)) {
    if (headlines.length >= 6) break;
    if (seen.has(fallback.text.toLowerCase())) continue;
    headlines.push(fallback);
    seen.add(fallback.text.toLowerCase());
  }
  return headlines;
}

function extractBriefHeadlines(markdown: string): HomepageNews["headlines"] {
  const section = extractTopLevelSection(markdown, "Briefs");
  if (!section) return [];
  return section
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((part) => {
      const headingMatch = part.match(/^###\s+(.+?)\s*#*\s*\n([\s\S]*)$/);
      if (headingMatch) {
        return {
          text: normalizeHeadlineKey(headingMatch[1]),
          summary: headingMatch[2].replace(/\s+/g, " ").trim().slice(0, 220),
        };
      }
      const sentenceMatch = part.match(/^(.+?[.!?])\s+([\s\S]*)$/);
      return {
        text: (sentenceMatch?.[1] ?? part).replace(/\s+/g, " ").trim().slice(0, 120),
        summary: (sentenceMatch?.[2] ?? "").replace(/\s+/g, " ").trim().slice(0, 220),
      };
    });
}

function extractTopLevelSection(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const target = title.trim().toLowerCase();
  const body: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const normalized = heading[1].trim().toLowerCase();
      if (normalized === target) {
        inSection = true;
        continue;
      }
      if (inSection) break;
    }
    if (inSection) body.push(line);
  }

  return body.join("\n").trim();
}

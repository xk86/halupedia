/**
 * Hand-curated homepage article. Serves two purposes:
 *   1. Gives visitors a warm landing page so the site feels alive on first visit.
 *   2. Provides a dense cluster of starter links that seed exploration.
 *
 * This is never regenerated — it is cached on first request forever.
 * 
 * For dev reset with this: pnpm wrangler kv key delete --binding=ARTICLES --local --preview false "halupedia"
 */
export const HOMEPAGE_ARTICLE = `<h1>Halupedia</h1>
<p><strong>Halupedia</strong> is an encyclopedia covering topics that have received insufficient attention in mainstream reference works. Coverage spans historical events, scientific disciplines, geographical features, notable persons, organizations, treaties, academic disputes, and cultural phenomena. Articles are generated on demand and stored permanently upon first request.</p>

<p>The encyclopedia approaches all subjects with equal seriousness regardless of their prominence, scope, or the number of people aware of their existence. Entries follow standard encyclopedic structure and cite relevant scholarly literature throughout.</p>

<h2>How it works</h2>

<p>Click any linked term inside an article to load its entry. New topics are documented at the moment of first access. Use the <strong>Stumble</strong> button in the header to navigate to a random existing article.</p>

<p>Minor inconsistencies between entries are a known characteristic of the encyclopedia and fall within acceptable tolerances.</p>

<h2>Suggested starting points</h2>

<ul>
<li><a href="/the-great-pigeon-census-of-1887">The Great Pigeon Census of 1887</a> &mdash; the six-year municipal effort to count every pigeon in Vienna, abandoned after the pigeons were counted twice and then went missing.</li>
<li><a href="/the-ministry-of-slightly-wrong-maps">The Ministry of Slightly Wrong Maps</a> &mdash; a government agency established to produce maps with deliberate minor inaccuracies, for reasons that remain classified.</li>
<li><a href="/the-ministry-of-terribly-wrong-maps">The Ministry of Terribly Wrong Maps</a> &mdash; a government agency established to produce maps with deliberate major inaccuracies, for reasons that remain classified.</li>
<li><a href="/chaldic-arithmetic">Chaldic Arithmetic</a> &mdash; the branch of mathematics in which subtraction is forbidden and practitioners must instead negotiate with the number.</li>
<li><a href="/the-national-library-of-unfinished-books">The National Library of Unfinished Books</a> &mdash; an institution dedicated to works their authors abandoned between 40% and 85% completion.</li>
<li><a href="/the-society-for-the-prevention-of-unnecessary-tuesdays">The Society for the Prevention of Unnecessary Tuesdays</a> &mdash; a civic organization that successfully petitioned four municipalities to skip the day entirely.</li>
<li><a href="/armund-the-river-mapper">Armund the River Mapper</a> &mdash; the cartographer who mapped 14,000 leagues of river system without ever leaving his chair, and was later sued by three of the rivers.</li>
<li><a href="/the-year-without-tuesdays">The Year Without Tuesdays</a> &mdash; a calendrical anomaly recorded in four kingdoms and denied in a fifth.</li>
</ul>`;

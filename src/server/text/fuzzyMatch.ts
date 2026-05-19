export function textTokens(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length];
}

export function tokenSimilarity(a: string, b: string): number {
  const maxLength = Math.max(a.length, b.length);
  if (!maxLength) return 1;
  return 1 - levenshtein(a, b) / maxLength;
}

export function fuzzyTitleScore(text: string, queryTokens: string[], title: string): number {
  const normalizedText = text.replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedTitle = title.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalizedTitle || normalizedTitle.length < 4) return 0;
  if (normalizedText.includes(normalizedTitle)) return 1;

  const titleTokens = textTokens(title);
  if (titleTokens.length === 0 || queryTokens.length === 0) return 0;

  let matched = 0;
  let similarityTotal = 0;
  for (const titleToken of titleTokens) {
    const best = Math.max(
      ...queryTokens.map((queryToken) =>
        queryToken === titleToken ? 1 : tokenSimilarity(queryToken, titleToken),
      ),
    );
    similarityTotal += best;
    if (best >= 0.78) matched += 1;
  }

  const coverage = matched / titleTokens.length;
  const averageSimilarity = similarityTotal / titleTokens.length;
  return coverage >= 0.5 ? (coverage + averageSimilarity) / 2 : 0;
}

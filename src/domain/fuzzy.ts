/** Lowercase, strip accents and punctuation: "Tomás O'Connor" -> "tomas oconnor". */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9@.+\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = curr;
  }
  return prev[b.length] ?? Math.max(a.length, b.length);
}

/** 1.0 = identical, 0.0 = nothing in common (normalized edit distance). */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/**
 * Token-level fuzzy score of `query` against `name`: each query token is matched
 * to its most similar name token (prefixes count as strong matches), then averaged.
 */
export function tokenSimilarity(query: string, name: string): number {
  const q = normalizeText(query).split(" ").filter(Boolean);
  const n = normalizeText(name).split(" ").filter(Boolean);
  if (q.length === 0 || n.length === 0) return 0;
  const scores = q.map((qt) =>
    Math.max(...n.map((nt) => (nt.startsWith(qt) && qt.length >= 3 ? 0.95 : similarity(qt, nt)))),
  );
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

export interface SchoolIdentityCandidate {
  id: string;
  name: string;
  location: string;
}

export interface RankedSchoolIdentity extends SchoolIdentityCandidate {
  similarity: number;
}

export const SCHOOL_SIMILARITY_THRESHOLD = 0.7;

export function normalizeSchoolName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function bigrams(value: string) {
  const compact = normalizeSchoolName(value).replace(/\s/g, "");
  if (compact.length < 2) return compact ? [compact] : [];
  return Array.from({ length: compact.length - 1 }, (_, index) => compact.slice(index, index + 2));
}

export function schoolNameSimilarity(left: string, right: string) {
  const normalizedLeft = normalizeSchoolName(left);
  const normalizedRight = normalizeSchoolName(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;

  const leftBigrams = bigrams(normalizedLeft);
  const rightBigrams = bigrams(normalizedRight);
  const remaining = new Map<string, number>();
  for (const pair of rightBigrams) remaining.set(pair, (remaining.get(pair) ?? 0) + 1);

  let overlap = 0;
  for (const pair of leftBigrams) {
    const count = remaining.get(pair) ?? 0;
    if (count === 0) continue;
    overlap += 1;
    remaining.set(pair, count - 1);
  }
  return (2 * overlap) / (leftBigrams.length + rightBigrams.length);
}

export function rankSimilarSchools(
  query: string,
  candidates: SchoolIdentityCandidate[],
  threshold = SCHOOL_SIMILARITY_THRESHOLD,
  limit = 5,
): RankedSchoolIdentity[] {
  return candidates
    .map((candidate) => ({
      ...candidate,
      similarity: schoolNameSimilarity(query, candidate.name),
    }))
    .filter((candidate) => candidate.similarity >= threshold)
    .sort((left, right) => right.similarity - left.similarity || left.name.localeCompare(right.name, "en-US"))
    .slice(0, limit);
}

const shortNameStopWords = new Set(["a", "an", "and", "at", "for", "in", "of", "on", "the"]);

export function deriveSchoolPresentation(name: string) {
  const words = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[A-Za-z0-9]+/g) ?? [];
  const meaningfulWords = words.filter((word) => !shortNameStopWords.has(word.toLowerCase()));
  const acronym = meaningfulWords.map((word) => word[0]?.toUpperCase()).join("");
  const shortName = acronym.length >= 2 && acronym.length <= 12 ? acronym : name.slice(0, 64);
  const initials = (acronym || words.join("") || "SC").slice(0, 3).toUpperCase().padEnd(2, "X");
  const palette = ["#6574f7", "#ff765f", "#1fb09f", "#bd8c32", "#d65fa2", "#6b9e4b"];
  const hash = [...name].reduce((value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0, 0);

  return { shortName, initials, color: palette[hash % palette.length]! };
}

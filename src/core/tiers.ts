/**
 * How confident we are that a card file already exists in a given library.
 * Ordered weakest to strongest; `minTier` in the config is the threshold at
 * which a library counts as "has it" for rule evaluation.
 */
export const TIERS = ["none", "weak", "probable", "strong", "exact"] as const;

export type MatchTier = (typeof TIERS)[number];

export function tierRank(t: MatchTier): number {
  return TIERS.indexOf(t);
}

export function atLeast(tier: MatchTier, min: MatchTier): boolean {
  return tierRank(tier) >= tierRank(min);
}

export function bestTier(a: MatchTier, b: MatchTier): MatchTier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

export function isTier(v: unknown): v is MatchTier {
  return typeof v === "string" && (TIERS as readonly string[]).includes(v);
}

/** Short explanation shown next to each match in the UI. */
export const TIER_LABEL: Record<MatchTier, string> = {
  none: "no match",
  weak: "same size only",
  probable: "same name and size",
  strong: "same shot (capture metadata) or matching content hash prefix",
  exact: "byte-identical content hash",
};

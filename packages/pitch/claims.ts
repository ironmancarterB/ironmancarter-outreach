// Every personalized sentence in a pitch records the facts it relies on, so you can check each claim.
export type ClaimSource =
  | { type: 'research'; id: number; url: string; label: string; snippet: string | null; retrieved_at: string }
  | { type: 'metric'; id: number; label: string; platform: string; value: number; period: string | null; as_of: string; source: string }
  | { type: 'package'; id: number; name: string }
  | { type: 'media_kit'; id: number; version: number }
  | { type: 'creator'; note: string }
  | { type: 'concept'; note: string }

export interface Claim {
  sentence: string
  kind: 'brand' | 'metric' | 'creator' | 'concept' | 'package' | 'media_kit'
  sources: ClaimSource[]
}

export const CHAR_PALETTE = [
  "#c07820", "#3b82f6", "#10b981", "#a855f7",
  "#ec4899", "#06b6d4", "#f97316", "#ef4444",
] as const;

export function colorFor(charIndex: number): string {
  return CHAR_PALETTE[charIndex % CHAR_PALETTE.length];
}

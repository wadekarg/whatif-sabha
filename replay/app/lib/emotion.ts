export interface EmotionStyle {
  bg: string;
  label: string;
  dot: string;
}

export const EMOTION_STYLES: Record<string, EmotionStyle> = {
  anger:                { bg: "rgba(254,242,242,0.7)",  label: "anger",        dot: "#ef4444" },
  cold_fury:            { bg: "rgba(69,10,10,0.08)",    label: "cold fury",    dot: "#7f1d1d" },
  contempt:             { bg: "rgba(250,245,255,0.7)",  label: "contempt",     dot: "#a855f7" },
  grief:                { bg: "rgba(239,246,255,0.7)",  label: "grief",        dot: "#60a5fa" },
  desperation:          { bg: "rgba(255,247,237,0.7)",  label: "desperation",  dot: "#f97316" },
  pride:                { bg: "rgba(254,252,232,0.7)",  label: "pride",        dot: "#eab308" },
  guilt:                { bg: "rgba(248,250,252,0.7)",  label: "guilt",        dot: "#94a3b8" },
  shame:                { bg: "rgba(253,242,248,0.7)",  label: "shame",        dot: "#f472b6" },
  defiance:             { bg: "rgba(255,251,235,0.7)",  label: "defiance",     dot: "#f59e0b" },
  bitterness:           { bg: "rgba(250,250,249,0.7)",  label: "bitterness",   dot: "#78716c" },
  jealousy:             { bg: "rgba(240,253,244,0.7)",  label: "jealousy",     dot: "#22c55e" },
  longing:              { bg: "rgba(238,242,255,0.7)",  label: "longing",      dot: "#818cf8" },
  righteous_indignation:{ bg: "rgba(255,241,242,0.7)",  label: "indignation",  dot: "#e11d48" },
  humiliation:          { bg: "rgba(255,241,242,0.5)",  label: "humiliation",  dot: "#fb7185" },
  weariness:            { bg: "rgba(249,250,251,0.7)",  label: "weariness",    dot: "#9ca3af" },
  hope:                 { bg: "rgba(240,253,250,0.7)",  label: "hope",         dot: "#2dd4bf" },
  betrayal:             { bg: "rgba(245,243,255,0.7)",  label: "betrayal",     dot: "#6d28d9" },
  neutral:              { bg: "rgba(255,255,255,0.9)",  label: "",             dot: "#c8b89a" },
};

export function getEmotionStyle(emotion: string | undefined): EmotionStyle {
  if (!emotion) return EMOTION_STYLES.neutral;
  return EMOTION_STYLES[emotion] ?? EMOTION_STYLES.neutral;
}

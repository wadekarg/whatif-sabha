export type StoryQA = { question: string; answer: string };

export type CastMember = {
  slug: string;
  name: string;
  role: string;
  description?: string;
  importance?: number;
  portrait_url?: string;
  qa?: StoryQA[];
};

export type TimelineEntry = { era: string; event: string };

export type StoryData = {
  slug: string;
  title: string;
  author: string;
  tagline: string;
  demo_divergence: string;
  themes?: string[];
  word_count?: number;
  synopsis: string;
  timeline: TimelineEntry[];
  overview?: any;
  qa: StoryQA[];
};

export type FairWitness = {
  consensus_view?: string;
  hidden_motivations?: string;
  narrative_bias?: string;
  charitable_reading?: string;
  speaks_as?: string;
  fair_personality_traits?: string[];
};

export type CharacterDossier = CastMember & {
  slug: string;
  name: string;
  role: string;
  description: string;
  qa: StoryQA[];
  personality_traits?: string[];
  motivations?: string[];
  fears?: string[];
  internal_voice?: string;
  aliases?: string[];
  fair_witness?: FairWitness | null;
  phases?: any[];
  timeline_phases?: any[];
  knowledge_events?: any[];
  timeline_metadata?: any;
};

export type CharactersData = Record<string, CharacterDossier>;

import storyJson from "../../public/story.json";
import charactersJson from "../../public/characters.json";
import bundledDebate from "../../public/debates/8654df3d-796a-4324-90c3-20d7986cb5de.json";

export const story: StoryData = storyJson as unknown as StoryData;
export const characters: CharactersData = charactersJson as unknown as CharactersData;
export const debate: any = bundledDebate;
export const DEBATE_ID = (bundledDebate as any).debate_id as string;

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// Ordered cast for the strip — importance desc, then name asc. Moderator Boru
// skipped unless he's the only one (he is not a book character).
export function listCast(): CharacterDossier[] {
  const all = Object.values(characters).filter((c) => c.slug !== "boru");
  return all.sort((a, b) => {
    const ai = a.importance ?? 0;
    const bi = b.importance ?? 0;
    if (ai !== bi) return bi - ai;
    return a.name.localeCompare(b.name);
  });
}

// All characters (for /characters page + character picker)
export function listAllCharacters(): CharacterDossier[] {
  return Object.values(characters).sort((a, b) => a.name.localeCompare(b.name));
}

export function getCharacter(slug: string): CharacterDossier | null {
  return characters[slug] ?? null;
}

// Capitalize first letter of a sentence — the demo_divergence is lowercase.
export function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Stats for the bundled past-debate card
export function bundledDebateStats() {
  const transcript: any[] = debate.transcript ?? [];
  const speakers = new Set<string>();
  for (const t of transcript) {
    if (t.character) speakers.add(t.character);
  }
  return {
    id: DEBATE_ID,
    turns: transcript.length,
    speakers: speakers.size,
    topic: debate?.story?.divergence ?? story.demo_divergence,
    status: debate?.status ?? "completed",
    date: (debate?.exported_at ?? "").slice(0, 10),
  };
}

export const CHAR_COLORS = [
  "#c07820", "#3b82f6", "#10b981", "#a855f7",
  "#ec4899", "#06b6d4", "#f97316", "#ef4444",
];

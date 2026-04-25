export type StoryQA = { question: string; answer: string };

export type CastMember = {
  slug: string;
  name: string;
  role: string;
  portrait_url?: string;
};

export type TimelineEntry = { era: string; event: string };

export type StoryData = {
  slug: string;
  title: string;
  author: string;
  tagline: string;
  demo_divergence: string;
  synopsis: string;
  timeline: TimelineEntry[];
  cast: CastMember[];
  qa: StoryQA[];
};

export type CharacterDossier = {
  slug: string;
  name: string;
  role: string;
  portrait_url?: string;
  description: string;
  qa: StoryQA[];
};

export type CharactersData = Record<string, CharacterDossier>;

import storyJson from "../../public/story.json";
import charactersJson from "../../public/characters.json";

export const story: StoryData = storyJson as StoryData;
export const characters: CharactersData = charactersJson as CharactersData;

export function listCharacters(): CharacterDossier[] {
  return Object.values(characters).sort((a, b) => a.name.localeCompare(b.name));
}

export function getCharacter(slug: string): CharacterDossier | null {
  return characters[slug] ?? null;
}

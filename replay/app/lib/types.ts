export interface ReplayCharacter {
  name: string;
  role: string;
  short_description: string;
  portrait_url: string;
  color: string;
}

export interface ReplayTurn {
  character: string;
  message: string;
  round: number;
  phase: string;
  isOrchestrator?: boolean;
  orchestratorEvent?: string;
  target_character?: string;
  emotion?: string;
  isObserver?: boolean;
  observerEra?: string;
}

export interface ReplayTimelineEvent {
  event?: string;
  chapter_ref?: string;
  [key: string]: unknown;
}

export interface ReplayDebate {
  version: "1";
  debate_id: string;
  exported_at: string;
  disclaimer: string;
  story: {
    title: string;
    author: string;
    summary: string;
    divergence: string;
  };
  characters: ReplayCharacter[];
  transcript: ReplayTurn[];
  alternate_ending: string;
  alternate_timeline: ReplayTimelineEvent[];
}

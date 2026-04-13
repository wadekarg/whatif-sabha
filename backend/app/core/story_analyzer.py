import json
import re
from app.config import get_analysis_llm

WORLD_OBSERVERS_PROMPT = """You are a literary historian. Given the story below, generate a set of historically-situated world observer personas who would have strong, conflicting opinions about this story's events.

STORY TITLE: {title}
STORY SUMMARY: {summary}
THEMES: {themes}
STORY ERA/SETTING: derived from the story context

Generate 10-14 world observer personas representing diverse global perspectives — people from DIFFERENT eras, cultures, political positions, and worldviews who would interpret this story very differently.

Return a JSON array:
[
  {{
    "id": "snake_case_unique_id",
    "name": "Specific descriptive name (e.g. 'Soviet Propagandist, Moscow 1945', 'Trotskyist Exile, Paris 1946')",
    "era": "Time period and location (e.g. 'Soviet Union, 1945')",
    "perspective": "One sentence: who this person is and their core worldview",
    "historical_knowledge": "What unique historical knowledge they bring that characters cannot have",
    "would_challenge": "What claims or positions they would most forcefully challenge",
    "would_defend": "What they would argue for or protect",
    "blindspot": "What they genuinely cannot see or refuse to acknowledge",
    "relevance_tags": ["tag1", "tag2", "tag3"],
    "voice_style": "Brief description of how they speak (e.g. 'authoritative, ideological, uses statistics')"
  }}
]

Make them SPECIFIC to this story's historical and cultural context — not generic archetypes.
Include voices from multiple continents, multiple ideological positions, and multiple time periods (including people looking back from decades later).
Return ONLY valid JSON array. No markdown."""

ANALYSIS_PROMPT = """You are a literary analyst. Analyze the following story and return a detailed JSON object.

STORY TEXT:
{story_text}

Return a JSON object with this exact structure:
{{
  "title": "story title",
  "author": "author name or Unknown",
  "summary": "2-3 sentence summary",
  "themes": ["theme1", "theme2"],

  "timeline_metadata": {{
    "unit_name": "Year",
    "unit_plural": "Years",
    "total_duration": 3.0,
    "start_label": "Year 1",
    "description": "The story spans 3 years"
  }},

  "timeline_phases": [
    {{
      "phase_id": "snake_case_id",
      "name": "Phase Name",
      "description": "what happens in this phase",
      "timeline_position_start": 0.0,
      "timeline_position_end": 0.2,
      "chapter_range": [1, 2],
      "trigger_event": "what caused this phase to begin"
    }}
  ],

  "characters": [
    {{
      "name": "Character Name",
      "role": "protagonist|antagonist|supporting|minor",
      "description": "who this character is",
      "importance": 0.95,
      "phases": [
        {{
          "phase_id": "same_id_as_timeline_phase",
          "personality_traits": ["trait1", "trait2"],
          "knowledge_state": {{
            "fact_key": true
          }},
          "motivations": ["motivation1"],
          "fears": ["fear1"],
          "emotional_state": "description of their emotional state",
          "internal_voice": "how they think and speak at this phase",
          "relationships": {{
            "OtherCharacter": {{
              "type": "ally|rival|friend|enemy|neutral|exploits|fears",
              "trust": 0.7,
              "description": "nature of relationship"
            }}
          }}
        }}
      ]
    }},
    "hidden_dimensions": [
      "A plausible but unconfirmed inner truth — something the text never stated but strongly implies",
      "A secret belief, doubt, or fear this character would never publicly admit",
      "Something they've been carrying for a long time that shapes everything they do",
      "A surprising sympathy or vulnerability that contradicts their public face",
      "A private desire or dream that no one in the story knows about"
    ]
  ],

  "relationships": [
    {{
      "from": "Character A",
      "to": "Character B",
      "type": "controls|rivals|friends|enemies|family|uses",
      "description": "relationship description",
      "strength": 0.8
    }}
  ],

  "key_events": [
    {{
      "event_id": "snake_case_id",
      "name": "Event Name",
      "description": "what happened",
      "timeline_position": 0.15,
      "chapter": 2,
      "characters_involved": ["Character A", "Character B"],
      "is_turning_point": true,
      "consequence": "what changed because of this event"
    }}
  ],

  "knowledge_events": [
    {{
      "character": "Character Name",
      "learns": "what they learn",
      "timeline_position": 0.7,
      "from_character": "who told them or null",
      "was_hidden_before": true,
      "impact_on_character": "how this changes them"
    }}
  ],

  "potential_divergence_points": [
    {{
      "event_id": "reference to key_events event_id",
      "description": "A compelling 'What if...' scenario",
      "affected_characters": ["Character A", "Character B"]
    }}
  ]
}}

IMPORTANT: Generate 6-10 potential_divergence_points. Each should be a DIFFERENT pivotal
moment. Think about: key decisions, betrayals, secrets revealed early, alliances that
could have formed, events that never happened. Make each specific and debate-worthy.

Return ONLY valid JSON. No markdown, no explanation. Be thorough — extract ALL named characters, even minor ones.\n\nFor timeline_metadata: invent a story-native time unit. Examples: Animal Farm → {{"unit_name":"Farm Year","unit_plural":"Farm Years","total_duration":3.0,"start_label":"Year 1","description":"The story spans approximately 3 farm years"}}. Mahabharata → {{"unit_name":"Parva","unit_plural":"Parvas","total_duration":18.0,"start_label":"Parva 1","description":"The epic spans 18 parvas"}}. A war story → {{"unit_name":"War Year","unit_plural":"War Years","total_duration":4.0,"start_label":"Year 1","description":"The war spans 4 years"}}. Pick a unit that feels NATIVE to this specific story's world. total_duration should be a reasonable real-world-scale number (e.g. 3.0 farm years, not 1.0 meaning 100%). The 0.0–1.0 timeline positions will be multiplied by total_duration to get the actual label.\n\nFor hidden_dimensions: generate 5-8 plausible-but-unverified inner truths per character — things the text implies but never states. These are the character's hidden self. Be specific to this story and character, not generic."""


async def generate_world_observers(title: str, summary: str, themes: list) -> list:
    """
    Generate historically-situated world observer personas for this story.
    These are external voices — not story characters — who bring historical
    knowledge and global perspectives that the characters themselves cannot have.
    Falls back gracefully to empty list if generation fails.
    """
    try:
        llm = get_analysis_llm()
        prompt = WORLD_OBSERVERS_PROMPT.format(
            title=title,
            summary=summary,
            themes=", ".join(themes) if themes else "unspecified",
        )
        response = await llm.ainvoke(prompt)
        raw = response.content
        if isinstance(raw, list):
            raw = "".join(
                part.get("text", "") if isinstance(part, dict) else str(part)
                for part in raw
            )
        raw = re.sub(r"^```(?:json)?\n?", "", raw.strip())
        raw = re.sub(r"\n?```$", "", raw.strip())
        observers = json.loads(raw)
        return observers if isinstance(observers, list) else []
    except Exception:
        return []


STRUCTURE_PROMPT = """You are a literary analyst. Analyze the following story and return a JSON object describing its structure.
Do NOT include characters — they are extracted separately.

STORY TEXT:
{story_text}

Return a JSON object:
{{
  "title": "story title",
  "author": "author name or Unknown",
  "summary": "2-3 sentence summary",
  "themes": ["theme1", "theme2"],

  "timeline_metadata": {{
    "unit_name": "Year",
    "unit_plural": "Years",
    "total_duration": 3.0,
    "start_label": "Year 1",
    "description": "The story spans 3 years"
  }},

  "timeline_phases": [
    {{
      "phase_id": "snake_case_id",
      "name": "Phase Name",
      "description": "what happens in this phase",
      "timeline_position_start": 0.0,
      "timeline_position_end": 0.2,
      "chapter_range": [1, 2],
      "trigger_event": "what caused this phase to begin"
    }}
  ],

  "relationships": [
    {{
      "from": "Character A",
      "to": "Character B",
      "type": "controls|rivals|friends|enemies|family|uses",
      "description": "relationship description",
      "strength": 0.8
    }}
  ],

  "key_events": [
    {{
      "event_id": "snake_case_id",
      "name": "Event Name",
      "description": "what happened",
      "timeline_position": 0.15,
      "chapter": 2,
      "characters_involved": ["Character A"],
      "is_turning_point": true,
      "consequence": "what changed"
    }}
  ],

  "knowledge_events": [
    {{
      "character": "Character Name",
      "learns": "what they learn",
      "timeline_position": 0.7,
      "from_character": "who told them or null",
      "was_hidden_before": true,
      "impact_on_character": "how this changes them"
    }}
  ],

  "potential_divergence_points": [
    {{
      "event_id": "reference to key_events event_id",
      "description": "A compelling 'What if...' scenario",
      "affected_characters": ["Character A", "Character B"]
    }}
  ]
}}

IMPORTANT: Generate 6-10 potential_divergence_points — each a DIFFERENT pivotal moment.

For timeline_metadata: use a story-native time unit.
Animal Farm → Farm Years · Mahabharata → Parvas · war story → War Years.
Return ONLY valid JSON. No markdown."""


async def analyze_story_structure(full_text: str) -> dict:
    """
    Extract story structure — title, themes, events, phases.
    Does NOT extract characters (handled by multi_pass_extractor).
    Uses fallback chain: Gemini → NVIDIA → OpenRouter.
    """
    from app.config import get_analysis_fallbacks
    prompt = STRUCTURE_PROMPT.format(story_text=full_text)

    for llm, label in get_analysis_fallbacks():
        try:
            response = await llm.ainvoke(prompt)
            raw = response.content
            if isinstance(raw, list):
                raw = "".join(
                    part.get("text", "") if isinstance(part, dict) else str(part)
                    for part in raw
                )
            raw = re.sub(r"^```(?:json)?\n?", "", raw.strip())
            raw = re.sub(r"\n?```$", "", raw.strip())
            raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
            return json.loads(raw)
        except json.JSONDecodeError:
            continue  # bad JSON, try next model
        except Exception as e:
            if "429" in str(e) or "rate" in str(e).lower() or "quota" in str(e).lower():
                continue  # rate limited, try next
            raise
    raise ValueError("All LLM providers failed for story structure analysis")


async def analyze_story(full_text: str) -> dict:
    """
    Analyze a story using the LLM and return structured JSON.
    Uses fallback chain: Gemini → NVIDIA → OpenRouter.
    """
    from app.config import get_analysis_fallbacks
    prompt = ANALYSIS_PROMPT.format(story_text=full_text)

    for llm, label in get_analysis_fallbacks():
        try:
            response = await llm.ainvoke(prompt)
            raw = response.content
            if isinstance(raw, list):
                raw = "".join(
                    part.get("text", "") if isinstance(part, dict) else str(part)
                    for part in raw
                )
            raw = re.sub(r"^```(?:json)?\n?", "", raw.strip())
            raw = re.sub(r"\n?```$", "", raw.strip())
            raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
            return json.loads(raw)
        except json.JSONDecodeError:
            continue
        except Exception as e:
            if "429" in str(e) or "rate" in str(e).lower() or "quota" in str(e).lower():
                continue
            raise
    raise ValueError("All LLM providers failed for story analysis")

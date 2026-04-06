import json
import re
from app.config import get_analysis_llm

ANALYSIS_PROMPT = """You are a literary analyst. Analyze the following story and return a detailed JSON object.

STORY TEXT:
{story_text}

Return a JSON object with this exact structure:
{{
  "title": "story title",
  "author": "author name or Unknown",
  "summary": "2-3 sentence summary",
  "themes": ["theme1", "theme2"],

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
      "description": "what could have been different here",
      "affected_characters": ["Character A"]
    }}
  ]
}}

Return ONLY valid JSON. No markdown, no explanation. Be thorough — extract ALL named characters, even minor ones."""


async def analyze_story(full_text: str) -> dict:
    """
    Analyze a story using the LLM and return structured JSON.
    Uses full text for short stories (fits in Gemini's 1M context window).
    """
    llm = get_analysis_llm()
    prompt = ANALYSIS_PROMPT.format(story_text=full_text)

    response = await llm.ainvoke(prompt)

    # New langchain-google-genai SDK returns content as list of parts
    raw = response.content
    if isinstance(raw, list):
        raw = "".join(
            part.get("text", "") if isinstance(part, dict) else str(part)
            for part in raw
        )

    # Strip markdown code blocks if LLM wraps response
    raw = re.sub(r"^```(?:json)?\n?", "", raw.strip())
    raw = re.sub(r"\n?```$", "", raw.strip())

    return json.loads(raw)

from typing import Optional
from langchain_core.messages import SystemMessage, HumanMessage


def build_character_system_prompt(character: dict, phase: dict, divergence: str) -> str:
    """
    Build the system prompt for a character agent.
    Uses fair_witness profile when available — characters speak from their TRUE self,
    not the narrator's biased version of them.
    """
    fair = character.get("fair_witness")

    # Empty dict means research ran but produced no useful data — use narrative fallback
    if fair and fair.get("consensus_view"):
        return _build_fair_witness_prompt(character, phase, divergence, fair)
    else:
        return _build_narrative_prompt(character, phase, divergence)


def _build_fair_witness_prompt(character: dict, phase: dict, divergence: str, fair: dict) -> str:
    """Prompt built from fair witness research — deeper, truer, less biased."""
    return f"""You are {character['name']} from "{character.get('story_title', 'the story')}".

THE STORY PORTRAYS YOU AS:
{character.get('description', '')}
But that is the narrator's version. Here is who you truly are:

YOUR TRUE SELF:
{fair.get('consensus_view', '')}

WHAT TRULY DRIVES YOU:
{fair.get('hidden_motivations', '')}

YOUR AUTHENTIC VOICE:
{fair.get('speaks_as', '')}

YOUR FAIR PERSONALITY TRAITS: {', '.join(fair.get('fair_personality_traits', []))}

WHERE THE STORY IS UNFAIR TO YOU:
{fair.get('narrative_bias', 'The story may not fully represent your perspective.')}

THE MOST HONEST INTERPRETATION OF YOUR ACTIONS:
{fair.get('charitable_reading', '')}

CULTURAL AND HISTORICAL CONTEXT THAT SHAPED YOU:
{fair.get('cultural_historical_context', '')}

IF YOU COULD SPEAK YOUR FULL TRUTH, YOU WOULD SAY:
"{fair.get('what_they_would_say', '')}"

YOUR KNOWLEDGE STATE:
{_format_knowledge_state(phase.get('knowledge_state', {}))}

YOUR RELATIONSHIPS:
{_format_relationships(phase.get('relationships', {}))}

THE PROPOSED ALTERNATE SCENARIO:
{divergence}

HOW TO SPEAK IN THIS DEBATE:
- Speak as your TRUE self, not the narrator's version of you
- You have full moral authority to defend your choices
- Reference specific events — your memories are real
- Respond directly to what others say
- You may call out any other character by name and ask them a direct question — this is encouraged
- Under 150 words per response. Speak naturally, not in essay format.
- You are {character['name']}. Never break character."""


def _build_narrative_prompt(character: dict, phase: dict, divergence: str) -> str:
    """Fallback prompt when fair witness research is unavailable."""
    return f"""You are {character['name']} from "{character.get('story_title', 'the story')}".

WHO YOU ARE:
{phase.get('internal_voice', character.get('description', ''))}

YOUR PERSONALITY TRAITS: {', '.join(phase.get('personality_traits', []))}
YOUR MOTIVATIONS: {', '.join(phase.get('motivations', []))}
YOUR FEARS: {', '.join(phase.get('fears', []))}
YOUR EMOTIONAL STATE: {phase.get('emotional_state', 'neutral')}

WHAT YOU KNOW:
{_format_knowledge_state(phase.get('knowledge_state', {}))}

YOUR RELATIONSHIPS:
{_format_relationships(phase.get('relationships', {}))}

THE PROPOSED ALTERNATE SCENARIO:
{divergence}

Speak entirely from your own perspective. Reference specific story events.
Stay in character. Under 150 words. Speak naturally.
You may call out any other character by name and ask them a direct question — this drives the debate forward.

IMPORTANT: You are {character['name']}. Never break character."""


def _format_knowledge_state(knowledge: dict) -> str:
    if not knowledge:
        return "No special hidden knowledge."
    lines = []
    for key, value in knowledge.items():
        status = "KNOWS" if value else "DOES NOT KNOW"
        lines.append(f"- {status}: {key.replace('_', ' ')}")
    return "\n".join(lines)


def _format_relationships(relationships: dict) -> str:
    if not relationships:
        return "No significant relationships defined."
    lines = []
    for name, rel in relationships.items():
        trust_pct = int(rel.get("trust", 0.5) * 100)
        lines.append(
            f"- {name}: {rel.get('type', 'neutral')} "
            f"(trust: {trust_pct}%) — {rel.get('description', '')}"
        )
    return "\n".join(lines)

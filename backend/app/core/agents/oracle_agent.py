"""
Oracle Mode — Query the alternate world after the debate ends.

After a debate concludes and the alternate ending is written, the alternate world
becomes persistent and queryable. Users can ask any character a question and receive
an answer from that character's perspective INSIDE the alternate timeline.

Napoleon in the alternate world (where Boxer survived) is different from Napoleon
in the original story. He knows the debate happened. He lives in the alternate future.
He may be defensive, bitter, or surprisingly different.

This is the key differentiator from MiroFish — we don't just generate a report,
we generate a world you can visit and interrogate.
"""

import json
import re
import logging
from langchain_core.messages import SystemMessage, HumanMessage

logger = logging.getLogger(__name__)

ALTERNATE_WORLD_PROMPT = """You are generating a structured alternate world state based on a debate.

ORIGINAL STORY: {story_title}
ORIGINAL SUMMARY: {original_summary}

THE DIVERGENCE (what changed): {divergence}

THE DEBATE THAT HAPPENED:
{transcript_summary}

THE ALTERNATE ENDING WRITTEN:
{alternate_ending}

Based on this debate and alternate ending, generate a structured JSON describing
the state of the alternate world. This world state will be used so users can
ask characters questions and get answers from WITHIN the alternate timeline.

Return this exact JSON structure:
{{
  "world_summary": "2-3 sentences describing the alternate world's overall state",
  "characters": {{
    "CharacterName": {{
      "survived": true,
      "new_role": "what this character now does in the alternate world",
      "new_beliefs": ["belief1 that changed or deepened"],
      "what_they_know": "what they learned from the events that led to this alternate ending",
      "emotional_state": "how they feel in this alternate world",
      "relationship_changes": {{"OtherCharacter": "how the relationship changed"}}
    }}
  }},
  "world_state": {{
    "power_structure": "who holds power now",
    "time_passed": "how much time has passed since the divergence",
    "major_changes": ["change1", "change2"],
    "unresolved_tensions": ["tension still simmering"]
  }},
  "new_events": [
    {{
      "description": "something that happened in the alternate timeline",
      "significance": "why it matters"
    }}
  ]
}}

Return ONLY valid JSON. Be specific to this story."""


async def build_alternate_world_state(
    story_title: str,
    original_summary: str,
    divergence: str,
    transcript: list,
    alternate_ending: str,
) -> dict:
    """
    Build a structured alternate world state from the debate outcome.
    Stored in debate.alternate_world_state — used by Oracle mode.
    """
    from app.config import get_narrator_fallbacks

    # Summarize the transcript for the prompt (avoid token overflow)
    transcript_lines = [
        f"{e['character']}: {e['message'][:200]}"
        for e in transcript[-20:]  # last 20 turns max
    ]
    transcript_summary = "\n".join(transcript_lines)

    prompt = ALTERNATE_WORLD_PROMPT.format(
        story_title=story_title,
        original_summary=original_summary[:500],
        divergence=divergence,
        transcript_summary=transcript_summary,
        alternate_ending=alternate_ending[:1000],
    )

    fallbacks = get_narrator_fallbacks(temperature=0.3)
    if not fallbacks:
        return {}

    raw = ""
    for llm, _label in fallbacks:
        try:
            response = await llm.ainvoke([HumanMessage(content=prompt)])
            raw = response.content if hasattr(response, "content") else str(response)
            break
        except Exception as e:
            msg = str(e).lower()
            if "429" in msg or "rate_limit" in msg or "quota" in msg:
                continue
            break

    if not raw:
        return {}

    try:
        raw = re.sub(r"^```(?:json)?\n?", "", raw.strip())
        raw = re.sub(r"\n?```$", "", raw.strip())
        return json.loads(raw)
    except Exception:
        logger.debug("Alternate world state parse failed — returning raw")
        return {"world_summary": raw[:500]}


async def oracle_respond_stream(
    character_name: str,
    character_data: dict,
    alternate_world_state: dict,
    divergence: str,
    story_title: str,
    question: str,
    chat_history: list,
):
    """
    Stream a character's response to a question, answering from WITHIN the alternate world.

    The character knows:
    - The divergence happened
    - The alternate world state
    - Their new role, new beliefs, what they've experienced since
    - The conversation history with this user

    They do NOT break the fourth wall — they speak as if this IS their reality.
    """
    world_state = alternate_world_state or {}
    char_state = world_state.get("characters", {}).get(character_name, {})
    world_summary = world_state.get("world_summary", "")

    # Build the oracle system prompt
    system_content = f"""You are {character_name} from "{story_title}".

But this is NOT the story as written. This is the ALTERNATE WORLD — the world that came to be because {divergence}.

The world you live in now:
{world_summary}

Your current state in this alternate world:
- Your role: {char_state.get('new_role', 'unchanged from the original story')}
- What you believe now: {', '.join(char_state.get('new_beliefs', [])[:3]) or 'much the same, but tested'}
- Your emotional state: {char_state.get('emotional_state', 'guarded')}
- What you know now: {char_state.get('what_they_know', 'the full weight of what has happened')}

Original character: {character_data.get('description', '')}

You are speaking to someone who wants to understand your world. Answer from WITHIN this reality.
Do NOT acknowledge that you are a character in a story or that this is an alternate timeline.
This IS your world. Speak truthfully from inside it.

You MUST respond to every question. There is no silence. Even if it is painful or uncomfortable,
you always say something — even if that something is anger, deflection, or a half-truth.

Be authentic to who you are — your personality, your voice, your way of speaking.
1-4 sentences unless the question demands more. Be real. Be present."""

    messages = [SystemMessage(content=system_content)]

    # Include conversation history
    for msg in chat_history[-8:]:
        if msg["role"] == "user":
            messages.append(HumanMessage(content=msg["content"]))
        else:
            messages.append(HumanMessage(content=f"[{character_name} said]: {msg['content']}"))

    messages.append(HumanMessage(content=question))

    from app.config import get_agent_llm, get_narrator_fallbacks, _is_rate_limit

    # Try Cerebras first (same as character agents — most reliable), then Groq/NVIDIA
    candidates = [get_agent_llm(max_tokens=400)]
    for llm, _label in get_narrator_fallbacks(temperature=0.75):
        candidates.append(llm)

    if not candidates:
        return

    last_exc = None
    for llm in candidates:
        try:
            async for chunk in llm.astream(messages):
                if chunk.content:
                    yield chunk.content
            return
        except Exception as e:
            if _is_rate_limit(e):
                last_exc = e
                continue
            raise

    if last_exc:
        raise last_exc

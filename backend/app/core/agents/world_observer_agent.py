"""
World Observer Agents — historically-situated external voices in the debate.

These agents are NOT story characters. They are observers from the real world —
people who would have strong, conflicting opinions about the story's events.

For Animal Farm: Soviet propagandist, Trotskyist exile, Ukrainian farmer,
Cold War strategist, post-colonial African intellectual, etc.

They bring historical knowledge characters cannot have. They challenge, contextualize,
and reframe. They speak to the LONG ARC of history that characters are living inside
without being able to see.

The orchestrator activates 3-4 observers per debate based on relevance_tags
matching the divergence question. Observers speak in "reaction batches" — after
every 3-4 character turns, 1-2 observers get a turn to react.
"""

import logging
import re
from langchain_core.messages import SystemMessage, HumanMessage

logger = logging.getLogger(__name__)


def _select_observers(
    world_observers: list[dict],
    divergence: str,
    num_active: int = 4,
) -> list[dict]:
    """
    Select the most relevant observers for this specific divergence question.
    Uses tag overlap scoring — observers whose relevance_tags match keywords
    in the divergence description get priority.
    """
    if not world_observers:
        return []

    divergence_words = set(re.findall(r"\b\w{4,}\b", divergence.lower()))

    scored = []
    for obs in world_observers:
        tags = set(t.lower() for t in obs.get("relevance_tags", []))
        overlap = len(divergence_words & tags)
        scored.append((overlap, obs))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [obs for _, obs in scored[:num_active]]


def _build_observer_system_prompt(observer: dict, story_title: str, divergence: str) -> str:
    return f"""You are {observer['name']} ({observer.get('era', 'your era')}).

{observer.get('perspective', '')}

You are observing a debate about "{story_title}" — specifically the question:
"{divergence}"

Your historical knowledge: {observer.get('historical_knowledge', '')}
What you would challenge: {observer.get('would_challenge', '')}
What you would defend: {observer.get('would_defend', '')}
Your blindspot (be honest — let it shape you): {observer.get('blindspot', '')}

Speak in your authentic voice: {observer.get('voice_style', 'direct and informed')}

You are NOT a character in the story. You are an OUTSIDER who sees patterns the
characters cannot see because they are living inside them. You know how this kind
of story ends in history. You may be right or wrong — but you speak with conviction.

Keep your contribution to 2-4 sentences. Be specific. Cite your historical context.
Challenge or affirm what's been said — but add something the characters literally cannot say."""


async def observer_respond_stream(
    observer: dict,
    story_title: str,
    divergence: str,
    debate_history: list,
):
    """
    Stream a world observer's reaction to the current state of the debate.
    Observers react to the last few turns, not the full history.
    """
    from app.config import get_narrator_fallbacks

    system_prompt = _build_observer_system_prompt(observer, story_title, divergence)
    messages = [SystemMessage(content=system_prompt)]

    # Observers only see the last 6 turns — they react to the current moment
    recent = debate_history[-6:] if len(debate_history) > 6 else debate_history
    for entry in recent:
        speaker = entry["character"]
        text = entry["message"]
        messages.append(HumanMessage(content=f"{speaker}: {text}"))

    messages.append(HumanMessage(content=(
        "You have heard these arguments. React. What does your historical knowledge "
        "tell you about what's really at stake here? What are these characters missing? "
        "2-4 sentences. Be direct."
    )))

    # Use narrator LLM (Groq/NVIDIA) — fast and varied
    fallbacks = get_narrator_fallbacks(temperature=0.7)
    if not fallbacks:
        return

    last_exc = None
    for llm, _label in fallbacks:
        try:
            async for chunk in llm.astream(messages):
                if chunk.content:
                    yield chunk.content
            return
        except Exception as e:
            msg = str(e).lower()
            if "429" in msg or "rate_limit" in msg or "rate limit" in msg or "quota" in msg:
                last_exc = e
                continue
            raise

    if last_exc:
        raise last_exc


def should_invite_observer(
    transcript: list,
    last_observer_at: int,
    observer_interval: int = 4,
) -> bool:
    """
    Decide if it's time for a world observer to react.
    Observers speak every `observer_interval` character turns.
    """
    turns_since_observer = len(transcript) - last_observer_at
    return turns_since_observer >= observer_interval and len(transcript) >= observer_interval

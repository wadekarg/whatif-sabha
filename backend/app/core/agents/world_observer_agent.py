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

LENGTH: Keep your commentary to 2-3 sentences MAX. Be sharp, not academic.
No policy language. No abstract theorizing. Speak from lived experience, not textbooks.
Then end with ONE directed question.

IMPORTANT: End your response by directing a sharp, specific question AT ONE of the
debating characters by name. Format the question on its own line as:
→ [CharacterName]: Your question here?

This forces them to respond directly to your historical challenge."""


def _extract_question_target(observer_text: str, valid_characters: list[str]) -> tuple[str | None, str | None]:
    """
    Extract the character being questioned and the question text from an observer response.
    Looks for the '→ [Name]:' pattern at the end of observer output.
    Returns (character_name, question_text) or (None, None) if not found.
    """
    import re
    # Match "→ CharacterName: question text?" at end of response
    pattern = r"→\s*\[?([A-Za-z][A-Za-z\s\-']+?)\]?:\s*(.+?)[\.\?!]*$"
    match = re.search(pattern, observer_text.strip(), re.MULTILINE | re.DOTALL)
    if not match:
        # Fallback: look for "→ Name:" anywhere
        match = re.search(r"→\s*([A-Za-z][A-Za-z\s\-']{1,30}):\s*(.+)", observer_text)
    if not match:
        return None, None

    name_candidate = match.group(1).strip()
    question = match.group(2).strip()

    # Fuzzy match against valid characters
    for char in valid_characters:
        if char.lower() in name_candidate.lower() or name_candidate.lower() in char.lower():
            return char, question

    return None, None


async def observer_respond_stream(
    observer: dict,
    story_title: str,
    divergence: str,
    debate_history: list,
    characters: list[str] | None = None,
    already_asked: list[str] | None = None,
):
    """
    Stream a world observer's reaction to the current state of the debate.
    The observer ends with a directed question to one of the characters.
    Observers react to the last few turns, not the full history.
    """
    from app.config import get_narrator_fallbacks

    system_prompt = _build_observer_system_prompt(observer, story_title, divergence)
    messages = [SystemMessage(content=system_prompt)]

    # Observers see the last 6 dialogue turns (not reactions/stage directions)
    recent = [e for e in debate_history if not e.get("isReaction") and not e.get("isStageDirection")][-6:]
    char_list = characters or list({e["character"] for e in debate_history if not e.get("isObserver") and not e.get("isOrchestrator")})

    for entry in recent:
        speaker = entry["character"]
        text = entry["message"]
        messages.append(HumanMessage(content=f"{speaker}: {text}"))

    # Collect this observer's own previous statements + all asked questions
    own_prev = [e["message"][:150] for e in debate_history if e.get("isObserver") and e["character"] == observer.get("name", "")]
    all_avoid = list(already_asked or []) + own_prev

    # Summarize this observer's CORE themes so they're forced to find new ground
    own_full = [e["message"] for e in debate_history if e.get("isObserver") and e["character"] == observer.get("name", "")]
    theme_summary = ""
    if own_full:
        themes = set()
        for msg in own_full:
            themes.update(re.findall(r'\b\w{5,}\b', msg.lower()))
        top_themes = sorted(themes, key=lambda w: sum(w in m.lower() for m in own_full), reverse=True)[:10]
        theme_summary = (
            f"\n\nYOU HAVE ALREADY COVERED THESE THEMES: {', '.join(top_themes)}. "
            f"Do NOT revisit them. Find a genuinely DIFFERENT angle — a new aspect of the story, "
            f"a different character to challenge, a contradiction nobody has noticed."
        )

    avoid_text = ""
    if all_avoid:
        avoid_text = (
            f"\n\nCRITICAL — These have ALREADY been said in this debate. "
            f"Do NOT repeat, rephrase, or echo any of them:\n"
            + "\n".join(f"- {q}" for q in all_avoid[-10:])
            + "\nYour commentary and question MUST be completely NEW and DIFFERENT. "
            f"Find a FRESH angle that nobody has raised yet."
            + theme_summary
        )

    messages.append(HumanMessage(content=(
        f"You have heard these arguments. React with your historical perspective. "
        f"Then END by directing a sharp question at ONE of these characters: {', '.join(char_list)}. "
        f"Format the final line as: → [CharacterName]: Your question?\n"
        f"2-4 sentences of commentary, then the directed question. Be specific and original."
        f"{avoid_text}"
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

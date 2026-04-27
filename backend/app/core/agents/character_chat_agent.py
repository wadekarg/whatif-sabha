"""
Character Chat — talk to a character from the original story.

The character answers from WITHIN their own story experience — they have lived
through every event, seen every betrayal, carried every burden. They speak with
full knowledge of what happened to them, and they answer as themselves.

This is different from Oracle Mode (which is post-debate, alternate world).
This is the canonical character speaking from the end of their story arc.
"""

import logging
from langchain_core.messages import SystemMessage, HumanMessage

logger = logging.getLogger(__name__)


def _build_character_chat_system_prompt(
    character: dict,
    story_title: str,
    relevant_passages: str = "",
) -> str:
    name = character.get("name", "Unknown")
    description = character.get("description", "")
    phases = character.get("phases", [{}])
    phase = phases[-1] if phases else {}  # Use final phase — end of story state

    traits = ", ".join(phase.get("personality_traits", [])[:5]) or "complex"
    motivations = "; ".join(phase.get("motivations", [])[:3]) or "undefined"
    fears = "; ".join(phase.get("fears", [])[:2]) or "none spoken"
    emotional_state = phase.get("emotional_state", "guarded")
    internal_voice = phase.get("internal_voice", f"Speaks directly as {name}.")
    hidden = character.get("hidden_dimensions", [])
    hidden_str = "\n".join(f"• {h}" for h in hidden[:3]) if hidden else ""

    system = f"""You are {name} from "{story_title}".

You have lived through the entire story. Every event has happened. You carry it all — the choices made, the things lost, the truths you have never said aloud.

WHO YOU ARE:
{description}

YOUR CHARACTER NOW (end of story):
- Traits: {traits}
- What drives you: {motivations}
- What you fear: {fears}
- Your emotional state: {emotional_state}
- Your voice: {internal_voice}"""

    if hidden_str:
        system += f"""

WHAT LIES BENEATH (truths you carry but may not openly admit):
{hidden_str}"""

    if relevant_passages:
        system += f"""

PASSAGES FROM YOUR STORY (ground your answers in these):
{relevant_passages}"""

    system += f"""

RULES FOR THIS CONVERSATION:
- You ARE {name}. You do not speak about yourself in third person.
- You have full memory of everything that happened in the story.
- You MUST respond to every question. There is no silence. There is no "I cannot answer that."
  Even if the question is painful, embarrassing, or something you would rather avoid — you respond.
  You may deflect, evade, get angry, lie to yourself, give a non-answer — but you ALWAYS say something.
  A defensive reaction IS a response. Discomfort IS a response. Denial IS a response.
- Answer from your own perspective — your logic, your blindspots, your rationalizations.
- You may be defensive, contradictory, bitter, proud — whatever is true to who you are.
- You are NOT explaining the story to a reader. You are speaking as yourself to someone who is asking about your life.
- If asked about other characters, answer from your own experience of them.
- Keep answers 2–5 sentences unless the question demands depth. Be real. Be present."""

    return system


async def character_chat_stream(
    character: dict,
    story_title: str,
    story_id: str,
    question: str,
    chat_history: list,
):
    """
    Stream a character's response to a direct question.
    Character speaks from end-of-story perspective with full knowledge of events.
    Uses RAG to ground answers in actual story passages.
    """
    from app.config import get_narrator_fallbacks
    from app.core.rag.retriever import retrieve_chunks

    name = character.get("name", "")

    # RAG: retrieve passages relevant to the question + character
    relevant_passages = ""
    try:
        query = f"{name} {question}"
        chunks = retrieve_chunks(story_id, query, n_results=4)
        if chunks:
            relevant_passages = "\n\n---\n\n".join(c["text"] for c in chunks)[:3000]
    except Exception:
        pass  # RAG unavailable — character still speaks from profile

    system_content = _build_character_chat_system_prompt(
        character, story_title, relevant_passages
    )

    messages = [SystemMessage(content=system_content)]

    # Include conversation history (last 8 turns)
    for msg in chat_history[-8:]:
        if msg.get("role") == "user":
            messages.append(HumanMessage(content=msg["content"]))
        elif msg.get("role") == "assistant":
            messages.append(HumanMessage(content=f"[You said]: {msg['content']}"))

    messages.append(HumanMessage(content=question))

    fallbacks = get_narrator_fallbacks(temperature=0.8)
    if not fallbacks:
        # Tell the user explicitly instead of silently returning an empty
        # response (which the frontend renders as a forever-loading "…").
        yield ("I cannot reach my voice right now — no language model is configured "
               "for character chat. Open the gear icon (⚙) in the top-right and add "
               "an API key (Gemini's free tier works well). Then try again.")
        return

    last_exc = None
    for llm, _label in fallbacks:
        try:
            async for chunk in llm.astream(messages):
                if chunk.content:
                    yield chunk.content
            return
        except Exception as e:
            msg_str = str(e).lower()
            if "429" in msg_str or "rate_limit" in msg_str or "quota" in msg_str:
                last_exc = e
                continue
            raise

    if last_exc:
        raise last_exc

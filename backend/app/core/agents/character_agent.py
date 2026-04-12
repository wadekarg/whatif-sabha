from langchain_core.messages import SystemMessage, HumanMessage
from app.config import get_agent_llm, get_agent_fallbacks
from app.core.agents.base_agent import build_character_system_prompt


def _build_turn_prompt(
    character_name: str,
    debate_history: list,
    correction_hint: str = None,
) -> tuple[str, bool]:
    """
    Build a context-aware turn prompt.
    Returns (prompt_text, is_direct_response).
    is_direct_response=True means the character was directly addressed — use higher token limit.
    """
    is_direct = False

    if not debate_history:
        prompt = (
            "The debate is opening. Speak your first words on this scenario — "
            "set your position clearly and forcefully."
        )
    else:
        last = debate_history[-1]
        last_speaker = last["character"]
        last_msg = last["message"]
        target = last.get("target_character")

        snippet = last_msg[:250].rstrip() + ("…" if len(last_msg) > 250 else "")

        if target == character_name:
            is_direct = True
            prompt = (
                f'{last_speaker} just spoke directly to you:\n"{snippet}"\n\n'
                f'You MUST respond to {last_speaker} — directly and personally. '
                f'Name the specific claim they made. Either counter it with your own logic, '
                f'concede a point and reframe it, or attack the premise entirely. '
                f'Do not speak in vague generalities. Speak to THIS argument. '
                f'2–4 sentences unless this is a pivotal moment that demands more.'
            )
        elif "?" in last_msg and character_name.lower() in last_msg.lower():
            is_direct = True
            prompt = (
                f'{last_speaker} just called your name:\n"{snippet}"\n\n'
                f'They asked you something specific. Answer it directly — '
                f'engage with their actual question, not around it. '
                f'2–3 sentences.'
            )
        else:
            prompt = (
                f'{last_speaker} just said:\n"{snippet}"\n\n'
                f'React. Push back or build on it — stay sharp. '
                f'1–2 sentences unless you have something major to reveal.'
            )

    if correction_hint:
        prompt += f"\n\nIMPORTANT: Your last response was flagged. Correction needed: {correction_hint}"

    return prompt, is_direct


def _inject_memories(messages: list, memories: list[str]) -> None:
    """Inject past memories as a framing message right after the system prompt."""
    if not memories:
        return
    memory_lines = "\n".join(f"• {m}" for m in memories)
    messages.insert(1, HumanMessage(content=(
        f"[YOUR MEMORY — positions and truths you have revealed in previous debates]\n"
        f"{memory_lines}\n"
        f"This is your accumulated experience. Let it inform — but not constrain — how you speak today."
    )))


async def character_respond(
    character: dict,
    phase: dict,
    divergence: str,
    debate_history: list,
    story_title: str = "",
    exploration_hint: str = None,
    memory_context: list[str] = None,
) -> str:
    character["story_title"] = story_title
    system_prompt = build_character_system_prompt(character, phase, divergence)

    messages = [SystemMessage(content=system_prompt)]

    _inject_memories(messages, memory_context or [])

    for entry in debate_history[-12:]:
        speaker = entry["character"]
        text = entry["message"]
        if speaker == character["name"]:
            messages.append(HumanMessage(content=f"[You previously said]: {text}"))
        else:
            messages.append(HumanMessage(content=f"{speaker}: {text}"))

    turn_prompt, is_direct = _build_turn_prompt(character["name"], debate_history)
    messages.append(HumanMessage(content=turn_prompt))

    if exploration_hint:
        messages.append(HumanMessage(content=(
            f"[HIDDEN TRUTH — this is something deep and true about you that you have never said aloud. "
            f"Let it surface in what you say now, naturally — do not announce it, just let it shape your words]: "
            f"{exploration_hint}"
        )))

    llm = get_agent_llm(max_tokens=300 if is_direct else 180)
    response = await llm.ainvoke(messages)
    return response.content.strip()


async def character_respond_stream(
    character: dict,
    phase: dict,
    divergence: str,
    debate_history: list,
    story_title: str = "",
    correction_hint: str = None,
    exploration_hint: str = None,
    memory_context: list[str] = None,
    observer_challenge: dict | None = None,
):
    character["story_title"] = story_title
    system_prompt = build_character_system_prompt(character, phase, divergence)

    messages = [SystemMessage(content=system_prompt)]

    _inject_memories(messages, memory_context or [])

    for entry in debate_history[-12:]:
        speaker = entry["character"]
        text = entry["message"]
        if speaker == character["name"]:
            messages.append(HumanMessage(content=f"[You previously said]: {text}"))
        else:
            messages.append(HumanMessage(content=f"{speaker}: {text}"))

    turn_prompt, is_direct = _build_turn_prompt(character["name"], debate_history, correction_hint)
    messages.append(HumanMessage(content=turn_prompt))

    if observer_challenge:
        messages.append(HumanMessage(content=(
            f"[DIRECT CHALLENGE FROM OUTSIDE THE STORY]\n"
            f"{observer_challenge['observer_name']} — a historical observer — has just confronted you:\n"
            f"\"{observer_challenge['question']}\"\n\n"
            f"You MUST respond to this challenge in your reply. Address it head-on — with your own logic, "
            f"your own values, your own blindspot if necessary. Do not ignore it."
        )))

    if exploration_hint:
        messages.append(HumanMessage(content=(
            f"[HIDDEN TRUTH — this is something deep and true about you that you have never said aloud. "
            f"Let it surface in what you say now, naturally — do not announce it, just let it shape your words]: "
            f"{exploration_hint}"
        )))

    # Try Cerebras → OpenRouter → Groq (full fallback chain)
    from app.config import _is_rate_limit

    token_limit = 300 if is_direct else 180
    fallbacks = get_agent_fallbacks(max_tokens=token_limit)

    last_exc = None
    for llm, _label in fallbacks:
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


async def character_continue_stream(
    character: dict,
    phase: dict,
    divergence: str,
    debate_history: list,
    story_title: str = "",
    previous_response: str = "",
    continuation_reason: str = "",
    exploration_hint: str = None,
):
    """
    A second pass for a character when the judge grants them more space.
    They pick up where they left off — deeper, rawer, unburdened.
    """
    from langchain_core.messages import SystemMessage, HumanMessage
    character["story_title"] = story_title
    system_prompt = build_character_system_prompt(character, phase, divergence)

    messages = [SystemMessage(content=system_prompt)]

    for entry in debate_history[-12:]:
        speaker = entry["character"]
        text = entry["message"]
        if speaker == character["name"]:
            messages.append(HumanMessage(content=f"[You previously said]: {text}"))
        else:
            messages.append(HumanMessage(content=f"{speaker}: {text}"))

    prompt = (
        f"You just said:\n\"{previous_response}\"\n\n"
        f"The debate has granted you more time. The reason: {continuation_reason}\n\n"
        f"Continue from where you left off. Do NOT repeat what you already said — "
        f"go deeper. Say the thing you were holding back. "
        f"The burden is yours. Speak."
    )
    messages.append(HumanMessage(content=prompt))

    if exploration_hint:
        messages.append(HumanMessage(content=(
            f"[HIDDEN TRUTH — this is something deep and true about you that you have never said aloud. "
            f"Let it surface in what you say now, naturally — do not announce it, just let it shape your words]: "
            f"{exploration_hint}"
        )))

    llm = get_agent_llm(max_tokens=550)
    async for chunk in llm.astream(messages):
        if chunk.content:
            yield chunk.content

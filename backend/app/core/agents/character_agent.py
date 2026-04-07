from langchain_core.messages import SystemMessage, HumanMessage
from app.config import get_agent_llm
from app.core.agents.base_agent import build_character_system_prompt


def _build_turn_prompt(character_name: str, debate_history: list, correction_hint: str = None) -> str:
    """
    Build a context-aware turn prompt based on what just happened in the debate.
    The character should know WHY they're speaking now — not just that it's "their turn".
    """
    if not debate_history:
        prompt = "The debate is opening. Speak your first words on this scenario — set your position."
    else:
        last = debate_history[-1]
        last_speaker = last["character"]
        last_msg = last["message"]
        target = last.get("target_character")

        # Truncate last message for context — first 200 chars is enough
        snippet = last_msg[:200].rstrip() + ("…" if len(last_msg) > 200 else "")

        if target == character_name:
            # Directly addressed — must respond
            prompt = (
                f'{last_speaker} just spoke directly to you:\n"{snippet}"\n\n'
                f'Respond to {last_speaker} — directly, personally. '
                f'Keep it tight: 1–3 sentences unless this is a breaking-point moment.'
            )
        elif "?" in last_msg and character_name.lower() in last_msg.lower():
            # Named in a question
            prompt = (
                f'{last_speaker} just called your name:\n"{snippet}"\n\n'
                f'Answer them. Be direct. 1–3 sentences.'
            )
        else:
            # General — react or push the debate
            prompt = (
                f'{last_speaker} just said:\n"{snippet}"\n\n'
                f'React or push back — sharply. 1–2 sentences unless you have something major to reveal.'
            )

    if correction_hint:
        prompt += f"\n\nIMPORTANT: Your last response was flagged as out of character. Correction needed: {correction_hint}"

    return prompt


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

    messages.append(HumanMessage(content=_build_turn_prompt(character["name"], debate_history)))

    if exploration_hint:
        messages.append(HumanMessage(content=(
            f"[HIDDEN TRUTH — this is something deep and true about you that you have never said aloud. "
            f"Let it surface in what you say now, naturally — do not announce it, just let it shape your words]: "
            f"{exploration_hint}"
        )))

    llm = get_agent_llm()
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

    messages.append(HumanMessage(content=_build_turn_prompt(character["name"], debate_history, correction_hint)))

    if exploration_hint:
        messages.append(HumanMessage(content=(
            f"[HIDDEN TRUTH — this is something deep and true about you that you have never said aloud. "
            f"Let it surface in what you say now, naturally — do not announce it, just let it shape your words]: "
            f"{exploration_hint}"
        )))

    llm = get_agent_llm()
    async for chunk in llm.astream(messages):
        if chunk.content:
            yield chunk.content


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

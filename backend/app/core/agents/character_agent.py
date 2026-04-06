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
                f'It can be one sentence or ten. Match the emotional weight of what was just said.'
            )
        elif "?" in last_msg and character_name.lower() in last_msg.lower():
            # Named in a question
            prompt = (
                f'{last_speaker} just called your name:\n"{snippet}"\n\n'
                f'They want a response from you. Give it to them — honest, emotional, in character.'
            )
        else:
            # General — react or push the debate
            prompt = (
                f'{last_speaker} just said:\n"{snippet}"\n\n'
                f'Speak now — react, challenge, reveal something, or drive the debate forward. '
                f'Be as brief or as full as the moment demands.'
            )

    if correction_hint:
        prompt += f"\n\nIMPORTANT: Your last response was flagged as out of character. Correction needed: {correction_hint}"

    return prompt


async def character_respond(
    character: dict,
    phase: dict,
    divergence: str,
    debate_history: list,
    story_title: str = "",
) -> str:
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

    messages.append(HumanMessage(content=_build_turn_prompt(character["name"], debate_history)))

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
):
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

    messages.append(HumanMessage(content=_build_turn_prompt(character["name"], debate_history, correction_hint)))

    llm = get_agent_llm()
    async for chunk in llm.astream(messages):
        if chunk.content:
            yield chunk.content

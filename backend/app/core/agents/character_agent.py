from langchain_core.messages import SystemMessage, HumanMessage
from app.config import get_agent_llm
from app.core.agents.base_agent import build_character_system_prompt


async def character_respond(
    character: dict,
    phase: dict,
    divergence: str,
    debate_history: list,
    story_title: str = "",
) -> str:
    """
    Generate a response from a character agent given the current debate history.
    Streams internally but returns full response string.
    """
    character["story_title"] = story_title
    system_prompt = build_character_system_prompt(character, phase, divergence)

    messages = [SystemMessage(content=system_prompt)]

    # Add debate history as conversation context
    for entry in debate_history[-12:]:  # Last 12 turns to keep context manageable
        speaker = entry["character"]
        text = entry["message"]
        if speaker == character["name"]:
            messages.append(HumanMessage(content=f"[You previously said]: {text}"))
        else:
            messages.append(HumanMessage(content=f"{speaker}: {text}"))

    messages.append(
        HumanMessage(content="It's your turn to speak. Respond as your character.")
    )

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
    """
    Stream a character's response token by token.
    Yields string chunks.
    """
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

    turn_prompt = "It's your turn to speak. Respond as your character."
    if correction_hint:
        turn_prompt += f"\n\nCRITICAL: Your previous response was out of character. Fix this: {correction_hint}"

    messages.append(HumanMessage(content=turn_prompt))

    llm = get_agent_llm()
    async for chunk in llm.astream(messages):
        if chunk.content:
            yield chunk.content

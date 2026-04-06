from app.config import get_narrator_llm


async def synthesize_ending(
    story_title: str,
    original_summary: str,
    divergence_description: str,
    debate_transcript: list,
) -> str:
    """
    Read the full debate and synthesize a coherent alternate ending as prose.
    """
    llm = get_narrator_llm()

    transcript_text = "\n".join(
        f"{entry['character']}: {entry['message']}"
        for entry in debate_transcript
    )

    prompt = f"""You are the narrator of "{story_title}".

ORIGINAL STORY SUMMARY:
{original_summary}

THE ALTERNATE SCENARIO BEING EXPLORED:
{divergence_description}

THE CHARACTERS DEBATED AND REACHED THESE CONCLUSIONS:
{transcript_text}

Now write the alternate ending as a proper story passage (400-600 words).
- Write in the same tone and style as the original story
- Show how each major character's arc changes based on the debate
- Be specific — reference actual events and character decisions from the debate
- End with a sense of closure, even if bittersweet
- Write as narrative prose, not as dialogue

THE ALTERNATE ENDING:"""

    response = await llm.ainvoke(prompt)
    return response.content.strip()


async def synthesize_ending_stream(
    story_title: str,
    original_summary: str,
    divergence_description: str,
    debate_transcript: list,
):
    """Stream the alternate ending token by token."""
    llm = get_narrator_llm()

    transcript_text = "\n".join(
        f"{entry['character']}: {entry['message']}"
        for entry in debate_transcript
    )

    prompt = f"""You are the narrator of "{story_title}".

ORIGINAL STORY SUMMARY:
{original_summary}

THE ALTERNATE SCENARIO BEING EXPLORED:
{divergence_description}

THE CHARACTERS DEBATED AND REACHED THESE CONCLUSIONS:
{transcript_text}

Write the alternate ending as a proper story passage (400-600 words).
Write in narrative prose. Be specific. Reference the debate conclusions.

THE ALTERNATE ENDING:"""

    async for chunk in llm.astream(prompt):
        if chunk.content:
            yield chunk.content

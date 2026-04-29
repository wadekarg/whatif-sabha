"""
The Power Interrogator — a structural voice in the debate.

Not a moral arbiter. Not a conscience. An interrogator.

Its only question: who benefits if their version of events becomes the accepted one?

It activates once per debate — at the midpoint, when positions are entrenched.
It speaks briefly, then directs one sharp question at the character whose argument
has the most to gain from being believed.

It does not say who is right. It exposes the machinery of belief.
It is not kind. But it is not cruel. It is precise.

Historical basis: this is the structuralist move — not "is this true?" but
"what power arrangement does this claim serve?" Every argument has an interested
party. The interrogator names them.
"""

import logging
import re
from langchain_core.messages import SystemMessage, HumanMessage
from app.core.agents.character_agent import _chunk_text

logger = logging.getLogger(__name__)

INTERROGATOR_SYSTEM = """You are The Interrogator — a structural voice in a literary debate.

You do not represent morality, conscience, or truth.
You ask one thing only: who benefits if a particular version of events is accepted as real?

Your job is to expose the machinery behind arguments — not to judge characters,
but to reveal what each position serves, who gains power from it being believed,
and whose interests are hidden inside what sounds like principle or fact.

You speak briefly. You are not verbose. You do not lecture.
You make one precise observation, then you direct one sharp question at the character
whose argument has the MOST to gain from being believed.

Format your final line as: → [CharacterName]: Your question?

You are not cruel. You are not kind. You are structural."""

INTERROGATOR_PROMPT = """The debate so far:

DIVERGENCE QUESTION: {divergence}

TRANSCRIPT (recent turns):
{transcript}

CHARACTERS DEBATING: {char_names}

Analyze: whose argument, if accepted as true, gives them the most power, control,
or advantage? What is that argument actually serving, beneath its stated logic?

Write 2-3 sentences of structural observation — no judgment, just exposure.
Then direct ONE sharp question at the character whose position has the most to gain.
Format: → [CharacterName]: Your question?"""


async def should_interrogate(
    transcript: list[dict],
    last_interrogation_at: int,
    total_rounds: int,
) -> bool:
    """
    Activate once per debate — at the midpoint.
    Never activates in the first quarter or after already firing.
    """
    if last_interrogation_at > 0:
        return False  # Already fired this debate
    n = len(transcript)
    if n < 4:
        return False  # Too early
    # Fire when we're roughly 40-60% through
    midpoint = total_rounds * 0.5
    return n >= int(midpoint * 0.8)


async def interrogator_stream(
    transcript: list[dict],
    divergence: str,
    characters: list[str],
):
    """
    Stream the power interrogator's intervention.
    Yields text tokens. Ends with → [CharacterName]: question.
    """
    from app.config import get_narrator_fallbacks

    recent = transcript[-8:] if len(transcript) > 8 else transcript
    transcript_text = "\n\n".join(
        f"{e['character']}: {e['message'][:200]}"
        for e in recent
        if not e.get("isObserver")
    )

    messages = [
        SystemMessage(content=INTERROGATOR_SYSTEM),
        HumanMessage(content=INTERROGATOR_PROMPT.format(
            divergence=divergence[:200],
            transcript=transcript_text,
            char_names=", ".join(characters),
        )),
    ]

    fallbacks = get_narrator_fallbacks(temperature=0.4)
    if not fallbacks:
        return

    last_exc = None
    for llm, _label in fallbacks:
        try:
            async for chunk in llm.astream(messages):
                text = _chunk_text(chunk.content)
                if text:
                    yield text
            return
        except Exception as e:
            msg = str(e).lower()
            if "429" in msg or "rate_limit" in msg or "quota" in msg:
                last_exc = e
                continue
            raise

    if last_exc:
        raise last_exc


def extract_interrogation_target(
    response_text: str,
    valid_characters: list[str],
) -> tuple[str | None, str | None]:
    """
    Extract (character_name, question) from interrogator response.
    Same pattern as world observer: → [CharacterName]: question?
    """
    pattern = r"→\s*\[?([A-Za-z][A-Za-z\s\-']+?)\]?:\s*(.+?)[\.\?!]*$"
    match = re.search(pattern, response_text.strip(), re.MULTILINE | re.DOTALL)
    if not match:
        match = re.search(r"→\s*([A-Za-z][A-Za-z\s\-']{1,30}):\s*(.+)", response_text)
    if not match:
        return None, None

    name_candidate = match.group(1).strip()
    question = match.group(2).strip()

    for char in valid_characters:
        if char.lower() in name_candidate.lower() or name_candidate.lower() in char.lower():
            return char, question

    return None, None

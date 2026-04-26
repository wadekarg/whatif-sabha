import asyncio
from app.config import get_analysis_llm, get_agent_llm, get_judge_llm, _make_nvidia_llm, get_settings

PERSPECTIVE_PROMPT = """You are a literary scholar analyzing the character "{character_name}" from "{story_title}".

THE STORY DESCRIBES THIS CHARACTER AS:
{narrative_description}

THEIR KEY ACTIONS IN THE STORY:
{key_actions}

ADDITIONAL CONTEXT FROM EXTERNAL SOURCES:
{external_context}

Provide a FAIR, CRITICAL analysis of this character. The story may be written from a biased perspective — your job is to see past that.

Answer these specifically:
1. What legitimate motivations explain their actions? (assume they had reasons)
2. Where is the original narrative unfair or biased against them?
3. What is the most charitable interpretation of their worst moments?
4. What do they value most deeply — what would they die defending?
5. What pain or injustice shaped who they became?
6. How would THEY tell their own story if given the chance?

Be specific to THIS character. Do not be generic. Do not repeat the plot.
Write 200-300 words of genuine analysis."""


async def get_all_perspectives(
    character: dict,
    story_title: str,
    external_context: str,
) -> dict:
    """
    Get three independent LLM perspectives on a character simultaneously.
    Different models = different training biases = more balanced synthesis.
    """
    key_actions = _extract_key_actions(character)
    narrative_desc = character.get("description", "No description available.")

    prompt = PERSPECTIVE_PROMPT.format(
        character_name=character["name"],
        story_title=story_title,
        narrative_description=narrative_desc,
        key_actions=key_actions,
        external_context=external_context or "No external context available.",
    )

    # Run perspectives in parallel — different model families = different analytical biases.
    # Each get_X_llm() raises ValueError if no key for that role is configured. We wrap
    # those calls so the gather doesn't blow up when the user only has one or two providers.
    def _safe_get(getter, label):
        try:
            llm = getter()
            return _get_perspective(llm, prompt, label) if llm else None
        except Exception as e:
            print(f"  [{label}] perspective skipped — provider not configured: {str(e)[:80]}")
            return None

    gemini_task   = _safe_get(get_analysis_llm, "gemini")
    groq_task     = _safe_get(get_judge_llm, "groq")
    cerebras_task = _safe_get(get_agent_llm, "cerebras")

    # NVIDIA — separate path; the make_nvidia_llm helper already returns None when unconfigured
    s = get_settings()
    nvidia_task = None
    try:
        nvidia_llm = _make_nvidia_llm(s.NVIDIA_JUDGE_MODEL, temperature=0.3)
        if nvidia_llm:
            nvidia_task = _get_perspective(nvidia_llm, prompt, "nvidia")
    except Exception:
        pass

    pairs = [
        ("gemini",   gemini_task),
        ("groq",     groq_task),
        ("cerebras", cerebras_task),
        ("nvidia",   nvidia_task),
    ]
    active = [(label, t) for label, t in pairs if t is not None]
    if not active:
        # No providers configured at all — return empty perspectives (caller handles this).
        return {label: "[Analysis unavailable: no provider configured]" for label, _ in pairs}

    results = await asyncio.gather(*[t for _, t in active], return_exceptions=True)

    perspectives = {label: "[Analysis unavailable: provider not configured]" for label, _ in pairs}
    for (label, _), result in zip(active, results):
        if isinstance(result, Exception):
            perspectives[label] = f"[Analysis unavailable: {str(result)[:100]}]"
        else:
            perspectives[label] = result

    return perspectives


async def _get_perspective(llm, prompt: str, label: str, timeout: float = 30.0) -> str:
    """Call a single LLM for its perspective. Returns text. Hard timeout per LLM."""
    try:
        response = await asyncio.wait_for(llm.ainvoke(prompt), timeout=timeout)
        content = response.content
        # Handle list content (new Google SDK)
        if isinstance(content, list):
            content = "".join(
                part.get("text", "") if isinstance(part, dict) else str(part)
                for part in content
            )
        return content.strip()
    except asyncio.TimeoutError:
        raise Exception(f"{label} perspective timed out ({timeout}s)")
    except Exception as e:
        raise Exception(f"{label} perspective failed: {str(e)}")


def _extract_key_actions(character: dict) -> str:
    """Build a summary of the character's key actions from their phase data."""
    phases = character.get("phases", [])
    if not phases:
        return "No detailed phase data available."

    actions = []
    for phase in phases:
        motivations = phase.get("motivations", [])
        traits = phase.get("personality_traits", [])
        emotional = phase.get("emotional_state", "")
        if motivations or traits:
            actions.append(
                f"Phase '{phase.get('phase_id', 'unknown')}': "
                f"Motivated by {', '.join(motivations)}. "
                f"Traits: {', '.join(traits)}. "
                f"State: {emotional}"
            )

    return "\n".join(actions) if actions else "Character phases not detailed."

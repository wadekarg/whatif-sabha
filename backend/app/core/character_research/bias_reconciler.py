import json
import re
from app.config import get_analysis_llm

RECONCILER_PROMPT = """You are synthesizing multiple sources to build a FAIR WITNESS profile of "{character_name}" from "{story_title}".

Your job: cut through narrative bias and find the truth of who this character is.

--- NARRATIVE PORTRAYAL (from the original text) ---
{narrative_portrayal}

--- WIKIPEDIA / SCHOLARLY DATA ---
{wikipedia_data}

--- WEB LITERARY ANALYSIS ---
{web_analysis}

--- GEMINI'S INDEPENDENT ANALYSIS ---
{gemini_perspective}

--- LLAMA/GROQ'S INDEPENDENT ANALYSIS ---
{groq_perspective}

--- QWEN/CEREBRAS'S INDEPENDENT ANALYSIS ---
{cerebras_perspective}

--- KIMI/NVIDIA'S INDEPENDENT ANALYSIS ---
{nvidia_perspective}

Now synthesize all of this into a fair witness profile. Return ONLY valid JSON:

{{
  "consensus_view": "what ALL sources broadly agree on about this character",
  "disputed_aspects": ["aspect where sources genuinely disagree 1", "aspect 2"],
  "narrative_bias": "specifically where/how the original story is unfair to this character — be concrete",
  "hidden_motivations": "what truly drives this character that the story glosses over or hides",
  "charitable_reading": "the most generous, fair interpretation of their most controversial actions",
  "fair_personality_traits": ["trait1", "trait2", "trait3", "trait4"],
  "fair_role": "how to fairly describe their role — avoid 'villain' or 'antagonist' framing if unjustified",
  "cultural_historical_context": "relevant background that explains their world and choices",
  "speaks_as": "describe their authentic voice for debate — tone, manner, what they care about, how they argue",
  "what_they_would_say": "one powerful statement this character would make if they could speak their full truth",
  "sources_used": ["wikipedia", "web_analysis", "gemini", "groq", "cerebras", "nvidia"]
}}"""


async def reconcile_perspectives(
    character: dict,
    story_title: str,
    wikipedia_data: dict | None,
    web_analysis: list,
    llm_perspectives: dict,
) -> dict:
    """
    Synthesize all research sources into a fair witness profile.
    This is the final step — the output becomes each character agent's true foundation.
    """
    llm = get_analysis_llm()

    wiki_text = _format_wikipedia(wikipedia_data)
    web_text = _format_web_analysis(web_analysis)

    prompt = RECONCILER_PROMPT.format(
        character_name=character["name"],
        story_title=story_title,
        narrative_portrayal=character.get("description", "Not described."),
        wikipedia_data=wiki_text,
        web_analysis=web_text,
        gemini_perspective=llm_perspectives.get("gemini", "Not available."),
        groq_perspective=llm_perspectives.get("groq", "Not available."),
        cerebras_perspective=llm_perspectives.get("cerebras", "Not available."),
        nvidia_perspective=llm_perspectives.get("nvidia", "Not available."),
    )

    response = await llm.ainvoke(prompt)
    raw = response.content

    if isinstance(raw, list):
        raw = "".join(
            part.get("text", "") if isinstance(part, dict) else str(part)
            for part in raw
        )

    raw = re.sub(r"^```(?:json)?\n?", "", raw.strip())
    raw = re.sub(r"\n?```$", "", raw.strip())

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # Return a minimal valid profile if parsing fails
        return {
            "consensus_view": character.get("description", ""),
            "disputed_aspects": [],
            "narrative_bias": "Could not determine — synthesis failed.",
            "hidden_motivations": "Unknown.",
            "charitable_reading": "Unknown.",
            "fair_personality_traits": [],
            "fair_role": character.get("role", "character"),
            "cultural_historical_context": "",
            "speaks_as": "Speaks as themselves.",
            "what_they_would_say": "",
            "sources_used": [],
        }


def _format_wikipedia(wiki_data: dict | None) -> str:
    if not wiki_data or not wiki_data.get("found"):
        return "No Wikipedia article found for this character."

    parts = []
    if wiki_data.get("description"):
        parts.append(f"Description: {wiki_data['description']}")
    if wiki_data.get("summary"):
        parts.append(f"Summary: {wiki_data['summary'][:800]}")
    if wiki_data.get("full_extract"):
        parts.append(f"Analysis sections:\n{wiki_data['full_extract'][:1200]}")

    return "\n\n".join(parts) if parts else "No useful content found."


def _format_web_analysis(web_results: list) -> str:
    if not web_results:
        return "No web analysis found."

    parts = []
    for r in web_results[:3]:
        parts.append(
            f"Source: {r.get('title', 'Unknown')} ({r.get('url', '')})\n"
            f"{r.get('content', '')[:800]}"
        )

    return "\n\n---\n\n".join(parts)

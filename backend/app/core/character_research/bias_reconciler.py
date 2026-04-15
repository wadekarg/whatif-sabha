import json
import re
from app.config import invoke_analysis_with_fallback

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

    Uses invoke_analysis_with_fallback so a single provider's rate limit / slowness
    doesn't kill the whole research pass.
    """
    from langchain_core.messages import HumanMessage

    wiki_text = _format_wikipedia(wikipedia_data)
    web_text = _format_web_analysis(web_analysis)

    # Count how many usable perspectives we have (not "[Analysis unavailable...")
    usable = sum(
        1 for v in llm_perspectives.values()
        if v and not v.startswith("[Analysis unavailable")
    )
    sources_used = [k for k, v in llm_perspectives.items() if v and not v.startswith("[Analysis unavailable")]
    if wiki_text and "No Wikipedia" not in wiki_text:
        sources_used.append("wikipedia")
    if web_text and "No web" not in web_text:
        sources_used.append("web_analysis")

    # Even with 0 web sources, if we have at least 1 LLM perspective, synthesize.
    # Only skip if we truly have nothing to work with.
    if usable == 0 and not (wiki_text and "No Wikipedia" not in wiki_text):
        return {
            "consensus_view": character.get("description", ""),
            "disputed_aspects": [],
            "narrative_bias": "Could not determine — no perspectives available.",
            "hidden_motivations": "Unknown.",
            "charitable_reading": "Unknown.",
            "fair_personality_traits": [],
            "fair_role": character.get("role", "character"),
            "cultural_historical_context": "",
            "speaks_as": "Speaks as themselves.",
            "what_they_would_say": "",
            "sources_used": [],
        }

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

    raw = await invoke_analysis_with_fallback([HumanMessage(content=prompt)])

    if not raw:
        # All providers failed / rate-limited — return minimal profile
        return {
            "consensus_view": character.get("description", ""),
            "disputed_aspects": [],
            "narrative_bias": "Could not determine — all synthesis providers unavailable.",
            "hidden_motivations": "Unknown.",
            "charitable_reading": "Unknown.",
            "fair_personality_traits": [],
            "fair_role": character.get("role", "character"),
            "cultural_historical_context": "",
            "speaks_as": "Speaks as themselves.",
            "what_they_would_say": "",
            "sources_used": [],
        }

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

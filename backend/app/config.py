from pydantic_settings import BaseSettings
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_groq import ChatGroq
from langchain_cerebras import ChatCerebras
from functools import lru_cache
from typing import Optional

# Runtime key overrides — set via /settings/keys endpoint from the UI
_runtime_keys: dict[str, str] = {}


def update_runtime_keys(
    gemini_key: str = None,
    groq_key: str = None,
    cerebras_key: str = None,
    nvidia_key: str = None,
    openrouter_key: str = None,
):
    if gemini_key:
        _runtime_keys["GEMINI_API_KEY"] = gemini_key
    if groq_key:
        _runtime_keys["GROQ_API_KEY"] = groq_key
    if cerebras_key:
        _runtime_keys["CEREBRAS_API_KEY"] = cerebras_key
    if nvidia_key:
        _runtime_keys["NVIDIA_API_KEY"] = nvidia_key
    if openrouter_key:
        _runtime_keys["OPENROUTER_API_KEY"] = openrouter_key


def get_runtime_keys() -> dict:
    return _runtime_keys


class Settings(BaseSettings):
    GEMINI_API_KEY: Optional[str] = None
    GROQ_API_KEY: Optional[str] = None
    CEREBRAS_API_KEY: Optional[str] = None
    NVIDIA_API_KEY: Optional[str] = None
    OPENROUTER_API_KEY: Optional[str] = None

    DATABASE_URL: str = "sqlite+aiosqlite:///./whatif_sabha.db"
    REDIS_URL: str = "redis://localhost:6379"
    UPLOAD_DIR: str = "./uploads"
    MAX_UPLOAD_SIZE_MB: int = 50

    # Feature flags
    ENABLE_LIGHTRAG: bool = False

    # Primary model IDs
    ANALYSIS_MODEL: str = "gemini-3.1-flash-lite-preview"
    CHARACTER_AGENT_MODEL: str = "qwen-3-235b-a22b-instruct-2507"
    JUDGE_MODEL: str = "llama-3.3-70b-versatile"
    NARRATOR_MODEL: str = "llama-3.3-70b-versatile"
    # NVIDIA NIM models — no daily token limit, ~40 RPM free tier
    NVIDIA_JUDGE_MODEL: str = "moonshotai/kimi-k2-instruct"     # strong structured reasoning
    NVIDIA_NARRATOR_MODEL: str = "meta/llama-3.3-70b-instruct"  # reliable prose, same base as Groq primary

    class Config:
        env_file = ".env"


@lru_cache()
def get_settings() -> Settings:
    return Settings()


def _key(env_key: str) -> str:
    """Return runtime override if set, else fall back to .env value."""
    return _runtime_keys.get(env_key) or (get_settings().__dict__.get(env_key) or "")


def _is_rate_limit(exc: Exception) -> bool:
    """Detect rate-limit / quota errors from any provider."""
    msg = str(exc).lower()
    return "429" in msg or "rate_limit" in msg or "rate limit" in msg or "quota" in msg


def _make_groq_llm(model: str, temperature: float = 0.1):
    key = _key("GROQ_API_KEY")
    if not key:
        return None
    return ChatGroq(model=model, groq_api_key=key, temperature=temperature)


def _make_nvidia_llm(model: str, temperature: float = 0.1):
    """NVIDIA NIM — OpenAI-compatible endpoint."""
    from langchain_openai import ChatOpenAI
    key = _key("NVIDIA_API_KEY")
    if not key:
        return None
    return ChatOpenAI(
        model=model,
        api_key=key,
        base_url="https://integrate.api.nvidia.com/v1",
        temperature=temperature,
    )


def _make_openrouter_llm(model: str, temperature: float = 0.7, max_tokens: int = 300):
    """OpenRouter — 27+ free models via OpenAI-compatible API."""
    from langchain_openai import ChatOpenAI
    key = _key("OPENROUTER_API_KEY")
    if not key:
        return None
    return ChatOpenAI(
        model=model,
        api_key=key,
        base_url="https://openrouter.ai/api/v1",
        temperature=temperature,
        max_tokens=max_tokens,
        default_headers={"HTTP-Referer": "https://whatif-sabha.local", "X-Title": "WhatIfSabha"},
    )


# Free models on OpenRouter (diverse for character variety)
# Free models on OpenRouter — sorted by capability (best first)
# Total available: 27. We use the best text-generation ones.
OPENROUTER_FREE_MODELS = [
    # Tier 1: Large, high quality
    "nousresearch/hermes-3-llama-3.1-405b:free",     # 405B — strongest free model
    "meta-llama/llama-3.3-70b-instruct:free",         # 70B — excellent prose
    "nvidia/nemotron-3-super-120b-a12b:free",          # 120B MoE — strong reasoning
    "openai/gpt-oss-120b:free",                        # 120B — OpenAI open-source
    "qwen/qwen3-next-80b-a3b-instruct:free",           # 80B MoE — multilingual
    "minimax/minimax-m2.5:free",                       # large context, good quality
    # Tier 2: Medium, reliable
    "google/gemma-4-31b-it:free",                      # 31B — Google latest
    "google/gemma-4-26b-a4b-it:free",                  # 26B MoE — efficient
    "google/gemma-3-27b-it:free",                      # 27B — proven quality
    "nvidia/nemotron-3-nano-30b-a3b:free",             # 30B MoE — fast
    "cognitivecomputations/dolphin-mistral-24b-venice-edition:free",  # 24B — uncensored
    "openai/gpt-oss-20b:free",                         # 20B
    "z-ai/glm-4.5-air:free",                          # GLM — good at dialogue
    "google/gemma-3-12b-it:free",                      # 12B — fast
    "arcee-ai/trinity-large-preview:free",             # preview — varied
    # Tier 3: Small, very fast
    "nvidia/nemotron-nano-9b-v2:free",                 # 9B — snappy
    "google/gemma-3-4b-it:free",                       # 4B — ultra-fast for minor chars
    "meta-llama/llama-3.2-3b-instruct:free",           # 3B — quick reactions
]


def get_model_pool() -> list[dict]:
    """
    Build a pool of available LLM instances from all configured providers.
    Each entry: {provider, model, llm, tier}
    tier: "fast" (cerebras/groq), "smart" (gemini/nvidia), "free" (openrouter)
    """
    pool = []
    s = get_settings()

    # Cerebras — ultra-fast, primary for characters
    cerebras = None
    try:
        cerebras = get_agent_llm(max_tokens=300)
        pool.append({"provider": "cerebras", "model": s.CHARACTER_AGENT_MODEL, "llm": cerebras, "tier": "fast"})
    except Exception:
        pass

    # Groq — fast fallback
    for model in [s.JUDGE_MODEL, "gemma2-9b-it", "llama-3.1-8b-instant"]:
        llm = _make_groq_llm(model, temperature=0.75)
        if llm:
            pool.append({"provider": "groq", "model": model, "llm": llm, "tier": "fast"})

    # NVIDIA — smart, good for complex reasoning
    for model in [s.NVIDIA_JUDGE_MODEL, s.NVIDIA_NARRATOR_MODEL]:
        llm = _make_nvidia_llm(model, temperature=0.7)
        if llm:
            pool.append({"provider": "nvidia", "model": model, "llm": llm, "tier": "smart"})

    # OpenRouter — free models, great for parallel overflow
    for model in OPENROUTER_FREE_MODELS:
        llm = _make_openrouter_llm(model, temperature=0.8)
        if llm:
            pool.append({"provider": "openrouter", "model": model, "llm": llm, "tier": "free"})

    return pool


def assign_models_to_characters(characters: list[dict], pool: list[dict]) -> dict:
    """
    Assign a model to each character from the pool. Spreads across providers
    so parallel calls go to different APIs (avoiding rate limits on one provider).

    Returns: {character_name: {provider, model, llm}}
    """
    assignments = {}
    if not pool:
        return assignments

    # Sort pool: fast first, then smart, then free
    tier_order = {"fast": 0, "smart": 1, "free": 2}
    sorted_pool = sorted(pool, key=lambda p: tier_order.get(p["tier"], 9))

    for i, char in enumerate(characters):
        entry = sorted_pool[i % len(sorted_pool)]
        assignments[char["name"]] = entry

    return assignments


def get_agent_fallbacks(max_tokens: int = 300) -> list:
    """
    Character agent fallback chain:
    Cerebras (ultra-fast) → OpenRouter free models → Groq
    """
    candidates = []

    # 1. Cerebras — primary, fastest
    try:
        candidates.append((get_agent_llm(max_tokens=max_tokens), "cerebras"))
    except Exception:
        pass

    # 2. OpenRouter free models — good for character voice
    AGENT_MODELS = [
        "meta-llama/llama-3.3-70b-instruct:free",
        "google/gemma-4-31b-it:free",
        "google/gemma-3-27b-it:free",
        "nvidia/nemotron-nano-9b-v2:free",
    ]
    for model in AGENT_MODELS:
        llm = _make_openrouter_llm(model, temperature=0.85, max_tokens=max_tokens)
        if llm:
            candidates.append((llm, f"or:{model.split('/')[1].split(':')[0]}"))

    # 3. Groq
    for model in ["llama-3.3-70b-versatile", "gemma2-9b-it", "llama-3.1-8b-instant"]:
        llm = _make_groq_llm(model, temperature=0.8)
        if llm:
            candidates.append((llm, f"groq:{model}"))

    return candidates


def get_judge_fallbacks() -> list:
    """
    NVIDIA first (no daily limit, ~40 RPM) → Groq fallbacks (daily limit but fast).
    Judge: kimi-k2-instruct → llama-3.3-70b-versatile → gemma2-9b-it → llama-3.1-8b-instant
    """
    s = get_settings()
    candidates = [
        (_make_nvidia_llm(s.NVIDIA_JUDGE_MODEL, temperature=0.1), s.NVIDIA_JUDGE_MODEL),
        (_make_groq_llm(s.JUDGE_MODEL, temperature=0.1), s.JUDGE_MODEL),
        (_make_groq_llm("gemma2-9b-it", temperature=0.1), "gemma2-9b-it"),
        (_make_groq_llm("llama-3.1-8b-instant", temperature=0.1), "llama-3.1-8b-instant"),
    ]
    return [(llm, label) for llm, label in candidates if llm is not None]


def get_narrator_fallbacks(temperature: float = 0.6) -> list:
    """
    NVIDIA first (no daily limit) → Groq fallbacks.
    Narrator: meta/llama-3.3-70b-instruct → llama-3.3-70b-versatile → gemma2-9b-it → llama-3.1-8b-instant
    """
    s = get_settings()
    candidates = [
        (_make_nvidia_llm(s.NVIDIA_NARRATOR_MODEL, temperature=temperature), s.NVIDIA_NARRATOR_MODEL),
        (_make_groq_llm(s.NARRATOR_MODEL, temperature=temperature), s.NARRATOR_MODEL),
        (_make_groq_llm("gemma2-9b-it", temperature=temperature), "gemma2-9b-it"),
        (_make_groq_llm("llama-3.1-8b-instant", temperature=temperature), "llama-3.1-8b-instant"),
    ]
    return [(llm, label) for llm, label in candidates if llm is not None]


def get_analysis_llm():
    """Gemini Flash — 1M token context. Story ingestion and chat."""
    s = get_settings()
    key = _key("GEMINI_API_KEY")
    if not key:
        raise ValueError("Gemini API key not set. Add it via the ⚙ Settings button.")
    return ChatGoogleGenerativeAI(model=s.ANALYSIS_MODEL, google_api_key=key, temperature=0.2)


def get_analysis_fallbacks() -> list:
    """
    Gemini primary (1M context), then OpenRouter free models (large context) as fallback.
    For story analysis, chat, and any task needing deep story understanding.
    """
    candidates = []

    # 1. Gemini — primary (1M context, best for full story analysis)
    try:
        candidates.append((get_analysis_llm(), "gemini"))
    except Exception:
        pass

    # 2. OpenRouter free models with large context windows
    ANALYSIS_FALLBACKS = [
        ("google/gemma-4-31b-it:free", 262144),       # 262K context
        ("nvidia/nemotron-3-super-120b-a12b:free", 262144),
        ("qwen/qwen3-next-80b-a3b-instruct:free", 262144),
        ("minimax/minimax-m2.5:free", 196608),          # 196K context
        ("meta-llama/llama-3.3-70b-instruct:free", 65536),
        ("google/gemma-3-27b-it:free", 131072),
    ]
    for model, _ctx in ANALYSIS_FALLBACKS:
        llm = _make_openrouter_llm(model, temperature=0.2, max_tokens=4000)
        if llm:
            candidates.append((llm, f"or:{model.split('/')[1].split(':')[0]}"))

    return candidates


async def invoke_analysis_with_fallback(messages: list) -> str:
    """Call analysis LLM with automatic fallback across providers."""
    import re as _re
    for llm, label in get_analysis_fallbacks():
        try:
            response = await llm.ainvoke(messages)
            raw = response.content
            if isinstance(raw, list):
                raw = "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in raw)
            raw = raw.strip()
            # Strip thinking blocks
            raw = _re.sub(r"<think>.*?</think>", "", raw, flags=_re.DOTALL).strip()
            if not raw:
                continue
            return raw
        except Exception as e:
            msg = str(e).lower()
            if "429" in msg or "rate" in msg or "quota" in msg:
                continue
            raise
    return ""


def get_agent_llm(max_tokens: int = 180):
    """Cerebras qwen-3-235b — ultra-fast character agent streaming."""
    s = get_settings()
    key = _key("CEREBRAS_API_KEY")
    if not key:
        raise ValueError("Cerebras API key not set. Add it via the ⚙ Settings button.")
    return ChatCerebras(model=s.CHARACTER_AGENT_MODEL, cerebras_api_key=key, temperature=0.85, max_tokens=max_tokens)


def get_judge_llm():
    """Kept for compatibility — use get_judge_fallbacks() for resilient calls."""
    llms = get_judge_fallbacks()
    if not llms:
        raise ValueError("Groq API key not set. Add it via the ⚙ Settings button.")
    return llms[0][0]


def get_narrator_llm():
    """Kept for compatibility — use get_narrator_fallbacks() for resilient calls."""
    llms = get_narrator_fallbacks()
    if not llms:
        raise ValueError("Groq API key not set. Add it via the ⚙ Settings button.")
    return llms[0][0]

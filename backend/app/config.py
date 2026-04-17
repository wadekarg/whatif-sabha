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
    anthropic_key: str = None,
    openai_key: str = None,
):
    if gemini_key:
        _runtime_keys["GEMINI_API_KEY"] = gemini_key
    if groq_key:
        _runtime_keys["GROQ_API_KEY"] = groq_key
    if cerebras_key:
        _runtime_keys["CEREBRAS_API_KEY"] = cerebras_key
    if nvidia_key:
        _runtime_keys["NVIDIA_API_KEY"] = nvidia_key
    if anthropic_key:
        _runtime_keys["ANTHROPIC_API_KEY"] = anthropic_key
    if openai_key:
        _runtime_keys["OPENAI_API_KEY"] = openai_key


def get_runtime_keys() -> dict:
    return _runtime_keys


class Settings(BaseSettings):
    GEMINI_API_KEY: Optional[str] = None
    GROQ_API_KEY: Optional[str] = None
    CEREBRAS_API_KEY: Optional[str] = None
    NVIDIA_API_KEY: Optional[str] = None
    ANTHROPIC_API_KEY: Optional[str] = None
    OPENAI_API_KEY: Optional[str] = None
    GITHUB_MODELS_TOKEN: Optional[str] = None
    CLOUDFLARE_ACCOUNT_ID: Optional[str] = None
    CLOUDFLARE_API_TOKEN: Optional[str] = None

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


def _make_nvidia_llm(model: str, temperature: float = 0.1, timeout: float = 60.0, max_retries: int = 2):
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
        timeout=timeout,
        max_retries=max_retries,
    )


def _make_github_models_llm(model: str, temperature: float = 0.7, max_tokens: int = 300):
    """GitHub Models — GPT-4o, Llama, DeepSeek, Mistral via OpenAI-compatible API."""
    from langchain_openai import ChatOpenAI
    key = _key("GITHUB_MODELS_TOKEN")
    if not key:
        return None
    return ChatOpenAI(
        model=model,
        api_key=key,
        base_url="https://models.inference.ai.azure.com",
        temperature=temperature,
        max_tokens=max_tokens,
    )


def _make_cloudflare_llm(model: str, temperature: float = 0.7, max_tokens: int = 300):
    """Cloudflare Workers AI — 10K neurons/day free, Llama/Mistral/Qwen."""
    from langchain_openai import ChatOpenAI
    account_id = _key("CLOUDFLARE_ACCOUNT_ID")
    token = _key("CLOUDFLARE_API_TOKEN")
    if not account_id or not token:
        return None
    return ChatOpenAI(
        model=model,
        api_key=token,
        base_url=f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
        temperature=temperature,
        max_tokens=max_tokens,
    )


def _make_anthropic_llm(model: str, temperature: float = 0.7, max_tokens: int = 1024):
    """Anthropic Claude — best-in-class quality."""
    from langchain_anthropic import ChatAnthropic
    key = _key("ANTHROPIC_API_KEY")
    if not key:
        return None
    return ChatAnthropic(
        model=model,
        anthropic_api_key=key,
        temperature=temperature,
        max_tokens=max_tokens,
    )


def _make_openai_llm(model: str, temperature: float = 0.7, max_tokens: int = 1024):
    """OpenAI native — GPT-4o, GPT-4o-mini."""
    from langchain_openai import ChatOpenAI
    key = _key("OPENAI_API_KEY")
    if not key:
        return None
    return ChatOpenAI(
        model=model,
        api_key=key,
        temperature=temperature,
        max_tokens=max_tokens,
    )


# ── Provider detection for single-key mode ──

# Role-based model selection per provider
PROVIDER_ROLE_MODELS: dict[tuple[str, str], str] = {
    ("anthropic", "agent"):    "claude-haiku-4-5-20251001",
    ("anthropic", "judge"):    "claude-haiku-4-5-20251001",
    ("anthropic", "narrator"): "claude-sonnet-4-20250514",
    ("anthropic", "analysis"): "claude-sonnet-4-20250514",
    ("openai", "agent"):       "gpt-4o-mini",
    ("openai", "judge"):       "gpt-4o-mini",
    ("openai", "narrator"):    "gpt-4o-mini",
    ("openai", "analysis"):    "gpt-4o-mini",
    ("gemini", "agent"):       "gemini-2.0-flash",
    ("gemini", "judge"):       "gemini-2.0-flash",
    ("gemini", "narrator"):    "gemini-2.0-flash",
    ("gemini", "analysis"):    "gemini-2.0-flash",
    ("groq", "agent"):         "llama-3.3-70b-versatile",
    ("groq", "judge"):         "llama-3.3-70b-versatile",
    ("groq", "narrator"):      "llama-3.3-70b-versatile",
    ("groq", "analysis"):      "llama-3.3-70b-versatile",
}

# Map provider name → factory function + key name
_PROVIDER_FACTORIES = {
    "anthropic": ("ANTHROPIC_API_KEY", _make_anthropic_llm),
    "openai":    ("OPENAI_API_KEY",    _make_openai_llm),
    "gemini":    ("GEMINI_API_KEY",    None),  # Gemini uses its own ChatGoogleGenerativeAI
    "groq":      ("GROQ_API_KEY",      _make_groq_llm),
    "cerebras":  ("CEREBRAS_API_KEY",  None),  # Cerebras uses its own ChatCerebras
    "nvidia":    ("NVIDIA_API_KEY",    _make_nvidia_llm),
}


def _available_providers() -> list[str]:
    """Return list of providers with valid API keys configured."""
    return [name for name, (key_name, _) in _PROVIDER_FACTORIES.items() if _key(key_name)]


def _make_llm_for_role(role: str, temperature: float, max_tokens: int = 1024):
    """
    Create an LLM for a given role using whatever provider is available.
    In single-provider mode, uses that provider. Otherwise returns None
    (callers fall through to their existing multi-provider chains).
    """
    providers = _available_providers()
    if not providers:
        return None

    # In single-provider mode OR when the preferred provider for this role isn't available
    for provider in providers:
        model = PROVIDER_ROLE_MODELS.get((provider, role))
        if not model:
            continue
        if provider == "anthropic":
            return _make_anthropic_llm(model, temperature=temperature, max_tokens=max_tokens)
        elif provider == "openai":
            return _make_openai_llm(model, temperature=temperature, max_tokens=max_tokens)
        elif provider == "gemini":
            try:
                return ChatGoogleGenerativeAI(
                    model=model, google_api_key=_key("GEMINI_API_KEY"), temperature=temperature,
                )
            except Exception:
                continue
        elif provider == "groq":
            return _make_groq_llm(model, temperature=temperature)
        elif provider == "nvidia":
            return _make_nvidia_llm(model, temperature=temperature)
    return None


def get_model_pool() -> list[dict]:
    """
    Build a pool of available LLM instances from all configured providers.
    Each entry: {provider, model, llm, tier}
    tier: "fast" (cerebras/groq), "smart" (gemini/nvidia)
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

    # Anthropic — high quality
    llm = _make_anthropic_llm("claude-haiku-4-5-20251001", temperature=0.85, max_tokens=300)
    if llm:
        pool.append({"provider": "anthropic", "model": "claude-haiku-4-5", "llm": llm, "tier": "fast"})

    # OpenAI — reliable
    llm = _make_openai_llm("gpt-4o-mini", temperature=0.85, max_tokens=300)
    if llm:
        pool.append({"provider": "openai", "model": "gpt-4o-mini", "llm": llm, "tier": "fast"})

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
    Cerebras → Anthropic → OpenAI → NVIDIA → GitHub Models → Cloudflare → Groq
    """
    candidates = []

    # 1. Cerebras — primary, fastest
    try:
        candidates.append((get_agent_llm(max_tokens=max_tokens), "cerebras"))
    except Exception:
        pass

    # 2. Anthropic Claude Haiku — fast, high quality
    llm = _make_anthropic_llm("claude-haiku-4-5-20251001", temperature=0.85, max_tokens=max_tokens)
    if llm:
        candidates.append((llm, "anthropic:haiku"))

    # 3. OpenAI GPT-4o-mini — fast, reliable
    llm = _make_openai_llm("gpt-4o-mini", temperature=0.85, max_tokens=max_tokens)
    if llm:
        candidates.append((llm, "openai:gpt-4o-mini"))

    # 4. NVIDIA — 91 free models, ~40 RPM, NO daily token limit
    NVIDIA_AGENT_MODELS = [
        "meta/llama-3.3-70b-instruct",
        "meta/llama-4-maverick-17b-128e-instruct",       # Llama 4!
        "mistralai/mistral-small-3.2-24b-instruct",
        "google/gemma-4-31b-it",
        "deepseek-ai/deepseek-v3.2",
        "meta/llama-3.1-70b-instruct",
    ]
    for model in NVIDIA_AGENT_MODELS:
        llm = _make_nvidia_llm(model, temperature=0.85)
        if llm:
            candidates.append((llm, f"nv:{model.split('/')[-1][:30]}"))

    # 3. GitHub Models — GPT-4o-mini, Llama, etc.
    GITHUB_AGENT_MODELS = [
        "gpt-4o-mini",
        "meta-llama-3.1-70b-instruct",
        "Phi-4-mini-instruct",
    ]
    for model in GITHUB_AGENT_MODELS:
        llm = _make_github_models_llm(model, temperature=0.85, max_tokens=max_tokens)
        if llm:
            candidates.append((llm, f"gh:{model[:20]}"))

    # 4. Cloudflare Workers AI
    CF_AGENT_MODELS = [
        "@cf/meta/llama-3.1-8b-instruct",
        "@cf/mistral/mistral-7b-instruct-v0.2",
    ]
    for model in CF_AGENT_MODELS:
        llm = _make_cloudflare_llm(model, temperature=0.85, max_tokens=max_tokens)
        if llm:
            candidates.append((llm, f"cf:{model.split('/')[-1][:20]}"))

    # 5. Groq
    for model in ["llama-3.3-70b-versatile", "gemma2-9b-it", "llama-3.1-8b-instant"]:
        llm = _make_groq_llm(model, temperature=0.8)
        if llm:
            candidates.append((llm, f"groq:{model}"))

    return candidates


def get_judge_fallbacks() -> list:
    """
    Groq first (sub-second on LPU) → Anthropic → OpenAI → NVIDIA fallback.
    Judge needs low temperature for structured JSON output.
    """
    s = get_settings()
    candidates = [
        (_make_groq_llm(s.JUDGE_MODEL, temperature=0.1), f"groq:{s.JUDGE_MODEL}"),
        (_make_anthropic_llm("claude-haiku-4-5-20251001", temperature=0.1, max_tokens=500), "anthropic:haiku"),
        (_make_openai_llm("gpt-4o-mini", temperature=0.1, max_tokens=500), "openai:gpt-4o-mini"),
        (_make_nvidia_llm(s.NVIDIA_JUDGE_MODEL, temperature=0.1), s.NVIDIA_JUDGE_MODEL),
        (_make_groq_llm("gemma2-9b-it", temperature=0.1), "groq:gemma2-9b-it"),
        (_make_groq_llm("llama-3.1-8b-instant", temperature=0.1), "groq:llama-3.1-8b-instant"),
    ]
    return [(llm, label) for llm, label in candidates if llm is not None]


def get_narrator_fallbacks(temperature: float = 0.6) -> list:
    """
    NVIDIA → Anthropic → OpenAI → Groq fallbacks.
    Narrator needs creative temperature for storytelling.
    """
    s = get_settings()
    candidates = [
        (_make_nvidia_llm(s.NVIDIA_NARRATOR_MODEL, temperature=temperature), s.NVIDIA_NARRATOR_MODEL),
        (_make_anthropic_llm("claude-sonnet-4-20250514", temperature=temperature, max_tokens=2048), "anthropic:sonnet"),
        (_make_openai_llm("gpt-4o-mini", temperature=temperature, max_tokens=2048), "openai:gpt-4o-mini"),
        (_make_groq_llm(s.NARRATOR_MODEL, temperature=temperature), s.NARRATOR_MODEL),
        (_make_groq_llm("gemma2-9b-it", temperature=temperature), "gemma2-9b-it"),
        (_make_groq_llm("llama-3.1-8b-instant", temperature=temperature), "llama-3.1-8b-instant"),
    ]
    return [(llm, label) for llm, label in candidates if llm is not None]


def get_analysis_llm():
    """Gemini Flash (1M context) preferred, falls back to any available provider."""
    s = get_settings()
    key = _key("GEMINI_API_KEY")
    if key:
        return ChatGoogleGenerativeAI(model=s.ANALYSIS_MODEL, google_api_key=key, temperature=0.2)
    # Soft fallback — try any available provider for analysis role
    llm = _make_llm_for_role("analysis", temperature=0.2, max_tokens=4096)
    if llm:
        return llm
    raise ValueError("No API key configured. Add any key via the ⚙ Settings button.")


def get_analysis_fallbacks() -> list:
    """
    Gemini → Anthropic → OpenAI → NVIDIA → GitHub Models → Cloudflare.
    For story analysis, chat, and any task needing deep story understanding.
    """
    candidates = []

    # 1. Gemini — primary (1M context, best for full story analysis)
    gemini_key = _key("GEMINI_API_KEY")
    if gemini_key:
        try:
            s = get_settings()
            candidates.append((
                ChatGoogleGenerativeAI(model=s.ANALYSIS_MODEL, google_api_key=gemini_key, temperature=0.2),
                "gemini",
            ))
        except Exception:
            pass

    # 2. Anthropic Claude Sonnet — excellent analysis quality
    llm = _make_anthropic_llm("claude-sonnet-4-20250514", temperature=0.2, max_tokens=4096)
    if llm:
        candidates.append((llm, "anthropic:sonnet"))

    # 3. OpenAI GPT-4o-mini — reliable analysis
    llm = _make_openai_llm("gpt-4o-mini", temperature=0.2, max_tokens=4096)
    if llm:
        candidates.append((llm, "openai:gpt-4o-mini"))

    # 4. NVIDIA — no daily token limit, ~40 RPM, massive models available
    NVIDIA_ANALYSIS_MODELS = [
        "meta/llama-3.1-405b-instruct",                    # 405B — massive
        "mistralai/mistral-large-3-675b-instruct-2512",     # 675B — largest available
        "deepseek-ai/deepseek-v3.2",                        # DeepSeek latest
        "meta/llama-3.3-70b-instruct",                      # 70B — reliable
        "google/gemma-4-31b-it",                             # 31B — fast
    ]
    for model in NVIDIA_ANALYSIS_MODELS:
        llm = _make_nvidia_llm(model, temperature=0.2)
        if llm:
            candidates.append((llm, f"nv:{model.split('/')[-1][:30]}"))

    # 3. GitHub Models — GPT-4o for analysis
    GITHUB_ANALYSIS_MODELS = [
        "gpt-4o-mini",
        "meta-llama-3.1-70b-instruct",
    ]
    for model in GITHUB_ANALYSIS_MODELS:
        llm = _make_github_models_llm(model, temperature=0.2, max_tokens=4000)
        if llm:
            candidates.append((llm, f"gh:{model[:20]}"))

    # 4. Cloudflare
    llm = _make_cloudflare_llm("@cf/meta/llama-3.1-8b-instruct", temperature=0.2, max_tokens=4000)
    if llm:
        candidates.append((llm, "cf:llama-3.1-8b"))

    return candidates


async def invoke_analysis_with_fallback(messages: list) -> str:
    """Call analysis LLM with proactive rate limit checking + fallback + timeout."""
    import re as _re
    import asyncio as _aio
    from app.core.usage_tracker import tracker

    for llm, label in get_analysis_fallbacks():
        provider_key = label.split(":")[0] if ":" in label else label
        if not tracker.can_use(provider_key):
            continue

        try:
            response = await _aio.wait_for(llm.ainvoke(messages), timeout=25)
            tracker.record(provider_key)
            raw = response.content
            if isinstance(raw, list):
                raw = "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in raw)
            raw = raw.strip()
            raw = _re.sub(r"<think>.*?</think>", "", raw, flags=_re.DOTALL).strip()
            if not raw:
                continue
            return raw
        except _aio.TimeoutError:
            continue
        except Exception as e:
            msg = str(e).lower()
            if "429" in msg or "rate" in msg or "quota" in msg or "402" in msg:
                continue
            raise
    return ""


def get_agent_llm(max_tokens: int = 180):
    """Cerebras preferred (ultra-fast), falls back to any available provider."""
    s = get_settings()
    key = _key("CEREBRAS_API_KEY")
    if key:
        return ChatCerebras(model=s.CHARACTER_AGENT_MODEL, cerebras_api_key=key, temperature=0.85, max_tokens=max_tokens)
    # Soft fallback — try any available provider for character agent role
    llm = _make_llm_for_role("agent", temperature=0.85, max_tokens=max_tokens)
    if llm:
        return llm
    raise ValueError("No API key configured. Add any key via the ⚙ Settings button.")


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

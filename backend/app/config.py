from pydantic_settings import BaseSettings
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_groq import ChatGroq
from langchain_cerebras import ChatCerebras
from functools import lru_cache
from typing import Optional

# Runtime key overrides — set via /settings/keys endpoint from the UI
_runtime_keys: dict[str, str] = {}

# Runtime per-provider model picks — set via /settings/keys endpoint.
# Shape: { provider_name: { "main": str, "agent": str, "judge": str, ... } }
# `main` applies to every role unless a role-specific override is also set.
_runtime_models: dict[str, dict[str, str]] = {}


def update_runtime_models(provider: str, config: dict):
    """Replace the model picks for a provider. Empty dict clears them."""
    cleaned = {k: v for k, v in (config or {}).items() if v}
    if cleaned:
        _runtime_models[provider] = cleaned
    else:
        _runtime_models.pop(provider, None)


def get_runtime_models() -> dict:
    return _runtime_models


def model_for(provider: str, role: str) -> Optional[str]:
    """Return the user-chosen model for a provider+role.

    Resolution order:
      1. Runtime per-role override (gear modal, Advanced section)
      2. Runtime "main" pick (gear modal, primary dropdown)
      3. <PROVIDER>_MODEL env var (new convention)
      4. Legacy role-based env var if provider is its natural home
         (preserves existing .env users — `JUDGE_MODEL=...` keeps working
         when the judge role asks Groq, etc.)
      5. None — provider is skipped for this role.
    """
    cfg = _runtime_models.get(provider, {})
    if v := cfg.get(role):
        return v
    if v := cfg.get("main"):
        return v
    s = get_settings()
    if v := getattr(s, f"{provider.upper()}_MODEL", None):
        return v
    # Legacy role-based env vars — natural-home pairings only
    if provider == "groq" and role == "judge":
        return s.JUDGE_MODEL or None
    if provider == "groq" and role == "narrator":
        return s.NARRATOR_MODEL or None
    if provider == "gemini" and role == "analysis":
        return s.ANALYSIS_MODEL or None
    if provider == "cerebras" and role == "agent":
        return s.CHARACTER_AGENT_MODEL or None
    if provider == "nvidia" and role == "judge":
        return getattr(s, "NVIDIA_JUDGE_MODEL", None) or None
    if provider == "nvidia" and role == "narrator":
        return getattr(s, "NVIDIA_NARRATOR_MODEL", None) or None
    return None


def update_runtime_keys(
    gemini_key: str = None,
    groq_key: str = None,
    cerebras_key: str = None,
    nvidia_key: str = None,
    anthropic_key: str = None,
    openai_key: str = None,
    custom_llm_base_url: str = None,
    custom_llm_api_key: str = None,
    custom_llm_model: str = None,
):
    """Set or clear runtime keys.

    Sentinels:
      - None = caller did not pass this field; leave unchanged.
      - ""   = caller explicitly cleared the field; override any .env value.
      - "x"  = set to "x".

    Empty-string ("cleared") values are stored explicitly so downstream code
    can tell "user cleared this" apart from "user never set it".
    """
    pairs = (
        ("GEMINI_API_KEY",      gemini_key),
        ("GROQ_API_KEY",        groq_key),
        ("CEREBRAS_API_KEY",    cerebras_key),
        ("NVIDIA_API_KEY",      nvidia_key),
        ("ANTHROPIC_API_KEY",   anthropic_key),
        ("OPENAI_API_KEY",      openai_key),
        ("CUSTOM_LLM_BASE_URL", custom_llm_base_url),
        ("CUSTOM_LLM_API_KEY",  custom_llm_api_key),
        ("CUSTOM_LLM_MODEL",    custom_llm_model),
    )
    for env_name, value in pairs:
        if value is None:
            continue  # not provided
        # Empty string is the "explicit clear" sentinel — store it as-is.
        _runtime_keys[env_name] = value


def get_runtime_keys() -> dict:
    return _runtime_keys


def get_effective_key(env_name: str) -> str:
    """Resolve a key respecting the runtime-clear sentinel.

    If the user has explicitly cleared a key via the UI, the runtime dict
    will have that key set to ''. We return None in that case (treat as
    not configured) instead of falling back to whatever is in .env.
    """
    if env_name in _runtime_keys:
        # Explicitly set in runtime — including '' (cleared) takes precedence.
        return _runtime_keys[env_name] or None
    # Not in runtime — fall back to .env via Settings.
    s = get_settings()
    return getattr(s, env_name, None) or None


class Settings(BaseSettings):
    GEMINI_API_KEY: Optional[str] = None
    GROQ_API_KEY: Optional[str] = None
    CEREBRAS_API_KEY: Optional[str] = None
    NVIDIA_API_KEY: Optional[str] = None
    ANTHROPIC_API_KEY: Optional[str] = None
    OPENAI_API_KEY: Optional[str] = None
    # Bring-your-own-provider — any OpenAI-compatible endpoint in the world
    # (DeepSeek, Qwen, Kimi, Zhipu, OpenRouter, Together, Fireworks, Perplexity,
    # Ollama, LM Studio, vLLM, Azure OpenAI, ...).
    CUSTOM_LLM_BASE_URL: Optional[str] = None
    CUSTOM_LLM_API_KEY: Optional[str] = None
    CUSTOM_LLM_MODEL: Optional[str] = None
    # Per-provider model defaults — env-var fallback if user hasn't picked
    # one in the gear modal. The gear modal's selection takes precedence.
    ANTHROPIC_MODEL: Optional[str] = None
    OPENAI_MODEL:    Optional[str] = None
    GEMINI_MODEL:    Optional[str] = None
    GROQ_MODEL:      Optional[str] = None
    CEREBRAS_MODEL:  Optional[str] = None
    NVIDIA_MODEL:    Optional[str] = None
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
    """Return runtime override if set, else fall back to .env value.

    Respects the explicit-clear sentinel: if the user has cleared a key
    via the UI (runtime value == ""), we honour that and return ""
    instead of falling back to .env.
    """
    if env_key in _runtime_keys:
        return _runtime_keys[env_key] or ""
    return get_settings().__dict__.get(env_key) or ""


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


def _make_custom_llm(temperature: float = 0.7, max_tokens: int = 1024, model: str = None):
    """Bring-your-own OpenAI-compatible provider.

    Works with anything that exposes /chat/completions in OpenAI dialect:
    DeepSeek, Qwen (Dashscope), Kimi (Moonshot), Zhipu GLM, OpenRouter,
    Together, Fireworks, Perplexity, Ollama, LM Studio, vLLM, Azure OpenAI, etc.
    Configured via CUSTOM_LLM_BASE_URL + CUSTOM_LLM_API_KEY + CUSTOM_LLM_MODEL.
    """
    from langchain_openai import ChatOpenAI
    base_url = _key("CUSTOM_LLM_BASE_URL")
    api_key  = _key("CUSTOM_LLM_API_KEY")
    chosen_model = model or _key("CUSTOM_LLM_MODEL")
    if not base_url or not api_key or not chosen_model:
        return None
    return ChatOpenAI(
        model=chosen_model,
        api_key=api_key,
        base_url=base_url,
        temperature=temperature,
        max_tokens=max_tokens,
    )


# ── Provider detection for single-key mode ──

# Map provider name → factory function + key name
_PROVIDER_FACTORIES = {
    "anthropic": ("ANTHROPIC_API_KEY",     _make_anthropic_llm),
    "openai":    ("OPENAI_API_KEY",        _make_openai_llm),
    "gemini":    ("GEMINI_API_KEY",        None),  # Gemini uses its own ChatGoogleGenerativeAI
    "groq":      ("GROQ_API_KEY",          _make_groq_llm),
    "cerebras":  ("CEREBRAS_API_KEY",      None),  # Cerebras uses its own ChatCerebras
    "nvidia":    ("NVIDIA_API_KEY",        _make_nvidia_llm),
    # "custom" needs base_url + api_key + model — handled separately in _custom_configured()
}


def _custom_configured() -> bool:
    """True iff all three CUSTOM_LLM_* env values are present."""
    return bool(_key("CUSTOM_LLM_BASE_URL") and _key("CUSTOM_LLM_API_KEY") and _key("CUSTOM_LLM_MODEL"))


def _available_providers() -> list[str]:
    """Return list of providers with valid API keys configured."""
    out = [name for name, (key_name, _) in _PROVIDER_FACTORIES.items() if _key(key_name)]
    if _custom_configured():
        out.append("custom")
    return out


def _make_llm_for_role(role: str, temperature: float, max_tokens: int = 1024):
    """
    Create an LLM for a given role using whatever provider is available.
    In single-provider mode, uses that provider. Otherwise returns None
    (callers fall through to their existing multi-provider chains).
    """
    providers = _available_providers()
    if not providers:
        return None

    # If user configured a custom provider, prefer it for every role —
    # they explicitly told us "use this one".
    if _custom_configured():
        llm = _make_custom_llm(temperature=temperature, max_tokens=max_tokens)
        if llm:
            return llm

    # Pick the user's chosen model for each available provider/role pair.
    # No hardcoded model ids — model_for() resolves to runtime pick or env var,
    # otherwise that provider is skipped (returns None).
    for provider in providers:
        model = model_for(provider, role)
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
        elif provider == "cerebras":
            key = _key("CEREBRAS_API_KEY")
            if key:
                return ChatCerebras(model=model, cerebras_api_key=key, temperature=temperature, max_tokens=max_tokens)
    return None


def get_model_pool() -> list[dict]:
    """
    Build a pool of available LLM instances from all configured providers,
    spreading parallel character calls across them. Each entry:
    {provider, model, llm, tier}.

    Model id at every step comes from model_for(provider, "agent") — the
    user's gear-modal pick or <PROVIDER>_MODEL env var. Providers without a
    model configured for the agent role are skipped (no hardcoded ids).
    """
    pool: list = []
    s = get_settings()

    # Cerebras — ultra-fast, primary for characters
    if _key("CEREBRAS_API_KEY"):
        cerebras_model = model_for("cerebras", "agent") or s.CHARACTER_AGENT_MODEL
        if cerebras_model:
            try:
                llm = ChatCerebras(model=cerebras_model, cerebras_api_key=_key("CEREBRAS_API_KEY"),
                                   temperature=0.85, max_tokens=300)
                pool.append({"provider": "cerebras", "model": cerebras_model, "llm": llm, "tier": "fast"})
            except Exception:
                pass

    # Groq
    if m := model_for("groq", "agent"):
        llm = _make_groq_llm(m, temperature=0.75)
        if llm:
            pool.append({"provider": "groq", "model": m, "llm": llm, "tier": "fast"})

    # NVIDIA
    if m := model_for("nvidia", "agent"):
        llm = _make_nvidia_llm(m, temperature=0.7)
        if llm:
            pool.append({"provider": "nvidia", "model": m, "llm": llm, "tier": "smart"})

    # Anthropic
    if m := model_for("anthropic", "agent"):
        llm = _make_anthropic_llm(m, temperature=0.85, max_tokens=300)
        if llm:
            pool.append({"provider": "anthropic", "model": m, "llm": llm, "tier": "fast"})

    # OpenAI
    if m := model_for("openai", "agent"):
        llm = _make_openai_llm(m, temperature=0.85, max_tokens=300)
        if llm:
            pool.append({"provider": "openai", "model": m, "llm": llm, "tier": "fast"})

    # Custom provider — bring-your-own-API
    if custom := _make_custom_llm(temperature=0.85, max_tokens=300):
        pool.append({"provider": "custom", "model": _key("CUSTOM_LLM_MODEL"), "llm": custom, "tier": "fast"})

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
    Character agent fallback chain. Model id at each provider comes from the
    user's pick in the gear modal (or the <PROVIDER>_MODEL env var). When a
    provider has no model configured for the agent role, that provider is
    skipped — no hardcoded model id is assumed.

    Order: Custom → Cerebras → Anthropic → OpenAI → NVIDIA → Groq.
    """
    candidates = []

    # 0. Custom (bring-your-own) — if configured, user picked it on purpose, try first
    custom = _make_custom_llm(temperature=0.85, max_tokens=max_tokens)
    if custom:
        candidates.append((custom, f"custom:{_key('CUSTOM_LLM_MODEL')}"))

    # 1. Cerebras — primary, fastest
    try:
        candidates.append((get_agent_llm(max_tokens=max_tokens), "cerebras"))
    except Exception:
        pass

    # 2. Anthropic
    if m := model_for("anthropic", "agent"):
        llm = _make_anthropic_llm(m, temperature=0.85, max_tokens=max_tokens)
        if llm:
            candidates.append((llm, f"anthropic:{m}"))

    # 3. OpenAI
    if m := model_for("openai", "agent"):
        llm = _make_openai_llm(m, temperature=0.85, max_tokens=max_tokens)
        if llm:
            candidates.append((llm, f"openai:{m}"))

    # 4. NVIDIA — single model from user's pick (no hardcoded list)
    if m := model_for("nvidia", "agent"):
        llm = _make_nvidia_llm(m, temperature=0.85)
        if llm:
            candidates.append((llm, f"nv:{m.split('/')[-1][:30]}"))

    # 5. Groq
    if m := model_for("groq", "agent"):
        llm = _make_groq_llm(m, temperature=0.85)
        if llm:
            candidates.append((llm, f"groq:{m}"))

    # 6. Gemini — long-context fallback. Slower than Cerebras for character
    # voices but its 1M window means it handles any conversation length,
    # including long debates where the running history pushes other
    # providers over their context budget.
    gemini_key = _key("GEMINI_API_KEY")
    if gemini_key:
        m = model_for("gemini", "agent") or model_for("gemini", "analysis") or model_for("gemini", "main")
        if m:
            try:
                candidates.append((
                    ChatGoogleGenerativeAI(model=m, google_api_key=gemini_key, temperature=0.85),
                    f"gemini:{m}",
                ))
            except Exception:
                pass

    return candidates


def get_judge_fallbacks() -> list:
    """
    Custom → Groq → Anthropic → OpenAI → NVIDIA. Model ids resolved per-provider
    from the gear-modal pick or <PROVIDER>_MODEL env var. Judge needs low
    temperature for structured JSON output.
    """
    candidates: list = []

    if custom := _make_custom_llm(temperature=0.1, max_tokens=500):
        candidates.append((custom, f"custom:{_key('CUSTOM_LLM_MODEL')}"))

    if m := model_for("groq", "judge"):
        if llm := _make_groq_llm(m, temperature=0.1):
            candidates.append((llm, f"groq:{m}"))

    if m := model_for("anthropic", "judge"):
        if llm := _make_anthropic_llm(m, temperature=0.1, max_tokens=500):
            candidates.append((llm, f"anthropic:{m}"))

    if m := model_for("openai", "judge"):
        if llm := _make_openai_llm(m, temperature=0.1, max_tokens=500):
            candidates.append((llm, f"openai:{m}"))

    if m := model_for("nvidia", "judge"):
        if llm := _make_nvidia_llm(m, temperature=0.1):
            candidates.append((llm, f"nv:{m.split('/')[-1][:30]}"))

    cerebras_key = _key("CEREBRAS_API_KEY")
    if cerebras_key:
        m = model_for("cerebras", "judge") or model_for("cerebras", "agent")
        if m:
            try:
                candidates.append((
                    ChatCerebras(model=m, cerebras_api_key=cerebras_key, temperature=0.1, max_tokens=500),
                    f"cerebras:{m}",
                ))
            except Exception:
                pass

    # Gemini — long-context fallback. Last in chain since others are faster,
    # but Gemini's 1M window means it never fails on context-length errors.
    gemini_key = _key("GEMINI_API_KEY")
    if gemini_key:
        m = model_for("gemini", "judge") or model_for("gemini", "analysis") or model_for("gemini", "main")
        if m:
            try:
                candidates.append((
                    ChatGoogleGenerativeAI(model=m, google_api_key=gemini_key, temperature=0.1),
                    f"gemini:{m}",
                ))
            except Exception:
                pass

    return candidates


def get_narrator_fallbacks(temperature: float = 0.6) -> list:
    """
    Custom → NVIDIA → Anthropic → OpenAI → Groq. Model ids resolved per-provider
    from the gear-modal pick or <PROVIDER>_MODEL env var. Narrator needs
    creative temperature for storytelling.
    """
    candidates: list = []

    if custom := _make_custom_llm(temperature=temperature, max_tokens=2048):
        candidates.append((custom, f"custom:{_key('CUSTOM_LLM_MODEL')}"))

    if m := model_for("nvidia", "narrator"):
        if llm := _make_nvidia_llm(m, temperature=temperature):
            candidates.append((llm, f"nv:{m.split('/')[-1][:30]}"))

    if m := model_for("anthropic", "narrator"):
        if llm := _make_anthropic_llm(m, temperature=temperature, max_tokens=2048):
            candidates.append((llm, f"anthropic:{m}"))

    if m := model_for("openai", "narrator"):
        if llm := _make_openai_llm(m, temperature=temperature, max_tokens=2048):
            candidates.append((llm, f"openai:{m}"))

    if m := model_for("groq", "narrator"):
        if llm := _make_groq_llm(m, temperature=temperature):
            candidates.append((llm, f"groq:{m}"))

    cerebras_key = _key("CEREBRAS_API_KEY")
    if cerebras_key:
        m = model_for("cerebras", "narrator") or model_for("cerebras", "agent")
        if m:
            try:
                candidates.append((
                    ChatCerebras(model=m, cerebras_api_key=cerebras_key, temperature=temperature, max_tokens=2048),
                    f"cerebras:{m}",
                ))
            except Exception:
                pass

    # Gemini — long-context fallback. Lower priority than fast providers
    # but always works for any context size.
    gemini_key = _key("GEMINI_API_KEY")
    if gemini_key:
        m = model_for("gemini", "narrator") or model_for("gemini", "analysis") or model_for("gemini", "main")
        if m:
            try:
                candidates.append((
                    ChatGoogleGenerativeAI(model=m, google_api_key=gemini_key, temperature=temperature),
                    f"gemini:{m}",
                ))
            except Exception:
                pass

    return candidates


def get_analysis_llm():
    """Gemini Flash (1M context) preferred, falls back to any available provider."""
    s = get_settings()
    key = _key("GEMINI_API_KEY")
    if key:
        model = model_for("gemini", "analysis") or s.ANALYSIS_MODEL
        if model:
            return ChatGoogleGenerativeAI(model=model, google_api_key=key, temperature=0.2)
    # Soft fallback — try any available provider for analysis role
    llm = _make_llm_for_role("analysis", temperature=0.2, max_tokens=4096)
    if llm:
        return llm
    raise ValueError("No language model configured for this role. Open the gear icon (⚙) in the top-right and add at least one API key (Gemini's free tier is recommended).")


def get_analysis_fallbacks() -> list:
    """
    Custom → Gemini → Anthropic → OpenAI → NVIDIA → Groq. Model ids resolved
    per-provider from the gear-modal pick or <PROVIDER>_MODEL env var.
    For story analysis, chat, and any task needing deep story understanding.
    """
    candidates: list = []

    if custom := _make_custom_llm(temperature=0.2, max_tokens=4096):
        candidates.append((custom, f"custom:{_key('CUSTOM_LLM_MODEL')}"))

    # Gemini — primary (1M context, best for full story analysis)
    gemini_key = _key("GEMINI_API_KEY")
    if gemini_key and (m := model_for("gemini", "analysis")):
        try:
            candidates.append((
                ChatGoogleGenerativeAI(model=m, google_api_key=gemini_key, temperature=0.2),
                f"gemini:{m}",
            ))
        except Exception:
            pass

    if m := model_for("anthropic", "analysis"):
        if llm := _make_anthropic_llm(m, temperature=0.2, max_tokens=4096):
            candidates.append((llm, f"anthropic:{m}"))

    if m := model_for("openai", "analysis"):
        if llm := _make_openai_llm(m, temperature=0.2, max_tokens=4096):
            candidates.append((llm, f"openai:{m}"))

    if m := model_for("nvidia", "analysis"):
        if llm := _make_nvidia_llm(m, temperature=0.2):
            candidates.append((llm, f"nv:{m.split('/')[-1][:30]}"))

    if m := model_for("groq", "analysis"):
        if llm := _make_groq_llm(m, temperature=0.2):
            candidates.append((llm, f"groq:{m}"))

    # Cerebras — last in the chain because of shorter context window
    # (~32K tokens vs Gemini's 1M). For short PDFs (≤Animal Farm size)
    # it works fine; for novels it'll fail with context-length and
    # the chain will have already tried longer-context providers above.
    cerebras_key = _key("CEREBRAS_API_KEY")
    if cerebras_key:
        m = model_for("cerebras", "analysis") or model_for("cerebras", "agent")
        if m:
            try:
                candidates.append((
                    ChatCerebras(model=m, cerebras_api_key=cerebras_key, temperature=0.2, max_tokens=4096),
                    f"cerebras:{m}",
                ))
            except Exception:
                pass

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
        # Prefer the gear-modal pick; fall back to legacy CHARACTER_AGENT_MODEL env
        model = model_for("cerebras", "agent") or s.CHARACTER_AGENT_MODEL
        if model:
            return ChatCerebras(model=model, cerebras_api_key=key, temperature=0.85, max_tokens=max_tokens)
    # Soft fallback — try any available provider for character agent role
    llm = _make_llm_for_role("agent", temperature=0.85, max_tokens=max_tokens)
    if llm:
        return llm
    raise ValueError("No language model configured for this role. Open the gear icon (⚙) in the top-right and add at least one API key (Gemini's free tier is recommended).")


def get_judge_llm():
    """Kept for compatibility — use get_judge_fallbacks() for resilient calls."""
    llms = get_judge_fallbacks()
    if not llms:
        raise ValueError("No language model configured for this role. Open the gear icon (⚙) and add an API key (Gemini's free tier is recommended).")
    return llms[0][0]


def get_narrator_llm():
    """Kept for compatibility — use get_narrator_fallbacks() for resilient calls."""
    llms = get_narrator_fallbacks()
    if not llms:
        raise ValueError("No language model configured for this role. Open the gear icon (⚙) and add an API key (Gemini's free tier is recommended).")
    return llms[0][0]

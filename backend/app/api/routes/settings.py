from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
import httpx
from app.config import (
    update_runtime_keys, get_runtime_keys, get_settings,
    update_runtime_models, get_runtime_models,
    _key,
)

router = APIRouter(prefix="/settings", tags=["settings"])


class ProviderModelConfig(BaseModel):
    """User's per-provider model picks. `main` applies to every role unless
    a role-specific override is also set."""
    main:     Optional[str] = None
    agent:    Optional[str] = None
    analysis: Optional[str] = None
    judge:    Optional[str] = None
    narrator: Optional[str] = None


class KeysRequest(BaseModel):
    gemini_key:    Optional[str] = None
    groq_key:      Optional[str] = None
    cerebras_key:  Optional[str] = None
    nvidia_key:    Optional[str] = None
    anthropic_key: Optional[str] = None
    openai_key:    Optional[str] = None
    # Bring-your-own — any OpenAI-compatible endpoint anywhere in the world
    custom_llm_base_url: Optional[str] = None
    custom_llm_api_key:  Optional[str] = None
    custom_llm_model:    Optional[str] = None
    # Per-provider model picks, each from the user's live /models response
    anthropic_models: Optional[ProviderModelConfig] = None
    openai_models:    Optional[ProviderModelConfig] = None
    gemini_models:    Optional[ProviderModelConfig] = None
    groq_models:      Optional[ProviderModelConfig] = None
    cerebras_models:  Optional[ProviderModelConfig] = None
    nvidia_models:    Optional[ProviderModelConfig] = None
    custom_models:    Optional[ProviderModelConfig] = None


@router.post("/keys")
async def set_api_keys(body: KeysRequest):
    # Pass values through verbatim. update_runtime_keys distinguishes:
    #   None = field not provided (don't touch)
    #   ""   = explicit clear (overrides .env)
    #   "x"  = set new value
    update_runtime_keys(
        gemini_key=body.gemini_key,
        groq_key=body.groq_key,
        cerebras_key=body.cerebras_key,
        nvidia_key=body.nvidia_key,
        anthropic_key=body.anthropic_key,
        openai_key=body.openai_key,
        custom_llm_base_url=body.custom_llm_base_url,
        custom_llm_api_key=body.custom_llm_api_key,
        custom_llm_model=body.custom_llm_model,
    )
    # Per-provider model picks
    for provider, cfg in (
        ("anthropic", body.anthropic_models),
        ("openai",    body.openai_models),
        ("gemini",    body.gemini_models),
        ("groq",      body.groq_models),
        ("cerebras",  body.cerebras_models),
        ("nvidia",    body.nvidia_models),
        ("custom",    body.custom_models),
    ):
        if cfg is not None:
            update_runtime_models(provider, cfg.model_dump(exclude_none=True))
    return {"status": "ok"}


@router.get("/keys/status")
async def get_keys_status():
    """Returns which keys are configured and the current model picks per provider,
    without revealing values. Respects the explicit-clear sentinel — a key
    cleared via the UI overrides any value still in .env."""
    from app.config import get_effective_key
    models = get_runtime_models()

    custom_base  = get_effective_key("CUSTOM_LLM_BASE_URL")
    custom_key   = get_effective_key("CUSTOM_LLM_API_KEY")
    custom_model = get_effective_key("CUSTOM_LLM_MODEL")

    return {
        "anthropic": bool(get_effective_key("ANTHROPIC_API_KEY")),
        "openai":    bool(get_effective_key("OPENAI_API_KEY")),
        "gemini":    bool(get_effective_key("GEMINI_API_KEY")),
        "groq":      bool(get_effective_key("GROQ_API_KEY")),
        "cerebras":  bool(get_effective_key("CEREBRAS_API_KEY")),
        "nvidia":    bool(get_effective_key("NVIDIA_API_KEY")),
        "custom":    bool(custom_base and custom_key and custom_model),
        "custom_base_url": custom_base,
        "custom_model":    custom_model,
        # Echo back the user's per-provider model picks
        "models": models,
    }


# ── Live model fetch per provider ──

# Patterns to exclude from chat-completions dropdowns. Most providers expose
# embeddings / audio / image models that we can't use for the debate engine.
NON_CHAT_PATTERNS = (
    "whisper", "tts-", "dall-e", "embedding", "embed-",
    "babbage", "davinci-00", "moderation", "image",
    "audio", "speech", "vision-only", "stt-", "transcribe",
)


def _is_chat_capable(model_id: str) -> bool:
    lower = (model_id or "").lower()
    return bool(lower) and not any(p in lower for p in NON_CHAT_PATTERNS)


async def _fetch_anthropic_models(api_key: str) -> list[str]:
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(
            "https://api.anthropic.com/v1/models",
            headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
        )
        r.raise_for_status()
        data = r.json()
        seen: set[str] = set()
        out: list[str] = []
        for m in data.get("data", []):
            mid = m.get("id", "")
            if mid and _is_chat_capable(mid) and mid not in seen:
                seen.add(mid)
                out.append(mid)
        return out


async def _fetch_openai_compat_models(base_url: str, api_key: str) -> list[str]:
    """Generic /models for any OpenAI-compatible endpoint."""
    url = base_url.rstrip("/") + "/models"
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(url, headers={"Authorization": f"Bearer {api_key}"})
        r.raise_for_status()
        data = r.json()
        items = data.get("data", []) or data.get("models", [])
        seen: set[str] = set()
        ids: list[str] = []
        for m in items:
            mid = m.get("id") or m.get("name") or m
            if isinstance(mid, str) and _is_chat_capable(mid) and mid not in seen:
                seen.add(mid)
                ids.append(mid)
        return ids


async def _fetch_gemini_models(api_key: str) -> list[str]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(url)
        r.raise_for_status()
        data = r.json()
        seen: set[str] = set()
        out: list[str] = []
        for m in data.get("models", []):
            name = m.get("name", "")
            # Strip the "models/" prefix Gemini returns
            if name.startswith("models/"):
                name = name[7:]
            methods = m.get("supportedGenerationMethods") or []
            if name and "generateContent" in methods and _is_chat_capable(name) and name not in seen:
                seen.add(name)
                out.append(name)
        return out


PROVIDER_BASES = {
    "openai":   "https://api.openai.com/v1",
    "groq":     "https://api.groq.com/openai/v1",
    "cerebras": "https://api.cerebras.ai/v1",
    "nvidia":   "https://integrate.api.nvidia.com/v1",
}

PROVIDER_KEY_NAMES = {
    "openai":    "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "gemini":    "GEMINI_API_KEY",
    "groq":      "GROQ_API_KEY",
    "cerebras":  "CEREBRAS_API_KEY",
    "nvidia":    "NVIDIA_API_KEY",
}

# Our blessed starter suggestion per provider — not enforced anywhere; the
# frontend marks this as "(recommended)" in the dropdown and auto-selects it
# the first time the user adds a key. If the provider has deprecated it, we
# fall through to whatever's first in the live list.
# Note: each provider's actual model catalog drifts. We list a known-good
# stable id here, but the dropdown also fetches the LIVE list and falls
# through to the first item if the recommended id is no longer served.
# Keep these to ids that are GA (not preview / experimental) so first-time
# users don't get 404'd.
RECOMMENDED_MODELS = {
    "anthropic": "claude-3-5-haiku-20241022",     # GA Haiku 3.5 — safe baseline
    "openai":    "gpt-4o-mini",                    # GA, free in some plans
    "gemini":    "gemini-2.0-flash",               # GA, broadly available, free tier
    "groq":      "llama-3.3-70b-versatile",
    "cerebras":  "llama3.3-70b",                   # widely-available stable id on Cerebras
    "nvidia":    "meta/llama-3.3-70b-instruct",
}


@router.get("/providers/{provider}/models")
async def list_provider_models(provider: str):
    """Return the live list of chat-capable models the user's key can access,
    plus our blessed `recommended` suggestion (or null if it's not in the
    live list — e.g. the provider deprecated it)."""
    if provider == "custom":
        base_url = _key("CUSTOM_LLM_BASE_URL")
        api_key  = _key("CUSTOM_LLM_API_KEY")
        if not base_url or not api_key:
            raise HTTPException(status_code=400, detail="Custom provider not configured")
        try:
            models = await _fetch_openai_compat_models(base_url, api_key)
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=502, detail=f"Provider returned {e.response.status_code}")
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Cannot reach provider: {e}")
        return {"provider": "custom", "models": models, "recommended": None}

    if provider not in PROVIDER_KEY_NAMES:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")

    api_key = _key(PROVIDER_KEY_NAMES[provider])
    if not api_key:
        raise HTTPException(status_code=400, detail=f"No {provider} API key configured")

    try:
        if provider == "anthropic":
            models = await _fetch_anthropic_models(api_key)
        elif provider == "gemini":
            models = await _fetch_gemini_models(api_key)
        else:
            models = await _fetch_openai_compat_models(PROVIDER_BASES[provider], api_key)
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"{provider} returned HTTP {e.response.status_code}")
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Cannot reach {provider}: {e}")

    # Sort alphabetically for stable UI ordering
    models.sort()
    rec = RECOMMENDED_MODELS.get(provider)
    if rec and rec not in models:
        rec = None  # provider deprecated it; don't suggest
    return {"provider": provider, "models": models, "recommended": rec}

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional
from app.config import update_runtime_keys, get_runtime_keys, get_settings

router = APIRouter(prefix="/settings", tags=["settings"])


class KeysRequest(BaseModel):
    gemini_key: Optional[str] = None
    groq_key: Optional[str] = None
    cerebras_key: Optional[str] = None
    nvidia_key: Optional[str] = None
    anthropic_key: Optional[str] = None
    openai_key: Optional[str] = None
    # Bring-your-own — any OpenAI-compatible endpoint anywhere in the world
    custom_llm_base_url: Optional[str] = None
    custom_llm_api_key: Optional[str] = None
    custom_llm_model: Optional[str] = None


@router.post("/keys")
async def set_api_keys(body: KeysRequest):
    update_runtime_keys(
        gemini_key=body.gemini_key or None,
        groq_key=body.groq_key or None,
        cerebras_key=body.cerebras_key or None,
        nvidia_key=body.nvidia_key or None,
        anthropic_key=body.anthropic_key or None,
        openai_key=body.openai_key or None,
        custom_llm_base_url=body.custom_llm_base_url or None,
        custom_llm_api_key=body.custom_llm_api_key or None,
        custom_llm_model=body.custom_llm_model or None,
    )
    return {"status": "ok"}


@router.get("/keys/status")
async def get_keys_status():
    """Returns which keys are configured (runtime or .env), without revealing values."""
    runtime = get_runtime_keys()
    s = get_settings()

    custom_base  = runtime.get("CUSTOM_LLM_BASE_URL") or s.CUSTOM_LLM_BASE_URL
    custom_key   = runtime.get("CUSTOM_LLM_API_KEY")  or s.CUSTOM_LLM_API_KEY
    custom_model = runtime.get("CUSTOM_LLM_MODEL")    or s.CUSTOM_LLM_MODEL

    return {
        "anthropic": bool(runtime.get("ANTHROPIC_API_KEY") or s.ANTHROPIC_API_KEY),
        "openai":    bool(runtime.get("OPENAI_API_KEY")    or s.OPENAI_API_KEY),
        "gemini":    bool(runtime.get("GEMINI_API_KEY")    or s.GEMINI_API_KEY),
        "groq":      bool(runtime.get("GROQ_API_KEY")      or s.GROQ_API_KEY),
        "cerebras":  bool(runtime.get("CEREBRAS_API_KEY")  or s.CEREBRAS_API_KEY),
        "nvidia":    bool(runtime.get("NVIDIA_API_KEY")    or s.NVIDIA_API_KEY),
        "custom":    bool(custom_base and custom_key and custom_model),
        # Echo back the model id so the UI can show it; never echo the key.
        "custom_base_url": custom_base or None,
        "custom_model":    custom_model or None,
    }

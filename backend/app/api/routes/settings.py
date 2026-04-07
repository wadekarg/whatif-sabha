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


@router.post("/keys")
async def set_api_keys(body: KeysRequest):
    update_runtime_keys(
        gemini_key=body.gemini_key or None,
        groq_key=body.groq_key or None,
        cerebras_key=body.cerebras_key or None,
        nvidia_key=body.nvidia_key or None,
    )
    return {"status": "ok"}


@router.get("/keys/status")
async def get_keys_status():
    """Returns which keys are configured (runtime or .env), without revealing values."""
    runtime = get_runtime_keys()
    s = get_settings()
    return {
        "gemini": bool(runtime.get("GEMINI_API_KEY") or s.GEMINI_API_KEY),
        "groq": bool(runtime.get("GROQ_API_KEY") or s.GROQ_API_KEY),
        "cerebras": bool(runtime.get("CEREBRAS_API_KEY") or s.CEREBRAS_API_KEY),
        "nvidia": bool(runtime.get("NVIDIA_API_KEY") or s.NVIDIA_API_KEY),
    }

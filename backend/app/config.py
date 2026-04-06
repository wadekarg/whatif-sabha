from pydantic_settings import BaseSettings
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_groq import ChatGroq
from langchain_cerebras import ChatCerebras
from functools import lru_cache
from typing import Optional

# Runtime key overrides — set via /settings/keys endpoint from the UI
_runtime_keys: dict[str, str] = {}


def update_runtime_keys(gemini_key: str = None, groq_key: str = None, cerebras_key: str = None):
    if gemini_key:
        _runtime_keys["GEMINI_API_KEY"] = gemini_key
    if groq_key:
        _runtime_keys["GROQ_API_KEY"] = groq_key
    if cerebras_key:
        _runtime_keys["CEREBRAS_API_KEY"] = cerebras_key


def get_runtime_keys() -> dict:
    return _runtime_keys


class Settings(BaseSettings):
    GEMINI_API_KEY: Optional[str] = None
    GROQ_API_KEY: Optional[str] = None
    CEREBRAS_API_KEY: Optional[str] = None

    DATABASE_URL: str = "sqlite+aiosqlite:///./whatif_sabha.db"
    REDIS_URL: str = "redis://localhost:6379"
    UPLOAD_DIR: str = "./uploads"
    MAX_UPLOAD_SIZE_MB: int = 50

    # Model IDs — change here to swap providers, nothing else needs touching
    ANALYSIS_MODEL: str = "gemini-3.1-flash-lite-preview"
    CHARACTER_AGENT_MODEL: str = "qwen-3-235b-a22b-instruct-2507"
    JUDGE_MODEL: str = "llama-3.3-70b-versatile"
    NARRATOR_MODEL: str = "llama-3.3-70b-versatile"

    class Config:
        env_file = ".env"


@lru_cache()
def get_settings() -> Settings:
    return Settings()


def _key(env_key: str) -> str:
    """Return runtime override if set, else fall back to .env value."""
    return _runtime_keys.get(env_key) or (get_settings().__dict__.get(env_key) or "")


def get_analysis_llm():
    """Gemini Flash — 1M token context. Story ingestion and chat."""
    s = get_settings()
    key = _key("GEMINI_API_KEY")
    if not key:
        raise ValueError("Gemini API key not set. Add it via the ⚙ Settings button.")
    return ChatGoogleGenerativeAI(model=s.ANALYSIS_MODEL, google_api_key=key, temperature=0.2)


def get_agent_llm(max_tokens: int = 300):
    """Cerebras qwen-3-235b — ultra-fast character agent streaming."""
    s = get_settings()
    key = _key("CEREBRAS_API_KEY")
    if not key:
        raise ValueError("Cerebras API key not set. Add it via the ⚙ Settings button.")
    return ChatCerebras(model=s.CHARACTER_AGENT_MODEL, cerebras_api_key=key, temperature=0.85, max_tokens=max_tokens)


def get_judge_llm():
    """Groq llama-3.3-70b — structured evaluation."""
    s = get_settings()
    key = _key("GROQ_API_KEY")
    if not key:
        raise ValueError("Groq API key not set. Add it via the ⚙ Settings button.")
    return ChatGroq(model=s.JUDGE_MODEL, groq_api_key=key, temperature=0.1)


def get_narrator_llm():
    """Groq llama-3.3-70b — final alternate ending prose."""
    s = get_settings()
    key = _key("GROQ_API_KEY")
    if not key:
        raise ValueError("Groq API key not set. Add it via the ⚙ Settings button.")
    return ChatGroq(model=s.NARRATOR_MODEL, groq_api_key=key, temperature=0.6)

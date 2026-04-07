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
):
    if gemini_key:
        _runtime_keys["GEMINI_API_KEY"] = gemini_key
    if groq_key:
        _runtime_keys["GROQ_API_KEY"] = groq_key
    if cerebras_key:
        _runtime_keys["CEREBRAS_API_KEY"] = cerebras_key
    if nvidia_key:
        _runtime_keys["NVIDIA_API_KEY"] = nvidia_key


def get_runtime_keys() -> dict:
    return _runtime_keys


class Settings(BaseSettings):
    GEMINI_API_KEY: Optional[str] = None
    GROQ_API_KEY: Optional[str] = None
    CEREBRAS_API_KEY: Optional[str] = None
    NVIDIA_API_KEY: Optional[str] = None

    DATABASE_URL: str = "sqlite+aiosqlite:///./whatif_sabha.db"
    REDIS_URL: str = "redis://localhost:6379"
    UPLOAD_DIR: str = "./uploads"
    MAX_UPLOAD_SIZE_MB: int = 50

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

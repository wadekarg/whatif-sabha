from pydantic_settings import BaseSettings
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_groq import ChatGroq
from langchain_cerebras import ChatCerebras
from functools import lru_cache


class Settings(BaseSettings):
    GEMINI_API_KEY: str
    GROQ_API_KEY: str
    CEREBRAS_API_KEY: str

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


def get_analysis_llm():
    """
    Gemini 3.1 Flash Lite — 1M token context window.
    Used for full story ingestion and analysis. 1 call per upload.
    """
    s = get_settings()
    return ChatGoogleGenerativeAI(
        model=s.ANALYSIS_MODEL,
        google_api_key=s.GEMINI_API_KEY,
        temperature=0.2,
    )


def get_agent_llm():
    """
    Cerebras qwen-3-235b — 235B model on wafer-scale chip.
    Ultra-fast streaming for character agents during debate.
    14,400 RPD free tier.
    """
    s = get_settings()
    return ChatCerebras(
        model=s.CHARACTER_AGENT_MODEL,
        cerebras_api_key=s.CEREBRAS_API_KEY,
        temperature=0.75,
        max_tokens=350,  # ~150 words max; prevents double-response runaway
    )


def get_judge_llm():
    """
    Groq llama-3.3-70b — best quality for structured evaluation.
    Only ~20 calls per debate, well within 1K RPD limit.
    """
    s = get_settings()
    return ChatGroq(
        model=s.JUDGE_MODEL,
        groq_api_key=s.GROQ_API_KEY,
        temperature=0.1,
    )


def get_narrator_llm():
    """
    Groq llama-3.3-70b — best prose quality for final alternate ending.
    1 call per debate.
    """
    s = get_settings()
    return ChatGroq(
        model=s.NARRATOR_MODEL,
        groq_api_key=s.GROQ_API_KEY,
        temperature=0.6,
    )

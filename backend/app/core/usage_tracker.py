"""
API Usage Tracker — proactive rate limit management.

Tracks requests per minute and per day for each provider.
Before making a call, check if the provider can handle it.
Skip to next provider WITHOUT hitting a 429.
"""

import time
import logging
from collections import defaultdict
from threading import Lock

logger = logging.getLogger(__name__)


# Known rate limits per provider (requests)
PROVIDER_LIMITS = {
    "nvidia": {"rpm": 38, "daily": None},          # ~40 RPM, no daily limit
    "cerebras": {"rpm": 30, "daily": 14000},        # ~30 RPM, 14.4K/day
    "groq": {"rpm": 30, "daily": 14000},            # varies by model, ~30 RPM safe
    "gemini": {"rpm": 14, "daily": 490},            # 15 RPM, 500/day (leave margin)
    "anthropic": {"rpm": 50, "daily": None},          # generous tier-1 limits
    "openai": {"rpm": 60, "daily": None},             # pay-as-you-go, no daily limit
    "github": {"rpm": 9, "daily": 45},              # 10 RPM, ~50/day per model
    "cloudflare": {"rpm": 50, "daily": 2000},       # generous RPM, ~2K effective daily
}


class UsageTracker:
    """Thread-safe API usage tracker with per-minute and per-day counters."""

    def __init__(self):
        self._lock = Lock()
        # {provider: [(timestamp, count), ...]} — rolling window
        self._minute_log: dict[str, list[float]] = defaultdict(list)
        # {provider: {date_str: count}}
        self._daily_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    def _today(self) -> str:
        return time.strftime("%Y-%m-%d")

    def _clean_minute_window(self, provider: str):
        """Remove entries older than 60 seconds."""
        cutoff = time.time() - 60
        self._minute_log[provider] = [
            t for t in self._minute_log[provider] if t > cutoff
        ]

    def can_use(self, provider: str) -> bool:
        """Check if this provider can handle one more request right now."""
        limits = PROVIDER_LIMITS.get(provider, {"rpm": 100, "daily": None})

        with self._lock:
            self._clean_minute_window(provider)

            # Check RPM
            rpm_limit = limits.get("rpm")
            if rpm_limit and len(self._minute_log[provider]) >= rpm_limit:
                return False

            # Check daily
            daily_limit = limits.get("daily")
            if daily_limit:
                today = self._today()
                if self._daily_counts[provider][today] >= daily_limit:
                    return False

        return True

    def record(self, provider: str):
        """Record a request to this provider."""
        with self._lock:
            self._minute_log[provider].append(time.time())
            today = self._today()
            self._daily_counts[provider][today] += 1

    def get_status(self) -> dict:
        """Get current usage status for all providers."""
        status = {}
        today = self._today()

        with self._lock:
            for provider, limits in PROVIDER_LIMITS.items():
                self._clean_minute_window(provider)
                rpm_used = len(self._minute_log[provider])
                rpm_limit = limits.get("rpm", "∞")
                daily_used = self._daily_counts[provider].get(today, 0)
                daily_limit = limits.get("daily")

                status[provider] = {
                    "rpm_used": rpm_used,
                    "rpm_limit": rpm_limit,
                    "rpm_available": (rpm_limit - rpm_used) if isinstance(rpm_limit, int) else "∞",
                    "daily_used": daily_used,
                    "daily_limit": daily_limit or "unlimited",
                    "daily_available": (daily_limit - daily_used) if daily_limit else "unlimited",
                    "healthy": self.can_use(provider),
                }

        return status

    def get_best_provider(self, candidates: list[str]) -> str | None:
        """From a list of provider names, return the first one that can handle a request."""
        for provider in candidates:
            if self.can_use(provider):
                return provider
        return None

    def reset_daily(self, provider: str):
        """Manually reset daily counter (e.g., after midnight)."""
        with self._lock:
            today = self._today()
            self._daily_counts[provider][today] = 0


# Global singleton
tracker = UsageTracker()

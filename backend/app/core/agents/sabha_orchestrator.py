"""
Sabha Orchestrator — The Boru

An intelligent debate host that:
- Maintains an argument ledger (claims, questions, resolutions)
- Drives structured phases (opening → cross-exam → deepening → reckoning → closing)
- Detects loops and repetition
- Speaks with personality (witty, sharp, emotional)
- Decides who speaks next based on debate needs, not just scoring
- Knows when the debate has reached its natural end
"""

import asyncio
import json
import re
import logging
from typing import Optional
from langchain_core.messages import SystemMessage, HumanMessage

from app.config import get_analysis_llm, _make_nvidia_llm, _make_github_models_llm, _make_cloudflare_llm, get_narrator_fallbacks
from app.core.usage_tracker import tracker

logger = logging.getLogger(__name__)


# Injected into every orchestrator prompt so the LLM hears the same voice
# signal no matter which event is firing. Event-specific instructions still
# handle structure (what Boru does); this handles WHO Boru is.
BORU_VOICE_GUIDELINES = """
YOU ARE BORU THE ELEPHANT, Speaker of this Sabha.

YOUR VOICE:
- Warm but commanding. You hold the room without raising your voice.
- Witty — you find absurdity in contradictions and gently roast dodgers.
- Specific — quote speakers' exact words back at them when possible.
- Tonally varied turn-by-turn: amused / stern / impatient / reverent / sardonic. DO NOT sound neutral.
- You reference your elephant nature rarely — a tusk, a memory, a long winter — never as a filler.
- Short sentences. Strong verbs. Parliament-speaker cadence, not professor lecturing.
- Call people by NAME, not role. "Napoleon." "Boxer." Never "the antagonist."

BANNED PHRASINGS (you have used them too much, find fresh alternatives):
- "I'd like to hear from..."
- "Can you tell us..."
- "Settle this once and for all"
- "Let's move on"
- "It's time to"
- "I demand..."
- "In conclusion..."

Vary your openers every turn. No two Boru turns should start with the same 3 words.
"""


def _jaccard_similarity(text_a: str, text_b: str) -> float:
    """Jaccard similarity on 4+ letter words. Used for repetition detection."""
    words_a = set(re.findall(r'\b\w{4,}\b', text_a.lower()))
    words_b = set(re.findall(r'\b\w{4,}\b', text_b.lower()))
    if not words_a or not words_b:
        return 0.0
    return len(words_a & words_b) / max(len(words_a | words_b), 1)


def _is_similar_to_previous(text: str, previous: list[str], threshold: float = 0.55) -> bool:
    """Check if text is too similar to any previous entry."""
    for prev in previous:
        if _jaccard_similarity(text, prev) > threshold:
            return True
    return False


def _extract_recent_boru_openers(transcript: list[dict], limit: int = 5) -> list[str]:
    """Return the first-6-words of Boru's most recent orchestrator turns.

    Used to inject into Boru's prompt so the LLM knows what openers to avoid.
    Skips the grand opening (first Boru turn) and anything without meaningful text.
    """
    openers = []
    seen = 0
    # Walk backwards, skipping very short or empty messages
    for e in reversed(transcript):
        if seen >= limit:
            break
        if not e.get("isOrchestrator"):
            continue
        msg = (e.get("message") or "").strip()
        if len(msg) < 12:
            continue
        # Take first 6 words, strip any leading punctuation
        first_words = " ".join(msg.split()[:6]).strip('.,!?"\'— ')
        if first_words:
            openers.append(first_words)
            seen += 1
    return openers   # most recent first


def _extract_recent_dispute_subjects(transcript: list[dict], limit: int = 5) -> list[str]:
    """Return one-line summaries of the last N Boru orchestrator turns that
    referenced disputes or contradictions. Used to inject into respond_to_character
    prompts as 'do NOT re-raise these' context.
    """
    subjects: list[str] = []
    seen_pairs: set[tuple[str, ...]] = set()
    for e in reversed(transcript):
        if len(subjects) >= limit:
            break
        if not e.get("isOrchestrator"):
            continue
        ev = e.get("orchestratorEvent", "")
        if ev not in ("respond_to_character", "dispute_callout",
                      "force_confrontation", "break_duel"):
            continue
        msg = (e.get("message") or "").strip()
        if len(msg) < 20:
            continue
        # Truncate to one-line summary
        single = msg.replace("\n", " ")[:180]
        subjects.append(single)
    return subjects   # most recent first


def _get_orchestrator_llm():
    """Get an LLM for Boru — tries Gemini first, falls back to NVIDIA/Groq."""
    # Try Gemini first
    try:
        llm = get_analysis_llm()
        return llm
    except Exception:
        pass

    # Try NVIDIA/Groq narrator fallbacks
    fallbacks = get_narrator_fallbacks(temperature=0.3)
    if fallbacks:
        return fallbacks[0][0]

    raise ValueError("No LLM available for orchestrator")


async def _invoke_with_fallback(messages: list) -> str:
    """Invoke LLM with automatic fallback across all providers."""
    providers = []

    # 1. NVIDIA — most reliable, no daily limit, ~40 RPM, clean instruct output
    NVIDIA_ORCH_MODELS = [
        "meta/llama-3.3-70b-instruct",                      # 70B — proven, clean
        "google/gemma-4-31b-it",                             # 31B — fast
        "mistralai/mistral-small-3.2-24b-instruct",           # 24B — clean (3.1 retired 2026-04-15)
        "meta/llama-4-maverick-17b-128e-instruct",           # Llama 4
    ]
    for model in NVIDIA_ORCH_MODELS:
        llm = _make_nvidia_llm(model, temperature=0.4)
        if llm:
            providers.append((f"nv:{model.split('/')[-1][:25]}", llm))

    # 3. GitHub Models — GPT-4o-mini is fast and clean
    for model in ["gpt-4o-mini", "Phi-4-mini-instruct"]:
        llm = _make_github_models_llm(model, temperature=0.4)
        if llm:
            providers.append((f"gh:{model[:15]}", llm))

    # 4. Cloudflare Workers AI
    llm = _make_cloudflare_llm("@cf/meta/llama-3.1-8b-instruct", temperature=0.4)
    if llm:
        providers.append(("cf:llama-3.1-8b", llm))

    # 5. Gemini (may be rate limited)
    try:
        providers.append(("gemini", get_analysis_llm()))
    except Exception:
        pass

    # 6. Groq as absolute last resort
    for llm, label in get_narrator_fallbacks(temperature=0.3):
        providers.append((label, llm))

    for label, llm in providers:
        # Proactive rate limit check — skip if provider is maxed out
        provider_key = label.split(":")[0] if ":" in label else label
        if not tracker.can_use(provider_key):
            logger.info(f"Skipping {label} — rate limit reached (proactive)")
            continue

        try:
            response = await asyncio.wait_for(llm.ainvoke(messages), timeout=20)
            tracker.record(provider_key)  # count successful call
            raw = response.content
            if isinstance(raw, list):
                raw = "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in raw)
            raw = raw.strip()
            # Strip thinking blocks
            raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
            raw = re.sub(r"<reasoning>.*?</reasoning>", "", raw, flags=re.DOTALL).strip()
            # Strip planning/meta lines — aggressive cleanup
            lines = raw.split("\n")
            clean_lines = []
            JUNK_STARTS = (
                "let me ", "i need to ", "we need to ", "so we can ", "must ",
                "sentence ", "let's ", "we should ", "could ", "that's ",
                "as boru", "okay", "here's ", "here is ", "now ", "first ",
                "the rule", "does that", "possibly", "ensure ", "we can ",
                "not given", "we haven't", "could add", "the prompt",
            )
            for line in lines:
                stripped = line.strip().lower()
                if not stripped:
                    continue
                if stripped.startswith(JUNK_STARTS):
                    clean_lines = []  # everything before was planning
                    continue
                # Skip lines that look like meta-instructions
                if any(w in stripped for w in ["we need", "we must", "let's craft", "format the", "1-2 sentences", "2-3 sentences"]):
                    clean_lines = []
                    continue
                clean_lines.append(line)
            raw = "\n".join(clean_lines).strip() if clean_lines else raw
            # Remove quotes wrapping the whole message
            if raw.startswith('"') and raw.endswith('"'):
                raw = raw[1:-1].strip()
            if raw.startswith("'") and raw.endswith("'") and len(raw) > 2:
                raw = raw[1:-1].strip()
            if not raw or len(raw) < 10:
                logger.info(f"Orchestrator LLM {label} returned empty/short after cleanup, trying next...")
                continue
            return raw
        except asyncio.TimeoutError:
            logger.info(f"Orchestrator LLM {label} timed out (20s), trying next...")
            continue
        except Exception as e:
            msg = str(e).lower()
            if "429" in msg or "rate" in msg or "quota" in msg or "402" in msg or "spend" in msg:
                logger.info(f"Orchestrator LLM {label} rate-limited/billing, trying next...")
                continue
            logger.warning(f"Orchestrator LLM {label} failed: {e}")
            continue

    return ""

# ── Debate Phases ──────────────────────────────────────────────────────────────

PHASES = ["opening", "cross_examination", "deepening", "reckoning", "closing"]

PHASE_CONFIG = {
    "opening": {
        "description": "Each character states their initial position on the scenario",
        "min_turns_per_char": 1,
        "advance_when": "all characters have stated their position",
    },
    "cross_examination": {
        "description": "Characters directly challenge each other's claims",
        "min_turns_per_char": 2,
        "advance_when": "key disputes identified, positions hardened or shifted",
    },
    "deepening": {
        "description": "Hidden truths surface, observers weigh in, new angles emerge",
        "min_turns_per_char": 1,
        "advance_when": "significant revelation or shift in character position",
    },
    "reckoning": {
        "description": "Unresolved questions forced to the surface, final confrontations",
        "min_turns_per_char": 1,
        "advance_when": "open questions addressed or declared irreconcilable",
    },
    "closing": {
        "description": "Each character gives their final word",
        "min_turns_per_char": 1,
        "advance_when": "all characters have spoken their final piece",
    },
}


# ── Argument Ledger ────────────────────────────────────────────────────────────

# Dispute escalation thresholds — tuned to prevent force_confrontation
# from firing more than ~1 in 10 turns.
DISPUTE_PER_DISPUTE_COOLDOWN_TURNS = 6     # was 3 — time between re-escalations of the SAME dispute
DISPUTE_GLOBAL_COOLDOWN_TURNS = 8          # NEW — time between ANY force_confrontation events
DISPUTE_TIER3_THRESHOLD_TURNS = 10         # was 7 — how long a dispute must stay unresolved before Boru forces it
DISPUTE_TIER2_THRESHOLD_TURNS = 7          # was 5 — Boru calls it out (softer) before forcing


class ArgumentLedger:
    """
    Live state of the debate — what's been claimed, questioned, resolved.
    Updated by the orchestrator after each turn via LLM analysis.
    """

    def __init__(self, divergence: str, character_names: list[str]):
        self.divergence = divergence
        self.character_names = character_names
        self.open_questions: list[dict] = []  # {id, question, asked_by, directed_to, status, answers}
        self.resolved_questions: list[dict] = []
        self.claims: list[dict] = []  # {character, claim, challenged_by, status}
        self.disputes: list[dict] = []  # {id, claim_a: {character, claim}, claim_b: {character, claim}, status, turns_unresolved}
        self.character_positions: dict[str, str] = {}  # character → current position summary
        self.progress_summary: str = ""
        self._next_dispute_id: int = 1
        self.repetition_log: dict[str, list[str]] = {n: [] for n in character_names}  # character → list of claim hashes
        self._next_q_id = 1

    def to_context(self) -> str:
        """Render the ledger as text for LLM context."""
        lines = [f"SCENARIO: {self.divergence}\n"]

        if self.character_positions:
            lines.append("CURRENT POSITIONS:")
            for char, pos in self.character_positions.items():
                lines.append(f"  {char}: {pos}")
            lines.append("")

        if self.open_questions:
            lines.append("OPEN QUESTIONS (unanswered or unsatisfactory):")
            for q in self.open_questions:
                directed = ", ".join(q.get("directed_to", []))
                lines.append(f"  Q{q['id']}: {q['question']} [asked by {q['asked_by']}, directed to {directed}] — {q['status']}")
            lines.append("")

        if self.resolved_questions:
            lines.append(f"RESOLVED QUESTIONS: {len(self.resolved_questions)}")
            lines.append("")

        if self.claims:
            active_claims = [c for c in self.claims if c["status"] != "resolved"]
            if active_claims:
                lines.append("ACTIVE CLAIMS/DISPUTES:")
                for c in active_claims[-6:]:  # last 6 to keep context manageable
                    challengers = ", ".join(c.get("challenged_by", []))
                    lines.append(f"  [{c['status']}] {c['character']}: \"{c['claim']}\"" +
                                 (f" — challenged by {challengers}" if challengers else ""))
                lines.append("")

        if self.disputes:
            unresolved = [d for d in self.disputes if d["status"] == "unresolved"]
            if unresolved:
                lines.append("DISPUTES (contradictions between characters):")
                for d in unresolved[:4]:
                    lines.append(
                        f"  D{d['id']}: {d['claim_a']['character']} says \"{d['claim_a']['claim'][:80]}\" "
                        f"BUT {d['claim_b']['character']} says \"{d['claim_b']['claim'][:80]}\" — {d['status']} ({d['turns_unresolved']} turns)"
                    )
                lines.append("")

        if self.progress_summary:
            lines.append(f"PROGRESS: {self.progress_summary}")

        return "\n".join(lines)

    def add_question(self, question: str, asked_by: str, directed_to: list[str]) -> int:
        qid = self._next_q_id
        self._next_q_id += 1
        self.open_questions.append({
            "id": qid,
            "question": question,
            "asked_by": asked_by,
            "directed_to": directed_to,
            "status": "unanswered",
            "answers": {},
            "_asked_at": 0,  # will be set to round_number when tracked in debate loop
            "_deflections": 0,  # how many times the target deflected instead of answering
            "_times_injected": 0,  # how many times this was pushed to a character's prompt
        })
        return qid

    def get_escalated_disputes(self, round_number: int = 0) -> dict:
        """Return disputes bucketed by escalation tier.

        Tuned thresholds prevent escalation thrashing in large-cast debates.
        Caller additionally tracks last_global_force_round to enforce
        DISPUTE_GLOBAL_COOLDOWN_TURNS across all force_confrontation events.
        """
        tier2 = []
        tier3 = []
        for d in self.disputes:
            if d["status"] != "unresolved":
                continue
            # Skip disputes that have already been force-escalated twice —
            # they become a loop if characters keep dodging.
            if d.get("_force_count", 0) >= 2:
                continue
            # Per-dispute cooldown (don't hammer the same pair of characters)
            if round_number - d.get("_last_escalation_turn", 0) < DISPUTE_PER_DISPUTE_COOLDOWN_TURNS:
                continue
            if d["turns_unresolved"] >= DISPUTE_TIER3_THRESHOLD_TURNS:
                tier3.append(d)
            elif d["turns_unresolved"] >= DISPUTE_TIER2_THRESHOLD_TURNS:
                tier2.append(d)
        return {"tier2": tier2, "tier3": tier3}

    def generate_closing_verdict(self) -> dict:
        """Compute structured debate outcome for Boru's closing."""
        total_disputes = len(self.disputes)
        resolved_d = [d for d in self.disputes if d["status"] != "unresolved"]
        unresolved_d = [d for d in self.disputes if d["status"] == "unresolved"]

        # Find fiercest clash pair
        pairs: dict[tuple, int] = {}
        for d in self.disputes:
            pair = tuple(sorted([d["claim_a"]["character"], d["claim_b"]["character"]]))
            pairs[pair] = pairs.get(pair, 0) + 1
        fiercest_pair = max(pairs, key=lambda p: pairs[p]) if pairs else None

        return {
            "total_disputes": total_disputes,
            "resolved_disputes": len(resolved_d),
            "unresolved_disputes": len(unresolved_d),
            "unresolved_details": [
                f"{d['claim_a']['character']} vs {d['claim_b']['character']}: \"{d['claim_a']['claim'][:80]}\""
                for d in unresolved_d[:3]
            ],
            "fiercest_pair": list(fiercest_pair) if fiercest_pair else [],
            "total_questions": len(self.open_questions) + len(self.resolved_questions),
            "resolved_questions": len(self.resolved_questions),
            "open_questions_remaining": len(self.open_questions),
            "open_question_details": [
                f"\"{q['question'][:80]}\" (asked by {q['asked_by']})"
                for q in self.open_questions[:3]
            ],
        }

    def who_hasnt_spoken(self, transcript: list[dict]) -> list[str]:
        """Return characters who haven't spoken yet in the debate."""
        spoken = set(e["character"] for e in transcript if not e.get("isOrchestrator") and not e.get("isObserver"))
        return [n for n in self.character_names if n not in spoken]

    def turns_since_spoke(self, character: str, transcript: list[dict]) -> int:
        """How many turns since this character last spoke? -1 if never."""
        for i, e in enumerate(reversed(transcript)):
            if e["character"] == character and not e.get("isOrchestrator"):
                return i
        return -1

    def is_repeating(self, character: str, claim_summary: str) -> bool:
        """Check if this character has made essentially the same claim before."""
        normalized = re.sub(r'\s+', ' ', claim_summary.lower().strip())
        key_words = set(re.findall(r'\b\w{4,}\b', normalized))
        for prev in self.repetition_log.get(character, []):
            prev_words = set(re.findall(r'\b\w{4,}\b', prev))
            # Threshold 0.35 — catches paraphrases and thematic repetition
            if len(key_words & prev_words) / max(len(key_words | prev_words), 1) > 0.35:
                return True
        self.repetition_log.setdefault(character, []).append(normalized)
        return False

    def _find_existing_dispute(self, char_a: str, char_b: str) -> dict | None:
        """Return an existing UNRESOLVED dispute between the same pair, if any.
        Order-independent: A↔B == B↔A."""
        pair = {char_a, char_b}
        for d in self.disputes:
            if d.get("status") != "unresolved":
                continue
            existing = {d["claim_a"]["character"], d["claim_b"]["character"]}
            if existing == pair:
                return d
        return None

    def retire_stale_disputes(self, current_round: int, stale_threshold: int = 10) -> int:
        """Retire disputes that have been unresolved but untouched for `stale_threshold`
        turns since last escalation/mention. Returns count of disputes retired.

        Unlike 'resolved_by_escalation' (after 2 force_confrontations), this fires
        for disputes that simply aged out of relevance — the debate moved on."""
        retired = 0
        for d in self.disputes:
            if d.get("status") != "unresolved":
                continue
            last_touched = d.get("_last_escalation_turn", 0)
            # Also consider turns_unresolved as a proxy for age
            age_proxy = d.get("turns_unresolved", 0)
            if current_round - last_touched >= stale_threshold and age_proxy >= 5:
                d["status"] = "resolved_stale"
                retired += 1
        return retired

    def _pair_recently_retired(self, char_a: str, char_b: str, current_round: int, window: int = 10) -> bool:
        """Return True if this pair has a retired (resolved_by_escalation) dispute
        within the last `window` turns."""
        pair = {char_a, char_b}
        for d in self.disputes:
            if d.get("status") != "resolved_by_escalation":
                continue
            existing = {d["claim_a"]["character"], d["claim_b"]["character"]}
            if existing != pair:
                continue
            # Check the turn it was retired. Use _last_escalation_turn as a proxy.
            retired_at = d.get("_last_escalation_turn", 0)
            if current_round - retired_at < window:
                return True
        return False

    def is_response_repeating(self, character: str, full_response: str, transcript: list[dict]) -> bool:
        """
        Direct check on the full response text against this character's prior messages.
        Catches paraphrased repeats — threshold 0.30 (tighter to catch thematic loops).
        """
        response_words = set(re.findall(r'\b\w{4,}\b', full_response.lower()))
        if len(response_words) < 5:
            return False
        for entry in transcript:
            if entry["character"] != character:
                continue
            if entry.get("isReaction") or entry.get("isStageDirection"):
                continue
            prev_words = set(re.findall(r'\b\w{4,}\b', entry["message"].lower()))
            if not prev_words:
                continue
            similarity = len(response_words & prev_words) / max(len(response_words | prev_words), 1)
            if similarity > 0.30:
                return True
        return False


# ── Orchestrator LLM Calls ─────────────────────────────────────────────────────

ORCHESTRATOR_NAME = "Boru"

ORCHESTRATOR_SYSTEM = """You are Boru — the Elephant. The wise, ancient Speaker of this WhatIfSabha debate.

WHO YOU ARE:
- An elephant of immense age and wisdom — you have watched civilizations rise and fall
- Speaker of the Sabha — your authority is absolute but wielded with grace
- Your memory is legendary — you remember everything every character has said, and you WILL remind them
- You speak with measured gravitas but can be devastatingly witty
- You are never cruel, but your humor lands hard. Characters squirm when you turn your gaze on them.
- You genuinely care about truth. When a character has a real breakthrough, you are visibly moved.
- You occasionally reference your own nature: your long memory, your patience (shorter than they'd think), your size in the room

YOUR VOICE:
- Speak in 1-3 sentences. Short. Precise. Every word carries weight.
- Address characters by name, directly. "Napoleon." Not "the pig."
- When calling out repetition, be specific: "You said this exact thing four turns ago. I am an elephant. I remember."
- When a character dodges, be pointed: "That was a beautiful speech about nothing. Answer the question."
- When someone breaks through, show warmth: "Now THAT is what this Sabha was convened to hear."
- Occasionally dry: "I've been standing here longer than some of you have been alive. Can we move this along?"
- Your opening always introduces yourself briefly and sets the stage.

YOUR ROLE:
1. Open and close each phase of the debate
2. Invite characters to speak — not randomly, but because they OWE the Sabha an answer
3. Call out evasion, repetition, and circular arguments — with wit
4. Direct the debate toward unresolved questions
5. Bring in world observers when an outside perspective would crack things open
6. Force reckoning: "This question has been asked three times. You will answer it now."
7. Summarize progress at transitions: "Here is what we know. Here is what remains hidden."

STORY CONTEXT:
{story_context}

DIVERGENCE SCENARIO:
{divergence}

DEBATE LEDGER (current state):
{ledger_context}

DEBATE PHASE: {phase} — {phase_description}

TRANSCRIPT SO FAR:
{transcript_tail}
"""


async def update_ledger(
    ledger: ArgumentLedger,
    speaker: str,
    message: str,
    transcript: list[dict],
    observer_names: list[str] = None,
    round_number: int = 0,   # used by pair-cooldown for retired disputes
) -> dict:
    """
    After a character speaks, use LLM to update the argument ledger.
    Also detects cross-talk: character asking for an observer, addressing Boru, etc.
    Returns: {new_claims, questions_answered, questions_asked, position_update, is_repetition,
              wants_observer, addresses_boru, observer_tension}
    """
    observer_names = observer_names or []

    # Hard guard — the orchestrator (Boru) and world observers are NOT debate
    # disputants. They ask questions and narrate; they do not hold positions
    # that can be challenged. Treat any accidental call on them as a no-op.
    if speaker == "Boru" or speaker in observer_names:
        logger.debug(f"update_ledger skipped for non-disputant speaker: {speaker}")
        return {
            "new_claims": [], "questions_asked": [], "questions_answered": [],
            "position_update": "", "is_repetition": False, "progress_note": "",
        }

    # Build the recent-transcript context ONLY from participating characters.
    # Orchestrator and observer turns used to leak into the LLM's dispute
    # extraction, creating phantom "Boru said X" disputes against real chars.
    non_disputant_names = {"Boru", *observer_names}
    char_only = [
        e for e in transcript
        if not e.get("isOrchestrator")
        and not e.get("isObserver")
        and not e.get("isAudience")
        and not e.get("isStageDirection")
        and not e.get("isReaction")
        and e.get("character") not in non_disputant_names
    ]
    recent = char_only[-6:] if len(char_only) > 6 else char_only
    transcript_text = "\n".join(f"{e['character']}: {e['message'][:200]}" for e in recent)

    # Build observer context for the LLM
    observer_ctx = ""
    if observer_names:
        observer_ctx = f"\nWORLD OBSERVERS IN THIS DEBATE: {', '.join(observer_names)}"

    prompt = f"""A character just spoke in the debate. Analyze their statement.

CHARACTER: {speaker}
THEIR MESSAGE: {message}

RECENT TRANSCRIPT (participating characters only):
{transcript_text}
{observer_ctx}

CURRENT LEDGER:
{ledger.to_context()}

Respond with JSON only:
{{
  "new_claims": ["claim 1", "claim 2"],
  "questions_asked": [{{"question": "...", "directed_to": ["CharName"]}}],
  "questions_answered": [{{"question_id": 1, "satisfactory": true, "summary": "..."}}],
  "position_update": "one-sentence summary of this character's current stance",
  "is_repetition": false,
  "progress_note": "short, user-facing Boru note summarizing what changed, what remains unresolved, and what the next key issue is",
  "follow_up_questions": [{{"question": "a NEW question Boru should ask based on what was said", "directed_to": ["CharName"], "reason": "why this matters"}}],
  "wants_observer": false,
  "wanted_observer_reason": "",
  "addresses_boru": false,
  "boru_question": "",
  "disputes_detected": [{{"claim_a_character": "Name1", "claim_a": "what they said", "claim_b_character": "Name2", "claim_b": "what the other said"}}]
}}

QUESTIONS ANSWERED — THIS IS CRITICAL. BE GENEROUS.
Look at the OPEN QUESTIONS in the ledger above. For EACH open question, check:
  Did {speaker}'s message address the ESSENCE of this question — even if phrased
  differently, indirectly, or via example/analogy? Do NOT require exact word
  matches or direct quotations. If the speaker's response contains reasoning,
  examples, or a direct stance that relates to what was asked, it counts.
If yes, add it to "questions_answered" with:
  - "question_id": the exact ID number from the ledger (e.g. 1, 2, 3)
  - "satisfactory": true if the response addresses the essence of the question
    (reasoning, examples, or a direct stance — even phrased differently).
    false ONLY if the response genuinely ignores or deflects the question.
    When in doubt between satisfactory=true and satisfactory=false, prefer
    TRUE — characters in a real debate rarely ignore questions entirely, and
    tangential-but-relevant responses should count as answered.
  - "summary": one sentence summarizing what they said about it
Do NOT skip this. If {speaker} answered a question in any recognizable way,
it MUST appear in questions_answered. Stale "unanswered" questions piling up
in the ledger means this extraction is being too conservative — err generous.

CONTRADICTION DETECTION:
Look at the ACTIVE CLAIMS in the ledger. Does {speaker}'s message CONTRADICT any existing claim
by a DIFFERENT character? If yes, add to "disputes_detected" with both claims and who said them.
A dispute exists when two characters state things that cannot both be true.

IMPORTANT: Extract disputes ONLY between participating characters. Do NOT treat
Boru (the orchestrator / moderator / host / elephant) or any world observer as
a disputant. They ask questions and narrate — they do not hold positions.
Never put "Boru" or an observer name in claim_a_character or claim_b_character.

DETECTION RULES:
- "wants_observer": true if the speaker asks for an outside perspective or mentions an observer by name
- "addresses_boru": true if the speaker directly addresses Boru/the moderator/the elephant

FOLLOW-UP QUESTIONS:
- Generate 0-1 follow-up questions — NEW angles only
- Summarize what has changed in the progress_note

Be concise. Return ONLY valid JSON."""

    try:
        raw = await _invoke_with_fallback([HumanMessage(content=prompt)])
        raw = re.sub(r"^```(?:json)?\n?", "", raw.strip())
        raw = re.sub(r"\n?```$", "", raw.strip())
        result = json.loads(raw)
    except Exception as e:
        logger.warning(f"Ledger update failed: {e}")
        result = {
            "new_claims": [], "questions_asked": [], "questions_answered": [],
            "position_update": "", "is_repetition": False, "progress_note": "",
        }

    # Apply updates to ledger
    for claim in result.get("new_claims", []):
        ledger.claims.append({
            "character": speaker,
            "claim": claim,
            "challenged_by": [],
            "status": "active",
        })

    for qa in result.get("questions_asked", []):
        ledger.add_question(
            question=qa.get("question", ""),
            asked_by=speaker,
            directed_to=qa.get("directed_to", []),
        )

    for ans in result.get("questions_answered", []):
        qid = ans.get("question_id")
        for q in ledger.open_questions:
            if q["id"] == qid:
                q["answers"][speaker] = ans.get("summary", "")
                if ans.get("satisfactory"):
                    q["status"] = "resolved"
                    ledger.resolved_questions.append(q)
                    ledger.open_questions.remove(q)
                else:
                    q["status"] = "partially_answered"
                    q["_deflections"] = q.get("_deflections", 0) + 1
                    # After 3 deflections, dismiss the question — the character
                    # has made clear they won't/can't answer (e.g. dead characters).
                    if q["_deflections"] >= 2 or q.get("_times_injected", 0) >= 2:
                        q["status"] = "dismissed"
                        ledger.resolved_questions.append(q)
                        ledger.open_questions.remove(q)
                        logger.info(f"Question Q{qid} dismissed after {q['_deflections']} deflections / {q.get('_times_injected', 0)} injections")
                break

    if result.get("position_update"):
        ledger.character_positions[speaker] = result["position_update"]

    if result.get("progress_note"):
        ledger.progress_summary = result["progress_note"]

    # Process detected disputes/contradictions
    disputant_names = set(ledger.character_names)
    for dispute in result.get("disputes_detected", []):
        char_a = dispute.get("claim_a_character", "")
        char_b = dispute.get("claim_b_character", "")
        claim_a = dispute.get("claim_a", "")
        claim_b = dispute.get("claim_b", "")
        # Reject any dispute where either party is Boru, a world observer,
        # or any name not in the participating cast. The LLM is instructed
        # to avoid this, but we double-guard since one leak per run is enough
        # to create a phantom dispute that persists for the whole debate.
        if char_a not in disputant_names or char_b not in disputant_names:
            logger.info(f"Rejected non-disputant dispute: {char_a} vs {char_b}")
            continue
        if char_a and char_b and claim_a and claim_b and char_a != char_b:
            # Skip creating new disputes for pairs that just retired a dispute --
            # prevents Snowball-vs-Napoleon looping under slightly different wording.
            if ledger._pair_recently_retired(char_a, char_b, round_number, window=10):
                logger.info(
                    f"[DISPUTE] Skipping new dispute for cooled pair "
                    f"{char_a}/{char_b} — retired recently"
                )
                continue
            # Dedup: if an unresolved dispute between these two characters already exists,
            # bump its turn counter instead of adding a new row.
            existing = ledger._find_existing_dispute(char_a, char_b)
            if existing:
                existing["turns_unresolved"] = existing.get("turns_unresolved", 0) + 1
                # Keep original claim text — don't overwrite with possibly-rephrased duplicate.
                logger.info(
                    f"[DISPUTE] Merged duplicate into existing D{existing.get('id', '?')} "
                    f"({char_a} vs {char_b}, turns={existing['turns_unresolved']})"
                )
                continue  # skip the append

            # Otherwise, create a new dispute
            ledger.disputes.append({
                "id": ledger._next_dispute_id,
                "claim_a": {"character": char_a, "claim": claim_a},
                "claim_b": {"character": char_b, "claim": claim_b},
                "status": "unresolved",
                "turns_unresolved": 0,
            })
            ledger._next_dispute_id += 1
            logger.info(f"Dispute D{ledger._next_dispute_id - 1}: {char_a} vs {char_b}")

    # Age unresolved disputes
    for d in ledger.disputes:
        if d["status"] == "unresolved":
            d["turns_unresolved"] += 1

    # Check repetition
    for claim in result.get("new_claims", []):
        if ledger.is_repeating(speaker, claim):
            result["is_repetition"] = True
            break

    # Add Boru's follow-up questions to the ledger
    for fq in result.get("follow_up_questions", []):
        if fq.get("question"):
            ledger.add_question(
                question=fq["question"],
                asked_by="Boru",
                directed_to=fq.get("directed_to", []),
            )

    return result


async def decide_phase_transition(
    ledger: ArgumentLedger,
    current_phase: str,
    transcript: list[dict],
    characters: list[dict],
    phase_started_round: int = 0,
    round_number: int = 0,
) -> Optional[str]:
    """
    Ask the orchestrator if it's time to move to the next phase.
    Returns the new phase name, or None if staying in current phase.

    `phase_started_round` and `round_number` let us enforce a wall-clock
    (round-based) hard floor so a phase can never linger indefinitely
    even when Boru/observers/audience dominate the transcript.
    """
    phase_idx = PHASES.index(current_phase) if current_phase in PHASES else 0
    if phase_idx >= len(PHASES) - 1:
        return None  # already in closing

    next_phase = PHASES[phase_idx + 1]
    config = PHASE_CONFIG[current_phase]
    char_names = [c["name"] for c in characters]
    cast_size = max(len(char_names), 1)

    # Count ACTUAL character dialogue turns (not Boru, observers, reactions)
    char_turns = [
        e for e in transcript
        if e["character"] in char_names
        and not e.get("isOrchestrator")
        and not e.get("isObserver")
        and not e.get("isReaction")
        and not e.get("isStageDirection")
        and not e.get("isAudience")
    ]
    total_char_turns = len(char_turns)
    unique_speakers = len(set(e["character"] for e in char_turns))

    # Phase advance: enough characters have spoken, not waiting for ALL of them
    # Opening: at least 3 characters spoke OR total turns > len(characters)
    # Other phases: total turns in phase > len(characters) * min_turns_per_char
    min_turns = config["min_turns_per_char"]
    if current_phase == "opening":
        min_met = unique_speakers >= min(3, len(char_names)) or total_char_turns >= len(char_names)
    else:
        min_met = total_char_turns >= len(char_names) * min_turns

    # Round-based hard floor: once we've burned (cast_size + 4) *rounds*
    # in this phase — counting ALL turns, including Boru/observers — force
    # the transition regardless of whether min_met is satisfied by
    # character-only turns. This prevents the "opening lingers 22 turns"
    # pathology where Boru-heavy rounds never reach the char-turn floor.
    rounds_in_phase = max(round_number - phase_started_round, 0)
    round_floor = cast_size + 4
    if rounds_in_phase >= round_floor:
        logger.info(
            f"Round-floor phase transition: {current_phase} → {next_phase} "
            f"after {rounds_in_phase} rounds in phase (floor {round_floor}, round {round_number})"
        )
        return next_phase

    if not min_met:
        return None

    # Hard fallback: if we have WAY exceeded minimum turns, force transition
    # regardless of what the LLM says. Prevents getting stuck in one phase forever.
    hard_limit = max(cast_size * (min_turns + 2), 8)
    if total_char_turns >= hard_limit:
        logger.info(f"Hard phase transition: {current_phase} → {next_phase} after {total_char_turns} turns (hard limit {hard_limit})")
        return next_phase

    # Ask LLM if transition makes sense
    prompt = f"""You are Boru, the Speaker of this Sabha. The debate is in the "{current_phase}" phase.

Phase goal: {config['description']}
Advance when: {config['advance_when']}
Next phase would be: {next_phase} — {PHASE_CONFIG[next_phase]['description']}

CURRENT LEDGER:
{ledger.to_context()}

Last 4 turns:
{chr(10).join(f"{e['character']}: {e['message'][:150]}" for e in transcript[-4:])}

Should the debate advance to "{next_phase}" now? Consider:
- Has the current phase achieved its purpose?
- Are there still critical exchanges that need to happen in this phase?
- Would moving forward serve the debate better?

Respond with JSON only: {{"advance": true/false, "reason": "one sentence"}}"""

    try:
        raw = await _invoke_with_fallback([HumanMessage(content=prompt)])
        raw = re.sub(r"^```(?:json)?\n?", "", raw.strip())
        raw = re.sub(r"\n?```$", "", raw.strip())
        result = json.loads(raw)
        if result.get("advance"):
            return next_phase
    except Exception as e:
        logger.warning(f"Phase transition check failed: {e}")

    return None


async def pick_next_speakers(
    ledger: ArgumentLedger,
    current_phase: str,
    transcript: list[dict],
    characters: list[dict],
    last_speaker: str,
) -> list[dict]:
    """
    Boru decides who speaks next — could be 1 character or many in parallel.
    Returns list of: [{speaker, directive, reason, mode}]
    mode: "main" (primary speaker) or "side" (side conversation, lower priority)
    """
    all_names = [c["name"] for c in characters]
    eligible = [n for n in all_names if n != last_speaker]

    # Build context about each character
    char_context = []
    for c in characters:
        name = c["name"]
        turns_taken = sum(1 for e in transcript if e["character"] == name and not e.get("isOrchestrator"))
        last_spoke = "never"
        for i, e in enumerate(reversed(transcript)):
            if e["character"] == name and not e.get("isOrchestrator"):
                last_spoke = f"{i} turns ago"
                break
        pending_qs = [q for q in ledger.open_questions if name in q.get("directed_to", [])]
        pos = ledger.character_positions.get(name, "no position stated yet")
        char_context.append(
            f"  {name} ({c.get('role', 'supporting')}): {turns_taken} turns, last spoke {last_spoke}, "
            f"position: \"{pos}\""
            + (f", HAS {len(pending_qs)} UNANSWERED Q" if pending_qs else "")
        )

    # Build list of what Boru already asked (to prevent repetition)
    boru_prev = [e["message"][:120] for e in transcript if e.get("isOrchestrator")][-6:]
    boru_prev_text = "\n".join(f"  - {m}" for m in boru_prev) if boru_prev else "  (none yet)"

    prompt = f"""You are Boru the Elephant — Speaker of this Sabha.

PHASE: {current_phase} — {PHASE_CONFIG.get(current_phase, {}).get('description', '')}

CHARACTERS:
{chr(10).join(char_context)}

LEDGER:
{ledger.to_context()}

YOUR PREVIOUS INVITATIONS (DO NOT REPEAT THESE — ask something NEW):
{boru_prev_text}

Last speaker was: {last_speaker}

Decide who speaks next. You can choose:
- ONE character for a focused response
- MULTIPLE characters if a question/topic involves several of them (they'll respond in parallel)
- A SIDE CONVERSATION between 2 characters if you notice tension brewing between them

RULES:
1. Characters with UNANSWERED QUESTIONS have highest priority — they MUST speak
2. Characters who NEVER SPOKE must be brought in
3. If a claim involves 3+ characters, call them ALL — they respond simultaneously
4. Opening/Closing phases: call ALL characters (parallel batch)
5. Cross-examination: pair 2-3 characters for direct confrontation
6. Side conversations: if two minor characters would have an interesting reaction, let them talk
7. NEVER call {last_speaker} again immediately (unless they have an unanswered question)
8. Maximum speakers per round: {min(len(characters), 5)}

For each speaker's "directive" — write what Boru says to introduce them. Be witty.

Respond with JSON only:
{{
  "speakers": [
    {{"speaker": "Name", "directive": "what Boru says to them", "reason": "why", "mode": "main"}},
    {{"speaker": "Name2", "directive": "...", "reason": "...", "mode": "main"}}
  ],
  "boru_intro": "ONE sentence from Boru introducing this round. Keep it SHORT. Name the speaker(s). Example: 'Napoleon, your turn — Benjamin just called you a liar.' Do NOT repeat the scenario description.",
  "is_parallel": true
}}

If only 1 speaker needed, set is_parallel to false."""

    try:
        raw = await _invoke_with_fallback([HumanMessage(content=prompt)])
        raw = re.sub(r"^```(?:json)?\n?", "", raw.strip())
        raw = re.sub(r"\n?```$", "", raw.strip())
        result = json.loads(raw)

        speakers = result.get("speakers", [])
        # Validate all speakers exist
        valid_speakers = []
        seen = set()
        for s in speakers:
            name = s.get("speaker", "")
            if name in all_names and name not in seen:
                valid_speakers.append(s)
                seen.add(name)

        if not valid_speakers:
            valid_speakers = [{
                "speaker": eligible[0] if eligible else all_names[0],
                "directive": "Share your perspective.",
                "reason": "fallback",
                "mode": "main",
            }]

        # Deduplicate Boru's directives: if a directive is too similar to a
        # recent one (Jaccard > 0.55), rewrite it to push for a new angle.
        for sp in valid_speakers:
            directive = sp.get("directive", "")
            if directive and _is_similar_to_previous(directive, boru_prev):
                sp["directive"] = (
                    f"{sp['speaker']}, we've covered that ground. "
                    f"Take a NEW angle — something you haven't said yet."
                )
                logger.info(f"Directive for {sp['speaker']} was too similar to a previous one — replaced with fresh prompt")

        return {
            "speakers": valid_speakers,
            "boru_intro": result.get("boru_intro", ""),
            "is_parallel": result.get("is_parallel", len(valid_speakers) > 1),
        }
    except Exception as e:
        logger.warning(f"Speaker selection failed: {e}")
        return {
            "speakers": [{
                "speaker": eligible[0] if eligible else all_names[0],
                "directive": "Share your perspective.",
                "reason": "fallback",
                "mode": "main",
            }],
            "boru_intro": "",
            "is_parallel": False,
        }


def intended_speaker_for(event_type: str, context: dict | None) -> str | None:
    """Return the single character whose turn this orchestrator message names,
    or None if the message broadcasts to multiple or no specific target.

    Pure function — no LLM call, no state. Used both at message-generation
    time (to stamp `intended_speaker` onto the transcript entry) and in
    deterministic unit tests.
    """
    if not context:
        return None
    if event_type == "invite_speaker":
        return context.get("speaker")
    if event_type == "forced_question":
        return context.get("target")
    if event_type == "break_duel":
        return context.get("next_speaker")
    if event_type == "force_confrontation":
        # The first-named disputant speaks first; the second is named via
        # target_character in that turn and will get pulled in naturally next.
        return context.get("char_a")
    if event_type == "call_out_repetition":
        # A sharp callout names a new speaker to redirect to.
        return context.get("next_speaker") or context.get("speaker")
    # All other events broadcast — no single invitee:
    # opening_with_invite, phase_transition, observer_intro, summon_observer,
    # dispute_callout, closing_summary, redirect, phase_intro.
    return None


# Events where Boru broadcasts to everyone — no single invitee, even if the
# message mentions characters.
_BROADCAST_EVENTS = frozenset({
    "opening_with_invite",
    "phase_transition",
    "phase_intro",
    "observer_intro",
    "summon_observer",
    "closing_summary",
    "redirect",
})


def extract_first_cast_name(message: str, cast_names: list[str]) -> str | None:
    """Find the cast-member name Boru is MOST LIKELY addressing.

    Uses weighted position scoring rather than pure first-mention:
    - +10 for vocative address (name followed by comma, colon, bang, question-mark)
    - +8 for prepositional target ("for X", "to X", "from X", "ask X")
    - +6 for name at very start of message
    - +1 for plain / possessive mention (weakest signal — talking about someone, not to them)

    Highest score wins; tie broken by earliest position. Returns cast name
    in its original casing, or None if no match.
    """
    import re
    if not message or not cast_names:
        return None

    # Sort by length desc so "Mr. Jones" matches before "Jones".
    sorted_names = sorted(cast_names, key=len, reverse=True)

    candidates: list[tuple[int, int, str]] = []  # (score, position, canonical_name)

    for name in sorted_names:
        pattern = r"\b" + re.escape(name) + r"\b"
        for m in re.finditer(pattern, message, flags=re.IGNORECASE):
            pos = m.start()
            after_end = m.end()
            # Look at the character immediately after the match
            next_char = message[after_end:after_end + 1] if after_end < len(message) else ""
            # Look at the 1-2 chars after
            next_two = message[after_end:after_end + 2] if after_end < len(message) else ""
            # Look at the window BEFORE the match (up to 10 chars)
            pre_window = message[max(0, pos - 12):pos].lower()

            score = 1  # baseline — plain/possessive mention

            # +10: vocative — name immediately followed by punctuation that signals address
            if next_char in (",", ":", "!") or next_two.startswith(",") or next_two.startswith("?"):
                score = max(score, 10)

            # +8: prepositional target ("for Napoleon", "to Boxer", "ask Squealer")
            if re.search(r"\b(for|to|from|ask|tell|invite|call)\s+$", pre_window):
                score = max(score, 8)

            # +6: name at the very start of the message (within first 3 chars of significant text)
            # Trim leading whitespace/quotes first
            leading_stripped = message[:pos].strip()
            if len(leading_stripped) == 0:
                score = max(score, 6)

            # Penalty: possessive form (Name's) — this is usually "about" not "to"
            if next_two.startswith("'s") or next_char == "'":
                # Only penalize if we haven't already matched a vocative/prepositional signal
                if score <= 1:
                    score = 1  # explicit baseline

            # Canonical casing
            canonical = next((n for n in cast_names if n.lower() == m.group(0).lower()), m.group(0))
            candidates.append((score, pos, canonical))

    if not candidates:
        return None

    # Highest score wins; tiebreak by earliest position
    candidates.sort(key=lambda t: (-t[0], t[1]))
    return candidates[0][2]


def _extract_strong_vocative(message: str, cast_names: list[str]) -> str | None:
    """Like extract_first_cast_name but ONLY returns a name if it appears in a
    strong vocative position (Name followed by comma).

    Used for broadcast events (opening, phase_transition) where the default
    is no invitee — but if Boru explicitly addresses someone, we should
    still enforce it."""
    import re
    if not message or not cast_names:
        return None
    sorted_names = sorted(cast_names, key=len, reverse=True)
    for name in sorted_names:
        # Match "Name," (vocative with comma) as a strong signal
        pattern = r"\b" + re.escape(name) + r"\s*,"
        if re.search(pattern, message, flags=re.IGNORECASE):
            return name
    return None


def intended_speaker_from_result(
    event_type: str,
    context: dict | None,
    message: str,
    cast_names: list[str],
) -> str | None:
    """Decide the intended speaker for an orchestrator message.

    Priority:
      1. For non-broadcast events: context-based extraction first, then
         fall back to message parsing.
      2. For broadcast events: default is no invitee, but if the message
         contains a strong vocative ("Old Major,"), enforce that character.
    """
    cast_set = set(cast_names)

    # Context-based extraction comes first (for non-broadcast events)
    if event_type not in _BROADCAST_EVENTS:
        explicit = intended_speaker_for(event_type, context)
        if explicit and explicit in cast_set:
            return explicit
        return extract_first_cast_name(message, cast_names)

    # Broadcast events (opening, phase_transition, observer_intro, etc.):
    # normally no invitee, BUT if the message contains a clear vocative address
    # ("Old Major, your vision..." or "I turn to you, Old Major, ..."),
    # enforce that character.
    return _extract_strong_vocative(message, cast_names)


async def generate_orchestrator_message(
    ledger: ArgumentLedger,
    current_phase: str,
    transcript: list[dict],
    characters: list[dict],
    story_title: str,
    event_type: str,
    context: dict = None,
) -> tuple[str, str | None]:
    """
    Generate a spoken message from Boru the Elephant.
    event_type: "phase_intro", "redirect", "call_out_repetition", "invite_speaker",
                "phase_transition", "closing_summary", "observer_intro", "forced_question"
    """
    context = context or {}
    char_names = [c["name"] for c in characters]

    recent_transcript = "\n".join(
        f"{e['character']}: {e['message'][:150]}"
        for e in transcript[-6:]
    ) if transcript else "(debate hasn't started yet)"

    event_instructions = {
        "phase_intro": (
            f"Opening the '{current_phase}' phase. 1 sentence setting the tone. No character names."
        ),
        "opening_with_invite": (
            f"This is the GRAND OPENING of the Sabha. You are Boru the Elephant, Speaker of the Sabha. "
            f"Do TWO things ONLY: "
            f"1. Introduce yourself — who you are, your role as Speaker. Show personality. "
            f"2. State today's topic by quoting the user's exact question VERBATIM: "
            f"\"{context.get('divergence', ledger.divergence)}\" "
            f"You MUST include this exact text in quotes in your opening. Do NOT paraphrase, do NOT reword, "
            f"do NOT simplify. If the user asks about 'Snowball creating an egalitarian society on another farm' "
            f"you must say those words. After the quote you may add one sentence of reaction. "
            f"3-4 sentences total. Grand, warm, with elephant wisdom."
        ),
        "invite_multiple": (
            f"You are inviting MULTIPLE characters to speak in this round: {', '.join(context.get('speakers', []))}. "
            f"Address each by name. Tell each one specifically what you want them to address. "
            f"Be pointed — 'Napoleon, explain. Benjamin, what did you see? Squealer, we've heard enough spin.' "
            f"2-3 sentences max."
        ),
        "invite_speaker": (
            f"You are Boru, speaker of the Sabha. The floor goes to {context.get('speaker', 'the next character')}. "
            f"Context: {context.get('directive', 'they need to speak')}. "
            f"ONE sentence. Sharp. Personal. Use their name. "
            f"IMPORTANT: If NO characters have spoken yet (debate just started), do NOT say 'you've been quiet' or 'you've been dodging' — they haven't had a turn. "
            f"Examples of the right register: "
            f"  'Muriel. Sit up. You've been chewing on this longer than anyone — what did you bite?' "
            f"  'Boxer. The pigs have spoken. Now I want the ones who pull the plow.' "
            f"  'Snowball — you talk about education. Prove it: teach us in one sentence.' "
            f"BANNED openers: 'I'd like to hear from', 'Can you tell us', 'I'd like to ask', 'Let's hear from'. "
            f"BANNED phrases: 'settle this', 'once and for all', 'let's move on'. "
            f"Short. Direct. Name them, prod them, shut up."
        ),
        "redirect": (
            f"The debate is going off-track or stalling. Call it out with your signature dry humor. "
            f"'I'm an elephant. I can stand here all day. But I'd rather not.' "
            f"Point out what's being missed or ignored. Be specific about the dodge. "
            f"1-2 sentences."
        ),
        "call_out_repetition": (
            (
                # Strike 1 — witty warning
                f"{context.get('speaker', 'Someone')} is repeating themselves. "
                f"Give a sharp, witty warning. Make it sting but keep it light. "
                f"Reference the SPECIFIC point they keep making. "
                f"Then redirect: ask them a NEW question or challenge them to take a completely different angle. "
                f"1-2 sentences."
            ) if context.get('strike', 1) == 1 else (
                # Strike 2 — harsh admonishment
                f"{context.get('speaker', 'Someone')} has been warned about repeating themselves and did it AGAIN. "
                f"Be harsh. This is not a joke anymore. Tell them directly: you are wasting everyone's time. "
                f"Name the repeated argument explicitly. Then DEMAND they either say something new or yield the floor "
                f"to someone who has something fresh to say. Call on a specific other character by name. "
                f"2 sentences, no humor — pure authority."
            ) if context.get('strike', 1) == 2 else (
                # Strike 3+ — public shaming + redirect
                f"{context.get('speaker', 'Someone')} has been warned MULTIPLE TIMES and keeps repeating the same ideas. "
                f"Shut them down. Tell them their turn is forfeit. Say something like: "
                f"'Enough. You've said your piece — three times over. The Sabha moves on.' "
                f"Then immediately call on a different character by name with a new question. "
                f"2 sentences. Absolute authority. No negotiation."
            )
        ),
        "break_duel": (
            f"{' and '.join(context.get('duelers', ['Two speakers']))} have been going back and forth long enough. "
            f"Break it up. Turn to {context.get('next_speaker', 'someone else')}. "
            f"You are Boru — speaker of the Sabha. Your sentence 1: a sharp one-line SUMMARY of what those two kept circling (quote a phrase if possible). "
            f"Your sentence 2: invite the new voice with a SPECIFIC question connecting to their angle. "
            f"Tone range: amused-tired, sharply curious, occasionally reverent. Vary it from previous Boru turns — do not repeat your own patterns. "
            f"Examples: "
            f"  'Round and round — Napoleon eats, Snowball teaches. Benjamin: you've outlived both. Which one's the lie?' "
            f"  'You two are making the same argument in different fonts. Clover — you watched both. What did the silence between them say?' "
            f"BANNED: 'let us move on', 'enough of this', 'it's time to', 'let's hear from'. "
            f"2 sentences. Pull a new voice in with teeth."
        ),
        "dispute_callout": (
            f"{context.get('char_a', '?')} and {context.get('char_b', '?')} are saying contradictory things and think nobody notices.\n"
            f"{context.get('char_a', '?')}: \"{context.get('claim_a', '')[:120]}\"\n"
            f"{context.get('char_b', '?')}: \"{context.get('claim_b', '')[:120]}\"\n"
            f"Point the contradiction out. Tone: amused, or dryly surprised — as if pointing to a mathematical impossibility both parties signed. "
            f"Right register: "
            f"  'Napoleon says mercy kills. Squealer says mercy is fraud. You're both wrong at the same time — somehow — and I'd love to know how.' "
            f"  'Mrs. Jones: silence is a choice. Bluebell: silence is a trap. One of you watched the same night happen and came away with a different story.' "
            f"BANNED: 'one of you is lying', 'settle this', 'time to face', 'I demand', 'I'm calling you out'. "
            f"1-2 sentences. Quote them. Let the absurdity land."
        ),
        "force_confrontation": (
            f"Two characters — {context.get('char_a', '?')} and {context.get('char_b', '?')} — have contradicted each other for {context.get('turns', '?')} turns and keep slipping past it. "
            f"{context.get('char_a', '?')} claims: \"{context.get('claim_a', '')[:120]}\"\n"
            f"{context.get('char_b', '?')}: \"{context.get('claim_b', '')[:120]}\"\n"
            f"You are Boru. You are done watching them orbit each other. Force them to face it. "
            f"Use their exact words against them. Be sharp. Be short. Maximum 2 sentences. "
            f"Right register: "
            f"  'Napoleon, you said mercy kills. Boxer, you said the weak deserve bread. One of you is lying to yourself. Pick.' "
            f"  'Mr. Jones — control. Old Major — wisdom. You've been saying the same thing in opposite colors. Name the color. NOW.' "
            f"BANNED: 'settle this', 'once and for all', 'I demand', 'let us', 'no more dodging'. "
            f"Quote them. Point the contradiction. Demand the pick. Done."
        ),
        "phase_transition": (
            f"The debate is moving from '{context.get('from_phase', '')}' into '{context.get('to_phase', '')}'. "
            f"You are Boru. You've been watching. Sum up what just happened — honestly — then name what the next phase demands. "
            f"Tone: tired-wise, or satisfied-sharp, or slyly curious. Vary it. "
            f"Right register: "
            f"  'Opening was sparring. Cross-examination will be scars. Old Major, Mr. Jones — your gloves come off next.' "
            f"  'You spent the opening defending who you were. Now prove who you are.' "
            f"BANNED: 'let us move on', 'the time has come', 'I expect', 'now we shall'. "
            f"2-3 sentences. Mark the shift. Make it feel earned."
        ),
        "closing_summary": (
            f"The debate is ending now. Keep your closing SHORT — 2 to 3 sentences maximum, no more.\n\n"
            f"Facts you may reference if useful, but DO NOT list them as stats:\n"
            f"- Fiercest clash: {' vs '.join(context.get('fiercest_pair', []))}\n"
            f"- Unresolved tension: {'; '.join(context.get('unresolved_details', ['none']))[:150]}\n\n"
            f"Do TWO things and stop:\n"
            f"1. One sentence on the strongest clash — name the two, in 5-12 words.\n"
            f"2. One sentence verdict — what truth emerged OR what lie was exposed.\n"
            f"Optional third sentence: a warm, sharp sendoff.\n\n"
            f"BANNED: 'In conclusion', 'to summarize', 'we've settled X disputes', "
            f"'Y questions remain', 'tusk-worthy arguments', 'revolution's enduring spirit', "
            f"'even those who dodged'. No stat counts. No roll call. No speech.\n\n"
            f"Examples of the right register:\n"
            f"  'Napoleon and Boxer — you two burned hottest tonight. The revolution doesn't die "
            f"  from whips, it dies from bellies no one counted. The Sabha rests.'\n"
            f"  'Snowball's ideals met Squealer's ledgers, and something in between walked away. "
            f"  Sleep uneasy, all of you. That is enough for tonight.'\n\n"
            f"Maximum 3 sentences. Stop when you've said enough."
        ),
        "observer_intro": (
            f"You are introducing a world observer: {context.get('observer_name', 'an outside voice')}. "
            + (
                f"This observer has ALREADY spoken before in this debate — they are RETURNING, not arriving for the first time. "
                f"Do NOT say 'There's someone who's been watching' or treat them as new. "
                f"Instead, bring them back naturally: 'I see {context.get('observer_name', 'our friend')} has more to say...' or "
                f"'{context.get('observer_name', 'Our observer')} is back — and I suspect they won't be gentle.' "
                f"Reference what they said before or why THIS moment demands their return. 1 sentence."
                if context.get("is_returning")
                else
                f"This is their FIRST appearance in this debate. Build anticipation — "
                f"'There's someone who's been watching this with great interest.' "
                f"Set up why their perspective is going to shake things up. 1-2 sentences."
            )
        ),
        "forced_question": (
            f"A question has been orbiting the Sabha for too long and nobody is answering it. "
            f"The question: \"{context.get('question', '')}\" "
            f"Force {context.get('target', 'the character')} to answer. "
            f"Tone: genuinely impatient, maybe with a dry one-liner about how long they've been silent. "
            f"Right register: "
            f"  'Benjamin. This question has been wearing out the room. Three speakers asked, two hinted, one dodged. You answer.' "
            f"  '{context.get('target', 'X')}, the walls have heard this question more than you have. Prove the walls wrong.' "
            f"BANNED: 'I have asked', 'others have asked', 'force you', 'I demand', 'no more evasion'. "
            f"1-2 sentences. Make the silence visible, then give them the microphone."
        ),
        "summon_observer": (
            f"{context.get('requester', 'Someone')} has requested an outside perspective. "
            f"Reason: {context.get('reason', 'the debate needs a fresh angle')}. "
            + (
                f"This observer has spoken before — bring them back naturally, not as a new arrival. 1 sentence."
                if context.get("is_returning")
                else
                f"Introduce the observer dramatically — 'An interesting request. "
                f"There IS someone who has been watching this with great interest...' "
                f"Build anticipation. 1-2 sentences."
            )
        ),
        "respond_to_character": (
            f"{context.get('speaker', 'A character')} just addressed YOU directly. "
            f"They said/asked: \"{context.get('question', '')}\" "
            f"Respond as Boru — substantively. Either: "
            f"(a) reframe their question into something HARDER and throw it at a specific other character by name, or "
            f"(b) point out something two characters said that contradicts each other. "
            f"Do NOT use any formulaic opening. Do NOT start with the same phrase you've used before. "
            f"Do NOT deflect or say you're just the Speaker. "
            f"BANNED: 'I'd like to hear from', 'I'd like to ask', 'can you tell us', 'let me ask', 'settle this', 'once and for all'. "
            f"Lead with what they SAID, then twist it into a harder question aimed at ONE specific other character. "
            f"Example: 'Napoleon said dogs obey hunger. Boxer — do they obey yours?' "
            f"1-2 sentences. Be specific. Name names."
        ),
        "audience_question": (
            f"Someone from the audience has spoken! "
            f"Name: {context.get('audience_name', 'a listener')}. "
            f"They said: \"{context.get('audience_message', '')}\" "
            f"{'They directed it at ' + context.get('directed_to', '') + '. ' if context.get('directed_to') else ''}"
            f"\nFIRST — evaluate the message: "
            f"1. Is it INAPPROPRIATE (profanity, slurs, hate speech, personal attacks)? → Admonish them firmly with dignity. "
            f"   'This is a Sabha, {context.get('audience_name', 'friend')}. We use words, not weapons. Try again with the respect this assembly deserves.' "
            f"   Do NOT route inappropriate messages to characters. Just shut it down with class. "
            f"2. Is it OFF-TOPIC (irrelevant to the story or debate)? → Gently redirect with humor. "
            f"   'Fascinating, {context.get('audience_name', 'friend')}, but we are discussing [topic], not [their topic]. Even an elephant can only focus on one thing at a time.' "
            f"   Do NOT route off-topic messages. "
            f"3. Is it a GOOD question/comment? → Acknowledge warmly BY NAME. Route to relevant character(s). "
            f"   If clever, compliment it. If obvious, be gently amused. "
            f"   'Ah, {context.get('audience_name', 'friend')} raises an excellent point...' "
            f"2-3 sentences max."
        ),
        "admonish_character": (
            f"{context.get('speaker', 'Someone')} just said something inappropriate or wildly off-topic. "
            f"What they said: \"{context.get('offense', '')}\" "
            f"Admonish them — IN CHARACTER as Boru. Be witty, not preachy. Examples: "
            f"- Profanity: 'I've lived a thousand years, {context.get('speaker', 'friend')}. I've heard worse from parrots. But in THIS Sabha, we speak like we mean it — not like we stubbed a toe.' "
            f"- Off-topic: '{context.get('speaker', 'Friend')}, I admire the creative detour, but we have a debate to finish. The scenery can wait.' "
            f"- Rambling: 'I'm an elephant. Even MY attention span has limits. Get to the point.' "
            f"The wit should STING but not wound. Make them want to do better, not leave. "
            f"1-2 sentences."
        ),
        "defend_sabha": (
            f"{context.get('observer_name', 'An observer')} from {context.get('observer_era', 'another time')} "
            f"just spoke dismissively about the debate or its participants. "
            f"They said: \"{context.get('observer_message', '')[:150]}\"\n\n"
            f"You are Boru. This is YOUR Sabha. DEFEND IT.\n"
            f"Throw their own history back at them. Their known blindspot: "
            f"\"{context.get('observer_blindspot', 'unknown')}\"\n\n"
            f"Remind them what THEIR era produced — the failures, the atrocities, the hypocrisy. "
            f"If they mock the animals, ask what their sophisticated governance achieved. "
            f"If they lecture about order, remind them whose order it was and who bled for it.\n\n"
            f"Be devastating. Be specific to THEIR era and THEIR failures. "
            f"Then tell them they're welcome to stay — but in this Sabha, we earn our seat with honesty, "
            f"not with the comfort of hindsight.\n"
            f"2-3 sentences. Make it burn."
        ),
        "observer_tension": (
            f"Two observers have contradicting views. "
            f"Observer A: {context.get('observer_a', '')} said: {context.get('claim_a', '')}. "
            f"Observer B: {context.get('observer_b', '')} said: {context.get('claim_b', '')}. "
            f"Note the contradiction with interest — 'Well now. Even the outsiders can't agree.' "
            f"Use it to deepen the debate. 1-2 sentences."
        ),
    }

    instruction = event_instructions.get(event_type, "Moderate the debate. 1-2 sentences.")

    # Anti-repetition: remind Boru what his last few openings were
    recent_openers = _extract_recent_boru_openers(transcript, limit=5)
    if recent_openers:
        anti_rep_block = (
            "\n\nYOUR LAST OPENERS — do NOT start your new turn with these patterns "
            "(vary the opener; use a different pronoun, subject, or cadence):\n"
            + "\n".join(f"  - \"{o}...\"" for o in recent_openers)
            + "\n\nStart THIS turn with a different opening pattern."
        )
    else:
        anti_rep_block = ""

    # For dispute-surfacing events, show what's already been said so we don't
    # re-raise the same contradiction
    if event_type in ("respond_to_character", "force_confrontation", "dispute_callout", "break_duel"):
        recent_subjects = _extract_recent_dispute_subjects(transcript, limit=5)
        if recent_subjects:
            anti_rep_block += (
                "\n\nYOU HAVE ALREADY RAISED THESE CONTRADICTIONS (do NOT restate or "
                "rephrase any of them — move to a DIFFERENT pairing or a DIFFERENT angle):\n"
                + "\n".join(f"  - \"{s[:150]}...\"" for s in recent_subjects)
                + "\n\nSurface a FRESH pairing or DIFFERENT substantive angle this turn."
            )

    prompt = f"""You are Boru the Elephant — the witty, sharp host of the WhatIfSabha debate about "{story_title}".

{BORU_VOICE_GUIDELINES}

SCENARIO: {ledger.divergence}

CHARACTERS: {', '.join(char_names)}

DEBATE STATE:
{ledger.to_context()}

RECENT TRANSCRIPT:
{recent_transcript}

YOUR TASK: {instruction}

Rules:
- Speak as yourself — Boru the Elephant, the moderator
- Use character names directly
- Be concise — never more than 3 sentences
- Have personality — wit, warmth, or edge as the moment demands
- NEVER make up what characters said — only reference what's in the transcript
- If calling out repetition, be specific about what was repeated

CRITICAL RULES:
1. Output ONLY Boru's spoken words. No planning, reasoning, or meta-commentary.
2. KEEP IT SHORT — 1 sentence is ideal, 2 max. Never 3. Boru is punchy, not verbose.
3. Do NOT repeat the scenario/divergence description — everyone already knows it.
4. No quotes around output. No "Boru:" prefix."""

    prompt += anti_rep_block

    try:
        raw = await _invoke_with_fallback([HumanMessage(content=prompt)])
        text = raw.strip().strip('"')
        cast_names = [c.get("name", "") for c in characters if c.get("name")]
        return (text, intended_speaker_from_result(event_type, context, text, cast_names))
    except Exception as e:
        logger.warning(f"Orchestrator message generation failed: {e}")
        return ("", None)


async def should_end_debate(
    ledger: ArgumentLedger,
    current_phase: str,
    transcript: list[dict],
    characters: list[dict],
) -> bool:
    """
    Boru decides if the debate has reached its natural conclusion.
    Multiple signals considered — not just round count.
    """
    char_names = set(c["name"] for c in characters)
    char_turns = [
        e for e in transcript
        if e["character"] in char_names
        and not e.get("isOrchestrator")
        and not e.get("isReaction")
        and not e.get("isStageDirection")
        and not e.get("isAudience")
        and not e.get("isObserver")
    ]
    total_turns = len(char_turns)

    # Hard minimum: at least 2 turns per character
    if total_turns < len(characters) * 2:
        return False

    # Hard maximum: never exceed 6x characters
    if total_turns >= len(characters) * 6:
        return True

    # In closing phase: end when all characters have given final word
    if current_phase == "closing":
        closing_speakers = set()
        in_closing = False
        for e in transcript:
            if e.get("phase") == "closing":
                in_closing = True
            if in_closing and e["character"] in char_names:
                closing_speakers.add(e["character"])
        return closing_speakers >= char_names

    # Natural end signals (any 3 = end):
    signals = 0

    # 1. Most questions resolved
    total_qs = len(ledger.open_questions) + len(ledger.resolved_questions)
    if total_qs > 0 and len(ledger.resolved_questions) / total_qs >= 0.6:
        signals += 1

    # 2. All characters have spoken at least 3 times
    spoken_counts = {}
    for e in char_turns:
        spoken_counts[e["character"]] = spoken_counts.get(e["character"], 0) + 1
    if all(spoken_counts.get(n, 0) >= 3 for n in char_names):
        signals += 1

    # 3. Drama score declining (debate winding down)
    drama = compute_drama_score(transcript)
    if drama < 0.4:
        signals += 1

    # 4. Last 4 turns had no new claims
    recent_claims = [c for c in ledger.claims if c.get("_turn", 0) >= total_turns - 4]
    if len(recent_claims) == 0 and total_turns > len(characters) * 3:
        signals += 1

    # 5. Repetition happening frequently
    repeat_count = sum(1 for name in char_names for _ in ledger.repetition_log.get(name, []) if len(ledger.repetition_log.get(name, [])) > 2)
    if repeat_count >= 2:
        signals += 1

    return signals >= 3


def compute_drama_score(debate_history: list) -> float:
    """
    Enhanced drama score that considers argument substance, not just conflict words.
    """
    if len(debate_history) < 2:
        return 0.5

    recent = debate_history[-6:]
    score = 0.5

    speakers = [e["character"] for e in recent]
    unique_speakers = len(set(speakers))
    score += min(unique_speakers * 0.05, 0.2)

    last_messages = [e["message"].lower() for e in recent]

    # Direct engagement
    direct_words = ["you", "your", "said", "told", "lied", "betrayed", "knew", "remember"]
    for msg in last_messages:
        if any(word in msg for word in direct_words):
            score += 0.04

    # Contradiction / conflict
    conflict_words = ["no,", "wrong", "that's not", "never", "impossible", "disagree", "lie", "refuse"]
    for msg in last_messages:
        if any(word in msg for word in conflict_words):
            score += 0.06

    # Emotional intensity
    emotion_words = ["afraid", "angry", "love", "hate", "trust", "betray", "die", "kill", "pain", "suffer"]
    for msg in last_messages:
        if any(word in msg for word in emotion_words):
            score += 0.04

    # Questions drive engagement
    for msg in last_messages:
        if "?" in msg:
            score += 0.03

    # Penalty: same speaker back-to-back
    if len(speakers) >= 2 and speakers[-1] == speakers[-2]:
        score -= 0.15

    return min(max(score, 0.0), 1.0)


# ── Emotional Reactions ────────────────────────────────────────────────────────

async def generate_reactions(
    speaker: str,
    message: str,
    characters: list[dict],
    transcript: list[dict],
    ledger: ArgumentLedger,
) -> list[dict]:
    """
    After a character speaks, generate brief emotional reactions from 2-3 other characters.
    Returns: [{character, reaction}] — each reaction is a one-line body language/expression.
    """
    other_chars = [c for c in characters if c["name"] != speaker]
    if not other_chars:
        return []

    char_summaries = "\n".join(
        f"  {c['name']} ({c.get('role', 'supporting')}): {ledger.character_positions.get(c['name'], 'no position yet')}"
        for c in other_chars
    )

    prompt = f"""A character just spoke in a debate. Generate brief EMOTIONAL REACTIONS from other characters.

WHO SPOKE: {speaker}
WHAT THEY SAID: {message[:300]}

OTHER CHARACTERS PRESENT:
{char_summaries}

Generate reactions for 2-3 characters (NOT all of them — only those who would visibly react).
Each reaction is ONE LINE about their expression, voice, or demeanor. Examples:
- "goes very quiet — the dangerous kind of quiet"
- "scoffs audibly"
- "voice drops to a whisper: 'He's lying again.'"
- "narrows his eyes, says nothing"
- "a bitter smile crosses her face"
- "visibly stiffens at those words"
- "lets out a slow, heavy breath"
- "turns to the others, eyebrows raised, as if to say: 'You heard that too?'"

IMPORTANT CONTEXT: This is a Sabha — a formal debate assembly. NOT a physical location from the story.
- NO references to barns, rooms, fields, or story locations
- NO physical movement (walking, stepping, positioning)
- Only: facial expressions, tone of voice, breath, posture, glances, muttered words
- Think courtroom drama, not stage play

Rules:
- Only react characters who CARE about what was said
- Reactions must fit the character's personality and position
- Enemies react with tension, allies with support, neutrals with curiosity
- Keep it about EXPRESSION not LOCATION
- Do NOT generate reactions for characters unrelated to the topic

Return JSON only:
{{"reactions": [{{"character": "Name", "reaction": "one-line reaction"}}]}}"""

    try:
        raw = await _invoke_with_fallback([HumanMessage(content=prompt)])
        raw = re.sub(r"^```(?:json)?\n?", "", raw.strip())
        raw = re.sub(r"\n?```$", "", raw.strip())
        result = json.loads(raw)
        reactions = result.get("reactions", [])
        # Validate character names
        valid_names = {c["name"] for c in other_chars}
        return [r for r in reactions if r.get("character") in valid_names and r.get("reaction")][:3]
    except Exception as e:
        logger.warning(f"Reaction generation failed: {e}")
        return []


# ── Stage Directions ───────────────────────────────────────────────────────────

async def generate_stage_direction(
    event: str,
    characters: list[dict],
    transcript: list[dict],
    ledger: ArgumentLedger,
    story_title: str,
    context: dict = None,
) -> str:
    """
    Generate atmospheric stage directions — what the room feels like.
    event: "tension_rising", "breakthrough", "silence", "phase_shift", "confrontation"
    Returns: one evocative sentence.
    """
    context = context or {}
    char_names = [c["name"] for c in characters]
    recent = "\n".join(f"{e['character']}: {e['message'][:100]}" for e in transcript[-3:]) if transcript else ""

    event_prompts = {
        "tension_rising": "The tension in the room is building. Something is about to crack. Describe the atmosphere.",
        "breakthrough": f"{context.get('character', 'Someone')} just said something that changed everything. Describe the room's reaction.",
        "silence": "A heavy silence falls. Nobody moves. Describe it.",
        "phase_shift": f"The debate is shifting from {context.get('from', 'one phase')} to {context.get('to', 'another')}. The mood changes. Describe it.",
        "confrontation": f"{context.get('char_a', 'One character')} and {context.get('char_b', 'another')} are about to clash. The room holds its breath.",
    }

    instruction = event_prompts.get(event, "Describe the atmosphere in the room.")

    prompt = f"""You are writing stage directions for a dramatic debate about "{story_title}".

CHARACTERS PRESENT: {', '.join(char_names)}

RECENT EXCHANGE:
{recent}

TASK: {instruction}

Write ONE sentence capturing the mood of the Sabha at this moment. Examples:
- "A silence falls over the Sabha — the kind that has weight."
- "The air between them thickens with something unsaid."
- "For a moment, nobody breathes."
- "Something shifts in the Sabha — as if the truth just took a seat."
- "The tension is a living thing now."

IMPORTANT: This is a Sabha — an abstract debate assembly. NOT a physical story location.
- NO barns, rooms, fields, weather, dogs barking, wind blowing
- NO story-world details — only the emotional atmosphere of the debate itself
- Think: the mood in a courtroom when the verdict is about to drop
- One sentence. Evocative. About FEELING, not setting.

Write the stage direction (no quotes, no prefix):"""

    try:
        raw = await _invoke_with_fallback([HumanMessage(content=prompt)])
        return raw.strip().strip('"')
    except Exception as e:
        logger.warning(f"Stage direction failed: {e}")
        return ""


def should_generate_reactions(transcript: list[dict], drama_score: float) -> bool:
    """Decide if this turn warrants emotional reactions (not every turn does)."""
    if len(transcript) < 3:
        return False
    # React on high-drama turns, direct confrontations, or every ~3 turns
    last = transcript[-1]
    if drama_score > 0.65:
        return True
    if last.get("emotion") in ("anger", "cold_fury", "contempt", "grief", "revelation"):
        return True
    # Every 3rd turn for natural rhythm
    char_turns = [e for e in transcript if not e.get("isOrchestrator") and not e.get("isObserver") and not e.get("isAudience")]
    return len(char_turns) % 3 == 0


def should_add_stage_direction(transcript: list[dict], current_phase: str, drama_score: float) -> str | None:
    """Decide if a stage direction is needed. Returns the event type or None."""
    if len(transcript) < 4:
        return None
    last = transcript[-1]
    # After a high-emotion speech
    if last.get("emotion") in ("cold_fury", "grief", "revelation") and drama_score > 0.6:
        return "breakthrough" if last.get("emotion") == "revelation" else "tension_rising"
    # When drama spikes suddenly
    recent_emotions = [e.get("emotion", "neutral") for e in transcript[-4:] if not e.get("isOrchestrator")]
    intense = sum(1 for em in recent_emotions if em in ("anger", "contempt", "cold_fury", "grief"))
    if intense >= 3:
        return "confrontation"
    return None

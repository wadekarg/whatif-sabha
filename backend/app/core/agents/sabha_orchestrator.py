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

from app.config import get_analysis_llm, _make_openrouter_llm, _make_nvidia_llm, _make_github_models_llm, _make_cloudflare_llm, get_narrator_fallbacks
from app.core.usage_tracker import tracker

logger = logging.getLogger(__name__)


def _get_orchestrator_llm():
    """Get an LLM for Boru — tries Gemini first, falls back to OpenRouter, then Groq/NVIDIA."""
    # Try Gemini first
    try:
        llm = get_analysis_llm()
        return llm
    except Exception:
        pass

    # Try OpenRouter free models
    for model in ["google/gemma-4-31b-it:free", "meta-llama/llama-3.3-70b-instruct:free", "nousresearch/hermes-3-llama-3.1-405b:free"]:
        llm = _make_openrouter_llm(model, temperature=0.3)
        if llm:
            return llm

    # Try Groq/NVIDIA narrator fallbacks
    fallbacks = get_narrator_fallbacks(temperature=0.3)
    if fallbacks:
        return fallbacks[0][0]

    raise ValueError("No LLM available for orchestrator")


async def _invoke_with_fallback(messages: list) -> str:
    """Invoke LLM with automatic fallback across all free providers."""
    # Prioritize FAST + CLEAN instruct models. Avoid slow or thinking models.
    BEST_FREE = [
        "google/gemma-4-31b-it:free",                      # 31B — fast, clean, no thinking
        "google/gemma-3-27b-it:free",                      # 27B — proven, fast
        "meta-llama/llama-3.3-70b-instruct:free",          # 70B — clean instruct
        "nvidia/nemotron-nano-9b-v2:free",                 # 9B — ultra fast
        "google/gemma-3-12b-it:free",                      # 12B — fast
        "openai/gpt-oss-20b:free",                         # 20B — clean
    ]

    providers = []

    # 1. NVIDIA — most reliable, no daily limit, ~40 RPM, clean instruct output
    NVIDIA_ORCH_MODELS = [
        "meta/llama-3.3-70b-instruct",                      # 70B — proven, clean
        "google/gemma-4-31b-it",                             # 31B — fast
        "mistralai/mistral-small-3.1-24b-instruct-2503",    # 24B — clean
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

    # 6. OpenRouter (50/day — last resort)
    for model in BEST_FREE[:2]:
        llm = _make_openrouter_llm(model, temperature=0.4)
        if llm:
            providers.append((f"or:{model.split('/')[-1].split(':')[0]}", llm))

    # 7. Groq as absolute last resort
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
        self.character_positions: dict[str, str] = {}  # character → current position summary
        self.progress_summary: str = ""
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
        })
        return qid

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
        # Simple hash-based: normalize and compare
        normalized = re.sub(r'\s+', ' ', claim_summary.lower().strip())
        key_words = set(re.findall(r'\b\w{4,}\b', normalized))
        for prev in self.repetition_log.get(character, []):
            prev_words = set(re.findall(r'\b\w{4,}\b', prev))
            if len(key_words & prev_words) / max(len(key_words | prev_words), 1) > 0.6:
                return True
        self.repetition_log.setdefault(character, []).append(normalized)
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
) -> dict:
    """
    After a character speaks, use LLM to update the argument ledger.
    Also detects cross-talk: character asking for an observer, addressing Boru, etc.
    Returns: {new_claims, questions_answered, questions_asked, position_update, is_repetition,
              wants_observer, addresses_boru, observer_tension}
    """
    observer_names = observer_names or []
    recent = transcript[-6:] if len(transcript) > 6 else transcript
    transcript_text = "\n".join(f"{e['character']}: {e['message'][:200]}" for e in recent)

    # Build observer context for the LLM
    observer_ctx = ""
    if observer_names:
        observer_ctx = f"\nWORLD OBSERVERS IN THIS DEBATE: {', '.join(observer_names)}"

    prompt = f"""A character just spoke in the debate. Analyze their statement.

CHARACTER: {speaker}
THEIR MESSAGE: {message}

RECENT TRANSCRIPT:
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
  "progress_note": "brief note on how the debate moved forward (or didn't)",
  "follow_up_questions": [{{"question": "a NEW question Boru should ask based on what was said", "directed_to": ["CharName"], "reason": "why this matters"}}],
  "wants_observer": false,
  "wanted_observer_reason": "",
  "addresses_boru": false,
  "boru_question": ""
}}

DETECTION RULES:
- "wants_observer": true if the speaker asks for an outside perspective, mentions an observer by name, or says something like "what would X think?" where X is a world observer
- "wanted_observer_reason": which observer and why (e.g. "Wants to hear from the Soviet analyst about propaganda")
- "addresses_boru": true if the speaker directly addresses Boru/the Speaker/the moderator/the elephant, asks a meta-question about the debate, or challenges the process
- "boru_question": what they asked Boru (e.g. "Why are you letting Napoleon dodge?")

FOLLOW-UP QUESTIONS:
- Generate 0-1 follow-up questions that Boru should ask in future rounds
- These should be NEW angles not yet explored — creative, probing, unexpected
- Think about: contradictions in what was said, things left unsaid, consequences not considered
- Only generate a follow-up if the response genuinely opens a new angle
- Direct it at the character(s) most relevant to answer

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
                break

    if result.get("position_update"):
        ledger.character_positions[speaker] = result["position_update"]

    if result.get("progress_note"):
        ledger.progress_summary = result["progress_note"]

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
) -> Optional[str]:
    """
    Ask the orchestrator if it's time to move to the next phase.
    Returns the new phase name, or None if staying in current phase.
    """
    phase_idx = PHASES.index(current_phase) if current_phase in PHASES else 0
    if phase_idx >= len(PHASES) - 1:
        return None  # already in closing

    next_phase = PHASES[phase_idx + 1]
    config = PHASE_CONFIG[current_phase]
    char_names = [c["name"] for c in characters]

    # Count turns per character in current phase
    phase_turns = {}
    in_phase = False
    for e in transcript:
        if e.get("phase") == current_phase:
            in_phase = True
        if in_phase:
            name = e["character"]
            if name in char_names:
                phase_turns[name] = phase_turns.get(name, 0) + 1

    min_met = all(
        phase_turns.get(n, 0) >= config["min_turns_per_char"]
        for n in char_names
    )

    if not min_met:
        return None  # haven't met minimum turns for this phase

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

    prompt = f"""You are Boru the Elephant — Speaker of this Sabha.

PHASE: {current_phase} — {PHASE_CONFIG.get(current_phase, {}).get('description', '')}

CHARACTERS:
{chr(10).join(char_context)}

LEDGER:
{ledger.to_context()}

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


async def generate_orchestrator_message(
    ledger: ArgumentLedger,
    current_phase: str,
    transcript: list[dict],
    characters: list[dict],
    story_title: str,
    event_type: str,
    context: dict = None,
) -> str:
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
            f"2. State today's topic: \"{context.get('divergence', ledger.divergence)}\" "
            f"DO NOT name or invite any character to speak. DO NOT say 'let us hear from X' or 'our first speaker is X'. "
            f"The character invitations come in a SEPARATE message after this one. "
            f"3-4 sentences. Grand, warm, with elephant wisdom. This is your moment to set the stage."
        ),
        "invite_multiple": (
            f"You are inviting MULTIPLE characters to speak in this round: {', '.join(context.get('speakers', []))}. "
            f"Address each by name. Tell each one specifically what you want them to address. "
            f"Be pointed — 'Napoleon, explain. Benjamin, what did you see? Squealer, we've heard enough spin.' "
            f"2-3 sentences max."
        ),
        "invite_speaker": (
            f"You are inviting {context.get('speaker', 'the next character')} to speak. "
            f"Context: {context.get('directive', 'share their view')}. "
            f"Be direct, use their name. "
            f"IMPORTANT: Check the transcript — if NO characters have spoken yet (debate just started), "
            f"do NOT say 'you've been quiet' or 'you've been dodging'. Instead, simply invite them: "
            f"'{context.get('speaker', 'Friend')}, you have the floor. Tell us where you stand.' "
            f"If the debate IS underway and they have unanswered questions, call them out. "
            f"If someone attacked them, reference the specific claim. "
            f"1-2 sentences. Be direct and natural."
        ),
        "redirect": (
            f"The debate is going off-track or stalling. Call it out with your signature dry humor. "
            f"'I'm an elephant. I can stand here all day. But I'd rather not.' "
            f"Point out what's being missed or ignored. Be specific about the dodge. "
            f"1-2 sentences."
        ),
        "call_out_repetition": (
            f"{context.get('speaker', 'Someone')} is repeating themselves. "
            f"Be devastating but funny. Reference their SPECIFIC repeated point. Examples of your style: "
            f"'You've said that three times now. My memory is long, {context.get('speaker', 'friend')}, but my patience is not.' "
            f"'Even the walls are bored of that argument.' "
            f"'I believe the flies have memorized that speech by now.' "
            f"1 sentence, make it sting."
        ),
        "phase_transition": (
            f"The debate is moving from '{context.get('from_phase', '')}' to '{context.get('to_phase', '')}'. "
            f"Summarize what was accomplished — be honest about what was productive and what was hot air. "
            f"Set up the new phase with anticipation. If someone dodged, mention it: 'We still haven't heard the truth about...' "
            f"2-3 sentences. Mix gravity with wit."
        ),
        "closing_summary": (
            f"The debate is concluding. You are moved — reflect on what emerged. "
            f"Highlight the moment that surprised even you (an elephant is not easily surprised). "
            f"Name the tension that remains unresolved — 'Some truths, it seems, are too heavy even for an elephant to carry.' "
            f"Thank the characters, but with a knowing edge — 'You spoke. Some of you even meant it.' "
            f"3-4 sentences. This is your finest moment."
        ),
        "observer_intro": (
            f"You are introducing a world observer: {context.get('observer_name', 'an outside voice')}. "
            f"Build anticipation — 'There's someone who's been watching this with great interest.' "
            f"Set up why their perspective is going to shake things up. 1-2 sentences."
        ),
        "forced_question": (
            f"A critical question has gone unanswered for too long and you're done waiting. "
            f"Force {context.get('target', 'the character')} to address it: \"{context.get('question', '')}\" "
            f"Be pointed, slightly annoyed, and funny about it. "
            f"'I have asked. Others have asked. Even the walls have asked. Now YOU will answer.' "
            f"1-2 sentences."
        ),
        "summon_observer": (
            f"{context.get('requester', 'Someone')} has requested an outside perspective. "
            f"Reason: {context.get('reason', 'the debate needs a fresh angle')}. "
            f"Introduce the observer dramatically — 'An interesting request. "
            f"There IS someone who has been watching this with great interest...' "
            f"Build anticipation. 1-2 sentences."
        ),
        "respond_to_character": (
            f"{context.get('speaker', 'A character')} just addressed YOU directly. "
            f"They said/asked: \"{context.get('question', '')}\" "
            f"Respond as Boru — in character. You can be: "
            f"- Deflective with humor: 'I'm the Speaker, not a participant. But since you asked...' "
            f"- Self-aware: 'An elephant moderating a debate between farm animals. Yes, I see the irony.' "
            f"- Sharp: 'You're asking ME? Perhaps because none of your friends here will give you the answer you want.' "
            f"- Warm if it's a genuine question about the process "
            f"Keep it to 1-2 sentences. Stay in character."
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
        "observer_tension": (
            f"Two observers have contradicting views. "
            f"Observer A: {context.get('observer_a', '')} said: {context.get('claim_a', '')}. "
            f"Observer B: {context.get('observer_b', '')} said: {context.get('claim_b', '')}. "
            f"Note the contradiction with interest — 'Well now. Even the outsiders can't agree.' "
            f"Use it to deepen the debate. 1-2 sentences."
        ),
    }

    instruction = event_instructions.get(event_type, "Moderate the debate. 1-2 sentences.")

    prompt = f"""You are Boru the Elephant — the witty, sharp host of the WhatIfSabha debate about "{story_title}".

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

    try:
        raw = await _invoke_with_fallback([HumanMessage(content=prompt)])
        return raw.strip().strip('"')
    except Exception as e:
        logger.warning(f"Orchestrator message generation failed: {e}")
        return ""


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
    char_turns = [e for e in transcript if e["character"] in char_names and not e.get("isOrchestrator")]
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

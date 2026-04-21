from langchain_core.messages import SystemMessage, HumanMessage
from app.config import get_agent_llm, get_agent_fallbacks
from app.core.agents.base_agent import build_character_system_prompt


def _build_debate_state_briefing(ledger, round_number, current_phase, character_name):
    """Build a structured debate state block from the ledger — gives character full situational awareness."""
    if not ledger:
        return None
    lines = [f"[DEBATE STATE — Turn {round_number}, Phase: {current_phase.upper().replace('_', ' ')}]"]

    # Positions (max 5, prioritize this character + most active)
    if ledger.character_positions:
        lines.append("\nPOSITIONS:")
        # This character first
        if character_name in ledger.character_positions:
            lines.append(f"  You: {ledger.character_positions[character_name][:100]}")
        count = 0
        for name, pos in ledger.character_positions.items():
            if name == character_name:
                continue
            lines.append(f"  {name}: {pos[:100]}")
            count += 1
            if count >= 4:
                break

    # Open questions (max 3, prioritize directed at this character)
    if ledger.open_questions:
        directed_at_me = [q for q in ledger.open_questions if character_name in q.get("directed_to", [])]
        others = [q for q in ledger.open_questions if character_name not in q.get("directed_to", [])]
        show_qs = (directed_at_me + others)[:3]
        if show_qs:
            lines.append("\nOPEN QUESTIONS (the Sabha is waiting):")
            for q in show_qs:
                age = q.get("_times_injected", 0) + q.get("_deflections", 0)
                urgency = f" — UNANSWERED {age}+ TURNS" if age >= 2 else ""
                directed = ", ".join(q.get("directed_to", []))
                me_tag = " [TO YOU]" if character_name in q.get("directed_to", []) else ""
                lines.append(f"  Q{q['id']}: \"{q['question'][:100]}\" [asked by {q['asked_by']}, to {directed}]{me_tag}{urgency}")

    # Disputes (max 2, prioritize those involving this character)
    if ledger.disputes:
        unresolved = [d for d in ledger.disputes if d["status"] == "unresolved"]
        my_disputes = [d for d in unresolved if d["claim_a"]["character"] == character_name or d["claim_b"]["character"] == character_name]
        other_disputes = [d for d in unresolved if d not in my_disputes]
        show_d = (my_disputes + other_disputes)[:2]
        if show_d:
            lines.append("\nDISPUTES (contradictions — still unresolved):")
            for d in show_d:
                lines.append(
                    f"  D{d['id']}: {d['claim_a']['character']} says \"{d['claim_a']['claim'][:60]}\" "
                    f"BUT {d['claim_b']['character']} says \"{d['claim_b']['claim'][:60]}\""
                )

    # Summary stats
    resolved_count = len(ledger.resolved_questions)
    resolved_disputes = len([d for d in ledger.disputes if d["status"] != "unresolved"])
    if resolved_count or resolved_disputes:
        lines.append(f"\nRESOLVED: {resolved_count} questions, {resolved_disputes} disputes settled.")

    return "\n".join(lines)


# Phase-specific behavioral directives
PHASE_DIRECTIVES = {
    "opening": None,  # System prompt handles opening
    "cross_examination": (
        "[DEBATE PHASE: CROSS-EXAMINATION]\n"
        "CHALLENGE. Pick a specific claim and tear it apart. Ask questions with only one honest answer.\n"
        "Short, sharp, specific. Name names. 1-2 sentences. NO speeches."
    ),
    "deepening": (
        "[DEBATE PHASE: DEEPENING]\n"
        "Surface arguments are done. Go DEEPER. What happens six months after this scenario? A year?\n"
        "Find the specific day, the specific choice, the specific cost nobody has named.\n"
        "NO POLICY LANGUAGE. NO ABSTRACTIONS. The specific moment, or nothing."
    ),
    "reckoning": (
        "[DEBATE PHASE: RECKONING]\n"
        "Open questions MUST be answered. Disputes MUST be faced.\n"
        "Either confess something true, or double down and explain WHY you refuse to answer.\n"
        "No dodging. No speeches. The truth, or your best lie — commit to it.\n"
        "BANNED: any sentence that could appear in a policy memo."
    ),
    "closing": (
        "[DEBATE PHASE: CLOSING]\n"
        "Your last chance to speak. Say the ONE thing you need the Sabha to remember.\n"
        "Make it personal. Make it count. 1-2 sentences."
    ),
}


def _build_phase_directive(current_phase, round_number):
    """Return phase-specific behavioral instruction, or None for early turns."""
    if round_number < 6:
        return None
    return PHASE_DIRECTIVES.get(current_phase)


def _build_dispute_callout(ledger, character_name):
    """If this character is party to an unresolved dispute, build a direct callout."""
    if not ledger or not ledger.disputes:
        return None
    for d in ledger.disputes:
        if d["status"] != "unresolved" or d["turns_unresolved"] < 2:
            continue
        if d["claim_a"]["character"] == character_name:
            return (
                f"[UNRESOLVED DISPUTE — the Sabha has noticed]\n"
                f"You said: \"{d['claim_a']['claim'][:120]}\"\n"
                f"{d['claim_b']['character']} said: \"{d['claim_b']['claim'][:120]}\"\n"
                f"These cannot both be true. Address this."
            )
        elif d["claim_b"]["character"] == character_name:
            return (
                f"[UNRESOLVED DISPUTE — the Sabha has noticed]\n"
                f"You said: \"{d['claim_b']['claim'][:120]}\"\n"
                f"{d['claim_a']['character']} said: \"{d['claim_a']['claim'][:120]}\"\n"
                f"These cannot both be true. Address this."
            )
    return None


def _extract_personal_directive(character_name, message):
    """
    When Boru issues a multi-character directive ("Hamlet, address X. Claudius, explain Y."),
    extract only the sentence(s) relevant to this character. Returns None if not found.
    """
    import re
    # Split on sentences that start with a character name
    # Pattern: "Name, verb..." or "Name — verb..."
    parts = re.split(r'(?<=[.!?])\s+(?=[A-Z])', message)
    personal = [p for p in parts if character_name.lower() in p[:len(character_name) + 15].lower()]
    if personal:
        return " ".join(personal).strip()
    return None


def _summarize_own_arguments(character_name, debate_history):
    """
    Build a brief summary of what this character has already said in the debate.
    Injected so the LLM knows what NOT to repeat.
    """
    own_msgs = [
        e["message"][:150] for e in debate_history
        if e["character"] == character_name
        and not e.get("isReaction") and not e.get("isStageDirection")
    ]
    if not own_msgs:
        return ""
    # Take last 6 messages — wider window catches more repetition
    recent = own_msgs[-6:]
    summary = "\n".join(f"  - {m}..." for m in recent)
    return (
        f"\n\n[WHAT YOU HAVE ALREADY ARGUED — DO NOT REPEAT THESE POINTS]:\n{summary}\n"
        f"You MUST say something NEW. Build on what others said, imagine a new consequence, "
        f"reveal something you haven't shared, or challenge someone on a specific claim. "
        f"If you catch yourself restating an old point, STOP and think of what happens NEXT instead."
    )


def _world_state_block(character_name: str, world_state: dict | None) -> str:
    """Per-character status injection based on the divergence's world_state.

    Dead → speak from recollection/grave, past or conditional tense.
    Empowered/weakened → one-line state reminder.
    Returns "" when no status applies.
    """
    if not world_state:
        return ""
    if character_name in (world_state.get("dead") or []):
        return (
            "\n\n[WORLD STATE] In this what-if, you are DEAD. "
            "Speak from the grave or in recollection only — past tense or conditional "
            "(\"I would have…\", \"I said back then…\"). "
            "Do NOT make active plans for future winters, do NOT give orders, do NOT threaten. "
            "You are a memory and a voice — not a force in the room."
        )
    if character_name in (world_state.get("empowered") or []):
        return (
            "\n\n[WORLD STATE] In this what-if, you now HOLD POWER on the farm. "
            "Speak from that fact — the authority is yours now. "
            "Do not argue as if you are still the challenger; argue as the one who won."
        )
    if character_name in (world_state.get("weakened") or []):
        return (
            "\n\n[WORLD STATE] In this what-if, you have LOST POWER — exiled, deposed, or broken. "
            "Speak from that fact. Your arguments now come from the margin, not the throne."
        )
    return ""


def _build_turn_prompt(
    character_name,
    debate_history,
    correction_hint=None,
    pending_questions=None,
    world_state=None,
):
    """
    Build a context-aware turn prompt.
    Returns (prompt_text, is_direct_response).
    is_direct_response=True means the character was directly addressed — use higher token limit.
    """
    is_direct = False

    if not debate_history:
        prompt = (
            "The debate is opening. Imagine the what-if scenario is real — "
            "what is the FIRST thing that changes for you personally? "
            "How does your life, your choices, your relationships shift? "
            "Speak from your gut. Be specific. Name names."
        )
    else:
        # Find the last REAL speaker (skip Boru, reactions, stage directions)
        last = debate_history[-1]
        for entry in reversed(debate_history):
            if (not entry.get("isOrchestrator") and not entry.get("isReaction")
                    and not entry.get("isStageDirection") and not entry.get("isAudience")):
                last = entry
                break
        last_speaker = last["character"]
        last_msg = last["message"]
        target = last.get("target_character")

        # If the last message is from Boru and mentions multiple characters,
        # extract only the part directed at THIS character to prevent identity bleed.
        display_msg = last_msg
        if last.get("isOrchestrator") and last_msg.count(",") >= 2:
            personal = _extract_personal_directive(character_name, last_msg)
            if personal:
                display_msg = personal

        snippet = display_msg[:250].rstrip() + ("…" if len(display_msg) > 250 else "")

        if target == character_name:
            is_direct = True
            prompt = (
                f'{last_speaker} just spoke directly to you:\n"{snippet}"\n\n'
                f'You MUST respond to {last_speaker}. But don\'t just defend your old position — '
                f'ADVANCE the story. What happens NEXT if they\'re right? What happens if they\'re wrong? '
                f'Imagine a concrete scenario — a specific day, a specific choice, a specific consequence. '
                f'2–4 sentences.'
            )
        elif "?" in last_msg and character_name.lower() in last_msg.lower():
            is_direct = True
            prompt = (
                f'{last_speaker} just called your name:\n"{snippet}"\n\n'
                f'Answer their question — but don\'t stop there. '
                f'Take it further: what would that answer LEAD TO? Paint the picture. '
                f'2–3 sentences.'
            )
        else:
            prompt = (
                f'{last_speaker} just said:\n"{snippet}"\n\n'
                f'Find the CRACK in what they just said. What are they not seeing? '
                f'What goes wrong with their vision — the first winter, the first betrayal, '
                f'the first mouth they can\'t feed? Imagine the specific moment it falls apart. '
                f'Then say what YOU would do differently. '
                f'Challenge someone by name. 1–3 sentences.'
            )

    if correction_hint:
        prompt += f"\n\nIMPORTANT: Your last response was flagged. Correction needed: {correction_hint}"

    # Inject pending questions — answer + explore what-if consequences
    if pending_questions:
        qs = "\n".join(f"  - {q.get('asked_by', 'Someone')}: \"{q['question']}\"" for q in pending_questions[:2])
        prompt += (
            f"\n\nYou've been asked directly and haven't answered:\n{qs}\n"
            f"Answer at least ONE — don't dodge it, don't restate it, just answer.\n"
            f"Then push into the what-if: what happens NEXT because of your answer? "
            f"What changes for you, who gets hurt, what new danger or opportunity opens up? "
            f"Imagine the specific day, the specific choice, the specific consequence."
        )
        # Don't inflate token budget — pending questions are a nudge, not a direct address

    # ── World-state status (dead / empowered / weakened in this divergence) ──
    prompt += _world_state_block(character_name, world_state)

    # ── In-character reminder — the last nudge before the LLM speaks ──
    prompt += (
        f"\n\nSpeak as {character_name}. Every sentence must sound like they would say it — "
        f"in their world, in their voice, in this room, now. "
        f"Not as a planner. Not as a narrator. Not as a committee."
    )

    return prompt, is_direct


def _inject_memories(messages, memories):
    """Inject past memories as a framing message right after the system prompt."""
    if not memories:
        return
    memory_lines = "\n".join(f"• {m}" for m in memories)
    messages.insert(1, HumanMessage(content=(
        f"[YOUR MEMORY — positions and truths you have revealed in previous debates]\n"
        f"{memory_lines}\n"
        f"This is your accumulated experience. Let it inform — but not constrain — how you speak today."
    )))


async def character_respond(
    character,
    phase,
    divergence,
    debate_history,
    story_title="",
    exploration_hint=None,
    memory_context=None,
    debate_progress=None,  # NEW: Short note on debate state
):
    character["story_title"] = story_title
    system_prompt = build_character_system_prompt(character, phase, divergence)

    messages = [SystemMessage(content=system_prompt)]

    _inject_memories(messages, memory_context or [])

    # Add debate progress note if available
    if debate_progress:
        messages.append(HumanMessage(content=(
            f"[CURRENT DEBATE STATE — what's been happening so far]: {debate_progress}"
        )))

    for entry in debate_history[-12:]:
        speaker = entry["character"]
        text = entry["message"]
        if speaker == character["name"]:
            messages.append(HumanMessage(content=f"[You previously said]: {text}"))
        else:
            messages.append(HumanMessage(content=f"{speaker}: {text}"))

    turn_prompt, is_direct = _build_turn_prompt(character["name"], debate_history)
    messages.append(HumanMessage(content=turn_prompt))

    if exploration_hint:
        messages.append(HumanMessage(content=(
            f"[HIDDEN TRUTH — this is something deep and true about you that you have never said aloud. "
            f"Let it surface in what you say now, naturally — do not announce it, just let it shape your words]: "
            f"{exploration_hint}"
        )))

    llm = get_agent_llm(max_tokens=160 if is_direct else 110)
    response = await llm.ainvoke(messages)
    return response.content.strip()


async def character_respond_stream(
    character,
    phase,
    divergence,
    debate_history,
    story_title="",
    correction_hint=None,
    exploration_hint=None,
    memory_context=None,
    observer_challenge=None,
    pending_questions=None,
    debate_progress=None,
    ledger=None,
    current_phase="",
    round_number=0,
    world_state=None,
):
    character["story_title"] = story_title
    system_prompt = build_character_system_prompt(character, phase, divergence)

    messages = [SystemMessage(content=system_prompt)]

    _inject_memories(messages, memory_context or [])

    char_name = character["name"]

    # ── 3. DEBATE STATE BRIEFING (full situational awareness from ledger) ──
    state_briefing = _build_debate_state_briefing(ledger, round_number, current_phase or "opening", char_name)
    if state_briefing:
        messages.append(HumanMessage(content=state_briefing))

    # ── 4. COMPRESSED OLDER HISTORY ──
    real_entries = [e for e in debate_history
                    if not e.get("isReaction") and not e.get("isStageDirection")]
    RECENT_COUNT = 5
    recent = real_entries[-RECENT_COUNT:] if len(real_entries) > RECENT_COUNT else real_entries
    older = real_entries[:-RECENT_COUNT] if len(real_entries) > RECENT_COUNT else []

    if older:
        older_speakers = {}
        for e in older:
            if e.get("isOrchestrator"):
                continue
            name = e["character"]
            if name not in older_speakers:
                older_speakers[name] = []
            older_speakers[name].append(e["message"][:60])
        summary_lines = []
        for name, msgs in older_speakers.items():
            key_point = msgs[-1]
            summary_lines.append(f"  {name}: \"{key_point}...\" ({len(msgs)} turns)")
        if summary_lines:
            messages.append(HumanMessage(content=(
                f"[EARLIER — {len(older)} turns ago]:\n" + "\n".join(summary_lines)
            )))

    # ── 5. PHASE DIRECTIVE (replaces static BANNED LANGUAGE reminder) ──
    phase_dir = _build_phase_directive(current_phase or "opening", round_number)
    if phase_dir:
        messages.append(HumanMessage(content=phase_dir))

    # ── 6. BORU CALLOUTS (max 2 most recent) ──
    boru_callouts = []
    for entry in reversed(debate_history):
        if entry.get("isOrchestrator"):
            event = entry.get("orchestratorEvent", "")
            if event in ("forced_question", "call_out_repetition", "defend_sabha", "break_duel") and char_name.lower() in entry["message"].lower():
                boru_callouts.append(entry["message"][:200])
                if len(boru_callouts) >= 2:
                    break
    for msg in reversed(boru_callouts):
        messages.append(HumanMessage(content=f"[The moderator said to you]: {msg}"))

    # ── 7. RECENT RAW MESSAGES (last 5) ──
    for entry in recent:
        if entry.get("isOrchestrator"):
            event = entry.get("orchestratorEvent", "")
            if event in ("phase_transition", "closing_summary"):
                messages.append(HumanMessage(content=f"[The moderator noted]: {entry['message'][:150]}"))
            continue
        speaker = entry["character"]
        text = entry["message"]
        if speaker == char_name:
            messages.append(HumanMessage(content=f"[You previously said]: {text}"))
        else:
            messages.append(HumanMessage(content=f"{speaker}: {text}"))

    # ── 8. DISPUTE CALLOUT (if this character is party to an unresolved dispute) ──
    dispute_callout = _build_dispute_callout(ledger, char_name)
    if dispute_callout:
        messages.append(HumanMessage(content=dispute_callout))

    turn_prompt, is_direct = _build_turn_prompt(character["name"], debate_history, correction_hint, pending_questions, world_state=world_state)

    # Inject summary of what this character already argued — prevents repetition
    own_summary = _summarize_own_arguments(character["name"], debate_history)
    if own_summary:
        turn_prompt += own_summary

    messages.append(HumanMessage(content=turn_prompt))

    if observer_challenge:
        messages.append(HumanMessage(content=(
            f"[DIRECT CHALLENGE FROM OUTSIDE THE STORY]\n"
            f"{observer_challenge['observer_name']} — a historical observer — has just confronted you:\n"
            f"\"{observer_challenge['question']}\"\n\n"
            f"You MUST respond to this challenge in your reply. Address it head-on — with your own logic, "
            f"your own values, your own blindspot if necessary. Do not ignore it."
        )))

    if exploration_hint:
        messages.append(HumanMessage(content=(
            f"[HIDDEN TRUTH — this is something deep and true about you that you have never said aloud. "
            f"Let it surface in what you say now, naturally — do not announce it, just let it shape your words]: "
            f"{exploration_hint}"
        )))

    # Try full fallback chain (Cerebras → NVIDIA → GitHub → Cloudflare → Groq)
    from app.config import _is_rate_limit

    token_limit = 160 if is_direct else 110
    fallbacks = get_agent_fallbacks(max_tokens=token_limit)

    last_exc = None
    for llm, _label in fallbacks:
        try:
            async for chunk in llm.astream(messages):
                if chunk.content:
                    yield chunk.content
            return
        except Exception as e:
            if _is_rate_limit(e):
                last_exc = e
                continue
            raise
    if last_exc:
        raise last_exc


async def character_continue_stream(
    character: dict,
    phase: dict,
    divergence: str,
    debate_history: list,
    story_title: str = "",
    previous_response: str = "",
    continuation_reason: str = "",
    exploration_hint: str = None,
    debate_progress: str = None,  # NEW: Short note on debate state
):
    """
    A second pass for a character when the judge grants them more space.
    They pick up where they left off — deeper, rawer, unburdened.
    """
    from langchain_core.messages import SystemMessage, HumanMessage
    character["story_title"] = story_title
    system_prompt = build_character_system_prompt(character, phase, divergence)

    messages = [SystemMessage(content=system_prompt)]

    # Add debate progress note if available
    if debate_progress:
        messages.append(HumanMessage(content=(
            f"[CURRENT DEBATE STATE — what's been happening so far]: {debate_progress}"
        )))

    for entry in debate_history[-12:]:
        speaker = entry["character"]
        text = entry["message"]
        if speaker == character["name"]:
            messages.append(HumanMessage(content=f"[You previously said]: {text}"))
        else:
            messages.append(HumanMessage(content=f"{speaker}: {text}"))

    prompt = (
        f"You just said:\n\"{previous_response}\"\n\n"
        f"The debate has granted you more time. The reason: {continuation_reason}\n\n"
        f"Continue from where you left off. Do NOT repeat what you already said — "
        f"go deeper. Say the thing you were holding back. "
        f"The burden is yours. Speak."
    )
    messages.append(HumanMessage(content=prompt))

    if exploration_hint:
        messages.append(HumanMessage(content=(
            f"[HIDDEN TRUTH — this is something deep and true about you that you have never said aloud. "
            f"Let it surface in what you say now, naturally — do not announce it, just let it shape your words]: "
            f"{exploration_hint}"
        )))

    llm = get_agent_llm(max_tokens=550)
    async for chunk in llm.astream(messages):
        if chunk.content:
            yield chunk.content

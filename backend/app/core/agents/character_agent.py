from langchain_core.messages import SystemMessage, HumanMessage
from app.config import get_agent_llm, get_agent_fallbacks
from app.core.agents.base_agent import build_character_system_prompt


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


def _build_turn_prompt(
    character_name,
    debate_history,
    correction_hint=None,
    pending_questions=None,
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

    llm = get_agent_llm(max_tokens=220 if is_direct else 150)
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

    # Filter out reactions/stage directions AND most Boru messages.
    # Characters should respond to EACH OTHER, not to Boru's framing.
    # Only include Boru's structural messages (phase transitions, callouts directed at this character).
    char_name = character["name"]
    for entry in debate_history[-12:]:
        if entry.get("isReaction") or entry.get("isStageDirection"):
            continue
        if entry.get("isOrchestrator"):
            event = entry.get("orchestratorEvent", "")
            # Include phase transitions (they set important context)
            if event in ("phase_transition", "closing_summary"):
                messages.append(HumanMessage(content=f"[The moderator noted]: {entry['message'][:150]}"))
            # Include forced questions / callouts directed at this character
            elif event in ("forced_question", "call_out_repetition") and char_name.lower() in entry["message"].lower():
                messages.append(HumanMessage(content=f"[The moderator said to you]: {entry['message']}"))
            # Skip all other Boru messages — characters talk to each other
            continue
        speaker = entry["character"]
        text = entry["message"]
        if speaker == char_name:
            messages.append(HumanMessage(content=f"[You previously said]: {text}"))
        else:
            messages.append(HumanMessage(content=f"{speaker}: {text}"))

    turn_prompt, is_direct = _build_turn_prompt(character["name"], debate_history, correction_hint, pending_questions)

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

    token_limit = 220 if is_direct else 150
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

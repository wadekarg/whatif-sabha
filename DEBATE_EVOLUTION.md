# WhatIfSabha Debate Engine: Evolution & Regression Analysis

## Why This Document Exists

The debates felt better in earlier versions. This document traces every architectural change to the debate engine from the initial commit to today, identifying what improved, what regressed, and why.

---

## Phase 1: The Simple Loop (Commit `e07f1d4` — Apr 6)

**Built by:** Claude Sonnet 4.6

### Architecture
- **Turn selection:** Pure heuristic scoring (`pick_next_speaker` in `orchestrator.py`)
  - +3.0 for direct question target
  - +2.0 for being named in the last message
  - +1.0 per round of silence
  - -999 for back-to-back speaking
  - No LLM involved in deciding who speaks
- **Phases:** Two phases only — `opening` (each character gets one turn) then `discussion`
- **Debate end:** `should_synthesize()` — all spoke 2x + drama < 0.45, or hit max rounds
- **No moderator.** No Boru. Characters just talked to each other.

### Character Agent
- Simple system prompt from `build_character_system_prompt()`
- Turn prompt: `"It's your turn to speak. Respond as your character."`
- History: last 12 turns as context
- **One LLM:** Cerebras `qwen-3-235b` at temperature 0.75

### Judge
- Scored each response for character fidelity
- Could trigger regeneration if score < threshold

### Why It Worked Well
- **One fast model (Cerebras qwen-3-235b)** handling all characters — consistent voice quality, fast streaming, no provider juggling
- **No orchestrator overhead** — each turn was: score candidates → pick best → character speaks → judge scores → next. Zero LLM calls for meta-decisions.
- **Characters reacted to each other directly.** The last message in history was always another character's words, not a moderator's instructions. This created natural back-and-forth.
- **Simple phase logic** — no LLM-driven phase transitions that could fail/timeout
- **Temperature 0.75** — warm enough for creative, emotional responses

### What Was Missing
- No loop detection (characters could repeat themselves forever)
- No structured phases beyond opening
- No outside perspectives (world observers)
- No argument tracking
- No way to force unanswered questions

---

## Phase 2: Emotional Depth (Commits `dd0013d`, `98df264` — Apr 6)

### What Changed
- **17 emotions** added to the system prompt (anger, cold fury, contempt, grief, desperation, pride, guilt, shame, defiance, bitterness, jealousy, longing, righteous indignation, humiliation, weariness, hope, betrayal)
- **Context-aware turn prompts** — instead of "It's your turn to speak", the prompt now said:
  - If directly addressed: "You MUST respond to {speaker} — name their specific claim"
  - If question asked: "They asked you something specific. Answer it directly"
  - Otherwise: "React. Push back or build on it — stay sharp"
- **Judge-granted continuation** — if a character was on a roll, the judge could grant extra time
- **Variable-length responses** — 180 tokens default, 300 if directly addressed

### Impact on Quality
- **Positive:** Characters became more emotionally varied and responsive
- **Positive:** Direct address detection meant characters actually responded to each other
- **Neutral:** Still using the same simple turn loop — no moderator interference

---

## Phase 3: Research & Memory (Commits `ec8d859`, `3c2263e` — Apr 6-7)

### What Changed
- **Fair Witness system** — Wikipedia + web scraping + 4 LLM perspectives per character, then synthesis. Characters with Fair Witness got richer system prompts.
- **10% exploration system** — random chance to surface `hidden_dimensions` (unspoken truths about a character)
- **World Observers** — 4 historically-situated external voices (e.g., Enlightenment Rationalist, Post-Colonial Critic). Speak every 4 turns with a directed question.
- **Character soul memory** (Kuzu graph) — characters remember past debates
- **LightRAG causal graph** — narrative structure analysis

### Impact on Quality
- **Positive:** Characters had deeper identity from Fair Witness research
- **Positive:** Exploration hints created breakthrough moments
- **Positive:** World observers brought fresh angles that characters couldn't generate themselves
- **Still no moderator.** The loop was: pick speaker → character speaks → maybe observer → judge → next.

---

## Phase 4: THE BIG SHIFT — Boru Orchestrator (Commit `2ade8a2` — Apr 8)

**This is where the architecture fundamentally changed.**

### What Changed
- **New `sabha_orchestrator.py`** — 1000+ lines. Boru the Elephant as an AI moderator.
- **ArgumentLedger** — tracks claims, questions, resolutions, repetition per character
- **5 structured phases:** opening → cross_examination → deepening → reckoning → closing
- **LLM-driven turn selection** — Boru (via `pick_next_speakers()`) now decides who speaks using an LLM call, not heuristic scoring. Returns JSON with speakers + directives.
- **LLM-driven phase transitions** — `decide_phase_transition()` asks an LLM whether to advance.
- **LLM-driven debate ending** — `should_end_debate()` computes 5 signals, needs ≥3.
- **Parallel debate** — Boru can call multiple characters to speak simultaneously
- **Boru speaks between every turn** — invitation messages, callouts, transitions
- **Ledger update after every turn** — LLM analyzes what was said, extracts claims, questions
- **Audience participation** — users can inject messages

### The Cost
Every single turn now requires **3-5 LLM calls** instead of **1**:
1. `pick_next_speakers()` — LLM decides who speaks (with directives)
2. `generate_orchestrator_message()` — Boru's spoken invitation
3. Character speaks (the actual content)
4. `update_ledger()` — LLM analyzes the response
5. Possibly: `decide_phase_transition()`, `generate_reactions()`, `generate_stage_direction()`

### What Regressed
1. **Characters now respond to Boru's instructions, not to each other.** The last message in history is Boru saying "Hamlet, address the criticism that..." — so the character agent is responding to Boru's framing, not to the raw emotional content of the previous speaker. This is the #1 quality regression.

2. **Multi-character directives cause identity bleed.** When Boru says "Hamlet, address X. Claudius, explain Y. Ophelia, elaborate on Z" — each character agent sees ALL of these instructions and may respond as the wrong character. (Partially fixed in today's session.)

3. **Boru's LLM calls fail/timeout, stalling the debate.** Phase transitions, speaker selection, and ledger updates all depend on LLM responses. When a provider rate-limits, the whole debate freezes. The original heuristic scoring never failed.

4. **Boru asks the same questions repeatedly.** The LLM generating directives sees the same unresolved questions and produces the same prompt text. (Partially fixed in today's session with Jaccard similarity check.)

5. **Debate pacing slowed dramatically.** Each turn now takes 5-15 seconds of overhead (Boru's multiple LLM calls) before the character even starts speaking. The original was: instant pick → immediate stream.

6. **Temperature and model quality diluted.** Instead of one consistent Cerebras qwen-3-235b, characters are now spread across Cerebras, Groq, NVIDIA, OpenRouter, GitHub Models, Cloudflare — each with different quality, latency, and personality. Some models produce flat, generic responses.

---

## Phase 5: LLM Provider Explosion (Commits `e8d12a8` through `5849923` — Apr 9-10)

### What Changed
- **7 provider tiers** for Boru: NVIDIA → GitHub → Cloudflare → Gemini → OpenRouter → Groq
- **Fallback chains for everything:** character agents, narrator, judge, analysis
- **91 NVIDIA free models** added to fallback chains
- **Proactive usage tracker** — counts requests per provider to avoid 429s
- **20-25s timeouts** on all LLM calls
- **Aggressive output cleanup** for Boru — strips thinking blocks, planning, meta-commentary

### What Regressed
- **Boru's voice became inconsistent.** Different LLMs produce radically different moderator styles. One model gives punchy one-liners, another gives verbose paragraphs, another outputs planning text that has to be stripped.
- **Character voice quality varies by provider.** A character on Cerebras sounds different from the same character on OpenRouter's free Llama 70B.
- **More failure modes.** Each provider has different rate limits, timeouts, and error formats. More providers = more things that can go wrong.

---

## Phase 6: Fixing What Boru Broke (Commits `6f0a937` through `18f0e4f` — Apr 10-12)

### What Changed
- **"Fix Boru talking too much"** — reduced from multiple messages per turn to ONE
- **"Eliminate Boru's extra messages"** — strict one-message-per-speaker policy
- **"Split Boru's opening from character invitation"** — Boru intro (no names) → then invitation (names)
- **"Fix 6 debate quality issues"** — addressed observer repetition, forced questions, etc.
- **Graph arrow fixes** — multiple commits trying to get target detection right
- **"Fix Boru outputting thinking/planning"** — aggressive cleanup of LLM output junk

These are all fixes for problems that didn't exist before Boru was introduced.

---

## Phase 7: Today's Session (Apr 12-13)

### Fixes Applied
- **Identity bleed fix** — filter Boru's multi-character directives per character
- **Phase transition hard fallback** — deterministic advancement after N turns
- **Boru directive repetition check** — Jaccard similarity on previous directives
- **Observer re-introduction fix** — first appearance vs. returning distinction
- **Observer question semantic dedup** — theme tracking per observer
- **Verbatim response detection** — full-response Jaccard check
- **Question dismissal after deflections** — dead characters stop being asked
- **Smart target resolution** — `_resolve_target()` with priority chain
- **Graph arrow fixes** — `targets` array for multi-character invites

---

## The Core Tradeoff

| Aspect | Before Boru (Phase 1-3) | After Boru (Phase 4+) |
|--------|------------------------|----------------------|
| **LLM calls per turn** | 1 (character) + 1 (judge) = 2 | 3-5 (pick_speakers + boru_msg + character + ledger + maybe phase_transition) |
| **Turn selection** | Instant heuristic scoring | LLM call (can fail/timeout) |
| **What character sees** | Other characters' raw words | Boru's instructions about what to say |
| **Voice consistency** | One model (Cerebras) for all | 7 providers, different model per turn |
| **Phase management** | Deterministic (round count) | LLM-driven (can get stuck) |
| **Failure modes** | Almost none | Provider rate limits, timeouts, JSON parse failures |
| **Argument tracking** | None | Full ledger (claims, questions, resolutions) |
| **Loop detection** | None | Jaccard similarity on claims |
| **Outside perspectives** | None (until Phase 3) | World observers every 5 turns |
| **Debate structure** | Flat (opening → discussion) | 5 phases with goals |
| **Audience participation** | None | Users can interject |

---

## Why Earlier Debates Felt Better

1. **Characters talked TO each other.** Now they talk TO Boru. The raw emotional response to "You betrayed me" is more powerful than responding to "Boru says: address the betrayal."

2. **One consistent model.** Cerebras qwen-3-235b at 0.75 temperature produced a consistent, high-quality voice. Now characters bounce between 7 providers with different personalities.

3. **No overhead.** Each turn was instant. Now there are 3-5 meta-LLM calls per turn, each of which can fail.

4. **Simpler prompts.** The character saw the last 12 turns of actual dialogue. Now they see Boru's instructions interspersed, which dilutes the conversational flow.

5. **No moderator steering.** Characters followed their own instincts about what to say. Boru's directives constrain them to specific topics, which can feel forced and repetitive.

---

## Recommendations

### Quick Wins
1. **Make characters see each other's words, not Boru's directives, in their history.** Filter out orchestrator messages from the debate_history passed to character_respond_stream.
2. **Pin character agents to one model** — stop the provider roulette. Use Cerebras as primary, one fallback only.
3. **Reduce Boru's LLM calls** — use heuristic scoring for speaker selection (the original system worked well), reserve LLM calls only for phase transitions and callouts.

### Structural Changes
4. **Hybrid orchestrator** — keep Boru as a personality layer (spoken messages) but use the original heuristic scoring for turn selection. Boru speaks AFTER the character, not before.
5. **Remove parallel debate** — it sounds good in theory but produces worse quality. Sequential streaming is more engaging and easier to debug.
6. **Reduce Boru's speaking frequency** — Boru every 3-4 turns, not every turn. Let characters build momentum.

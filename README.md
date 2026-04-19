<p align="center">
  <h1 align="center">WhatIfSabha</h1>
  <p align="center"><b>Upload a book. Watch the characters debate what could have happened differently — live, in voice, with a moderator who actually runs the room.</b></p>
  <p align="center">
    <img src="https://img.shields.io/badge/python-3.10+-blue?logo=python&logoColor=white" alt="Python 3.10+" />
    <img src="https://img.shields.io/badge/Next.js-16-black?logo=next.js&logoColor=white" alt="Next.js 16" />
    <img src="https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi&logoColor=white" alt="FastAPI" />
    <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" />
    <img src="https://img.shields.io/badge/providers-Gemini%20%7C%20Cerebras%20%7C%20NVIDIA%20%7C%20Groq-orange" alt="LLM providers" />
  </p>
</p>

---

WhatIfSabha is a multi-agent debate engine for alternate story endings. You upload a PDF, WhatIfSabha extracts the characters, and then — given a divergence point — they argue about what would happen next. Live, in character, moderated by a moderator agent (Boru the Elephant) who enforces turn order, tracks unanswered questions, and stages a real reckoning before the debate closes.

The project is a prototype. The engine has been tuned extensively on *Animal Farm*; the long-horizon target is the great epics (Mahabharata, Ramayana, the Iliad) where "what if" has been the subject of commentary for centuries.

---

## What you'll see

Upload *Animal Farm*. Pick the divergence: **"What if Snowball returned?"**

```
Boru: "Snowball walks back into the farm. Napoleon — your move. Speak."

Napoleon: "Traitor. He sold us to Jones once, he'll sell us again..."

Boru: "Clover, you were there both nights. Which nose was in the feed-bin?"

Clover: "Napoleon's. I did not say so at the time because..."

Boru: "Snowball, answer the charge. Did you signal the humans?"

Snowball: "I signalled nothing. And Napoleon knows it..."
```

- A force-directed **interaction graph** renders live: who addresses whom, who asks, who answers.
- An **argument ledger** quietly tracks every claim, every open question, every active dispute.
- Before the closing, Boru runs a **resolution round** — forcing answers to the top still-open questions.
- At the end, a **narrator** synthesizes the alternate ending, and the whole debate can be **exported as a PDF** or **published as a static replay site**.

---

## Quick start

### Prerequisites

- Python 3.10+
- Node 20+
- At least one LLM API key. Free tiers work: Google Gemini, Cerebras, NVIDIA NIM, or Groq.

### With Docker (simplest)

```bash
git clone https://github.com/wadekarg/What-If-Sabha.git whatif-sabha
cd whatif-sabha
cp backend/.env.example backend/.env
# Edit backend/.env — paste at least one API key
docker compose up
```

Open <http://localhost:3000>.

### Local (no Docker)

**Backend:**

```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then paste a key
uvicorn app.main:app --port 8001 --reload
```

**Frontend (new terminal):**

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:3000>. The gear icon in the nav lets you paste/override the API key from the UI without touching `.env`.

---

## Architecture

```
┌──────────────────┐    SSE stream   ┌──────────────────┐
│  Next.js 16      │ ◄───────────────│  FastAPI         │
│  Tailwind 4      │    REST         │  Python 3.10+    │
│  D3 / force-graph│ ◄──────────────►│  uvicorn         │
└──────────────────┘                 └────────┬─────────┘
                                              │
                    ┌─────────────────────────┼─────────────────────┐
                    │                         │                     │
              ┌─────▼──────┐          ┌──────▼──────┐        ┌─────▼──────┐
              │ Character  │          │ Boru        │        │ Narrator   │
              │ Agents     │          │ (moderator) │        │ + Oracle   │
              │ + Observers│          │ + Ledger    │        │            │
              └────────────┘          └─────────────┘        └────────────┘
                            │                 │                      │
              ┌─────────────▼─────────────────▼──────────────────────▼──────┐
              │  LLM router — Gemini · Cerebras · NVIDIA NIM · Groq         │
              │  role-based routing (character / judge / narrator / analysis)│
              │  automatic fallback on rate-limit or error                   │
              └─────────────────────────────────────────────────────────────┘
                                     │
              ┌──────────────────────▼──────────────────────────────────────┐
              │  SQLite (debates, turns, characters)                        │
              │  ChromaDB (per-character RAG over story text)               │
              │  Graphiti + Kuzu (optional character "soul memory")         │
              └─────────────────────────────────────────────────────────────┘
```

**Subprojects:**
- `backend/` — FastAPI, the debate engine, agents, routes, SQLite + ChromaDB state.
- `frontend/` — Next.js 16 app: upload flow, story pages, live streaming debate view, graph, PDF export.
- `replay/` — separate Next.js static-export project; bundles one finished debate into a site you can deploy to Cloudflare Pages.
- `demo/` — standalone HTML demo page.

---

## Debate engine highlights

The moderator (Boru) is the differentiating part of the project. A short tour of what's actually in the code:

- **Enforced invitations.** When Boru names a character (`"Napoleon — your move"`), the engine sets `pending_invitee` and skips heuristic scoring next turn. Boru's word is law.
- **Vocative parser.** Phrases like `"Mrs. Jones, speak"` or `"for Mrs. Jones"` are parsed out of Boru's prose so the intended speaker actually gets the floor. A weighted variant handles character-to-character questions too.
- **Character-to-character question enforcement.** When character A asks character B a direct question, B is pinned as `pending_invitee` for the next turn — even a high-scoring third party is bumped.
- **Observer questions are enforced.** Historical observers (a world_observer_agent) can appear mid-debate; if they address a specific cast member, that person answers next.
- **Dispute lifecycle.** The `ArgumentLedger` tracks claim-vs-claim disputes. Each dispute escalates through tier 2 and tier 3 events; after two `force_confrontation` turns on the same pair the dispute is **retired**, and a **pair cooldown** (≈10 rounds) prevents the same two characters from being pushed back into combat immediately. Stale disputes auto-retire after 10 turns untouched.
- **Silent rotation.** When cast diversity is low (≥40% of characters silent, or three+ have never spoken), Boru actively invites the silent characters. The silence reward scales with debate length (≈+3 early → capped at +12) so latecomers don't stay frozen out.
- **Pair-duel breaker.** After five exchanges dominated by the same two speakers, the engine forces a third voice in to break ping-pong.
- **Phase progression.** `opening → cross_examination → deepening → reckoning → closing`, driven by the ledger state rather than round count alone.
- **Resolution round.** Before closing, the engine forces answers to the top open questions. Configurable count; tracked via `resolution_rounds_used`.
- **Anti-repetition.** Boru's last 5 openers are injected into his own prompt as a "don't start with these" list. Dispute subjects are diversified so the same clash doesn't get re-litigated every turn.
- **Parallelized ledger.** Claim/question/dispute extraction runs alongside the next character's speech — the ledger doesn't block the stream.
- **Hard stop after closing.** Once Boru delivers the closing, no further events fire. Late stage directions are dropped.

All of the above is covered by tests in `backend/tests/` — `test_sabha_orchestrator_return.py`, `test_orchestrator_picker.py`, `test_dispute_retirement.py`, `test_reentry_logic.py`, `test_intended_speaker_parsing.py`, `test_boru_anti_repetition.py`, `test_character_speech_act.py`.

### Content-side agents

- **Character agents** (`character_agent.py`) — situational briefings include story excerpts retrieved per-turn from ChromaDB, the ledger context, recent transcript, and the character's evolving objective vector.
- **Speech-act classifier** (`speech_act.py`) — labels each turn as question / response / statement and extracts the addressed character; the graph uses this to style arrows.
- **Judge agent** (`judge_agent.py`) — optional per-turn character-fidelity and emotion scoring.
- **Narrator agent** (`narrator_agent.py`) — synthesizes the alternate ending using the full ledger, not just the transcript tail.
- **Oracle agent** (`oracle_agent.py`) — post-debate Q&A with any character from the alternate timeline.
- **Character evolution** (`character_evolution.py`) — RL-inspired objective-vector update after each debate, persisted to DB and (optionally) to soul memory.

---

## Replay + sharing

Two ways to share a finished debate:

- **PDF export.** `frontend/app/lib/exportDebate.ts` renders a bound PDF with title page, cast strip, a synthetic force-directed graph, full transcript, and the alternate ending. Uses jsPDF + html2canvas.
- **Static replay site.** `replay/` is a Next.js static export. Run `replay/scripts/export_debate.py --latest` to pull a finished debate out of SQLite into a JSON bundle, then `npm run build` in `replay/` produces `replay/out/` — ready for Cloudflare Pages (config already in `wrangler.toml`). See [`replay/README.md`](replay/README.md) for details.

---

## Running tests

```bash
cd backend
source venv/bin/activate
pytest tests/ -v
```

The backend test suite (~86 tests across 7 files) covers the moderator/picker logic — re-entry triggers, dispute lifecycle, vocative parsing, anti-repetition, speech-act classification, Boru return paths. These are the pieces where regressions matter most; the content agents (character/narrator/judge) are verified by eye.

Replay-site tests:

```bash
cd replay && npm test                                        # state-machine tests
backend/venv/bin/pytest replay/scripts/test_export_debate.py # export bundler
```

---

## Configuration reference

All of this lives in `backend/.env` (see `backend/.env.example`). You only need **one** of the API keys; multiple are used for failover.

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Google Gemini — great for analysis / extraction. |
| `CEREBRAS_API_KEY` | Cerebras — ultra-fast character turns. |
| `NVIDIA_API_KEY` | NVIDIA NIM — large selection of free models. |
| `GROQ_API_KEY` | Groq — fast judge/narrator. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Optional paid fallbacks. |
| `DATABASE_URL` | Default: `sqlite+aiosqlite:///./whatif_sabha.db`. |
| `UPLOAD_DIR` | Where PDFs + portraits are stored. Default `./uploads`. |
| `MAX_UPLOAD_SIZE_MB` | Default 50. |
| `ALLOWED_ORIGINS` | CORS list, comma-separated. Default includes `localhost:3000`. |
| `ANALYSIS_MODEL` / `CHARACTER_AGENT_MODEL` / `JUDGE_MODEL` / `NARRATOR_MODEL` | Per-role model IDs. Defaults in `.env.example` are sane; only change if you know the provider. |
| `NVIDIA_JUDGE_MODEL` / `NVIDIA_NARRATOR_MODEL` | NVIDIA-provider overrides. |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | Optional — enables Graphiti-backed persistent character memory. `docker compose up neo4j` starts a local instance. |
| `ENABLE_LIGHTRAG` | Optional — builds a narrative causal graph during upload (adds ~60s). |
| `REDIS_URL` | Optional caching layer. |

**Frontend:**

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_API_URL` | Backend URL. Default `http://localhost:8001`. |

---

## Project structure

```
whatif-sabha/
├── backend/
│   ├── app/
│   │   ├── api/routes/               # debate.py (the big one), characters, story, upload, settings
│   │   ├── core/agents/              # sabha_orchestrator, character_agent, orchestrator,
│   │   │                             # reentry_logic, speech_act, judge, narrator, oracle,
│   │   │                             # world_observer, character_evolution, power_interrogator
│   │   ├── core/character_research/  # Wikipedia + Fair Witness pipeline
│   │   ├── core/rag/                 # ChromaDB embedding + retrieval
│   │   ├── core/memory/              # Graphiti + Kuzu soul memory (optional)
│   │   ├── multi_pass_extractor.py   # story → characters (chunked, for long books)
│   │   ├── story_analyzer.py         # single-pass extraction for short stories
│   │   ├── portrait_generator.py     # Pollinations.ai portraits
│   │   └── tts.py                    # text-to-speech (optional)
│   ├── tests/                        # pytest suite, moderator logic coverage
│   └── .env.example
├── frontend/
│   ├── app/
│   │   ├── components/NavBar.tsx
│   │   ├── lib/exportDebate.ts       # PDF export (jsPDF + synthetic graph)
│   │   └── story/[id]/
│   │       ├── page.tsx              # story overview
│   │       ├── characters/           # cast + per-character pages
│   │       ├── debate/page.tsx       # live streaming debate UI
│   │       ├── debate/[debateId]/    # read-only viewer for finished debates
│   │       └── graph/                # full-size interaction graph
│   └── package.json
├── replay/                           # Next.js static export for Cloudflare Pages
│   ├── app/
│   ├── scripts/export_debate.py      # SQLite → JSON bundler
│   └── README.md
├── demo/                             # standalone HTML demo page
├── docs/
│   ├── superpowers/specs/            # design docs (Boru authority, replay page, …)
│   ├── superpowers/plans/            # implementation plans
│   └── internal/                     # workflow notes
├── docker-compose.yml
├── LICENSE
└── README.md
```

---

## Tested with

| Story | Cast | Example divergences |
|---|---|---|
| *Animal Farm* | Napoleon, Snowball, Boxer, Squealer, Clover, Benjamin, Mr. Jones | *"What if Snowball returned?"* · *"What if the pigs stayed honest?"* |
| *Hamlet* | Hamlet, Claudius, Gertrude, Ophelia, Horatio | *"What if Hamlet acted on the ghost immediately?"* |
| Any PDF | Auto-extracted | You write the divergence. |

**Long-horizon target.** The interesting texts are the ones where "what if" is already a tradition: Mahabharata (*what if Karna revealed his lineage before Kurukshetra?*), Ramayana (*what if Ravana returned Sita?*), the Iliad (*what if Achilles chose the long life?*). The multi-pass character extractor is built for exactly these — not yet end-to-end tested on the full texts.

---

## Known limitations

This is an early prototype; expect rough edges.

- **Narrator prose quality.** The alternate-ending narrator currently produces analytical summary prose, not narrative scene-writing. Prompt rewrite is in progress.
- **Mahabharata not yet end-to-end tested** on full-text extraction. The multi-pass extractor works on chapter-sized Animal Farm; the tens-of-thousands-of-shlokas case has not been validated.
- **No RL training loop.** Characters evolve via post-debate objective-vector inference, but there is no policy-gradient loop feeding reward back into future turns.
- **No authentication.** Single-user prototype. Don't put it on the public internet as-is.
- **AI-synthetic test content.** The packaged *Animal Farm* fixtures and default story assets are AI-generated stand-ins, not scans of copyrighted editions. Bring your own PDFs for real runs.
- **ChromaDB + SQLite on disk.** No multi-tenancy; resetting state means clearing `backend/whatif_sabha.db`, `backend/chroma_db/`, and `backend/uploads/`.

---

## Contributing

Issues, ideas, and PRs welcome — this is an early-stage project and the feedback loop on real divergences is the most useful thing.

If something goes wrong, please include:
- the story you uploaded,
- the divergence prompt,
- which provider(s) you had configured.

That's usually enough to reproduce.

---

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Gajanan Wadekar.

---

<p align="center">
  <b>Every story deserves a second hearing in the Sabha.</b>
</p>

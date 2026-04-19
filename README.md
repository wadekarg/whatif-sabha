# 🌟 WhatIfSabha

![Python](https://img.shields.io/badge/python-3.10+-4B8BBE?style=flat-square&logo=python&logoColor=white)
![Next.js](https://img.shields.io/badge/next.js-16-1f1f1f?style=flat-square&logo=next.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/typescript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)
![FastAPI](https://img.shields.io/badge/fastapi-0.115-2A8F7A?style=flat-square&logo=fastapi&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-6B8E4E?style=flat-square)
![Status](https://img.shields.io/badge/status-side--project-D98B4E?style=flat-square)

---

## 💭 The itch

I've always been curious about the books I read. Some endings I just couldn't let go of — I'd keep rewriting them in my head on the bus, or before falling asleep, wondering what the characters would actually say if they got one more round on the stage.

WhatIfSabha is a side project born from that itch. You upload a story, type a "what if", and watch the characters themselves argue it out — hosted by **Boru the Elephant**, who plays moderator. You won't get canon. You'll get a conversation between AI versions of them, which is a different thing, and sometimes a more interesting one.

> 📝 This is a side project — I work on it whenever I get some free time. It's rough in places and that's fine.

---

## 📖 What it does

Upload a PDF. The app pulls out the characters, gives each of them a little brain and some context from the book, and then hands the floor to Boru. You give Boru a divergence point — the "what if" — and the debate begins.

Boru runs the room: calls on people, forces confrontations between contradictions, drags silent characters in, closes the session when things have been said. A narrator at the end writes an alternate ending based on everything that was argued.

The whole thing streams live over SSE, so you watch it unfold turn by turn rather than waiting for a block of text at the end.

A quick taste — *Animal Farm*, with the divergence **"What if Snowball returned?"**

```
Boru: "Snowball walks back into the farm. Napoleon — your move. Speak."

Napoleon: "Traitor. He sold us to Jones once, he'll sell us again..."

Boru: "Clover, you were there both nights. Which nose was in the feed-bin?"

Clover: "Napoleon's. I did not say so at the time because..."

Boru: "Snowball, answer the charge. Did you signal the humans?"

Snowball: "I signalled nothing. And Napoleon knows it..."
```

While this streams, a live **interaction graph** shows who's talking to whom, a quiet **argument ledger** tracks every open question, and before Boru closes the session, he runs a **resolution round** that forces answers to the biggest unanswered things.

---

## 📸 A glimpse

> 🖼️ *Screenshots go here. Replace with your own after running a debate.*
> - `docs/screenshots/upload.png` — character cast after PDF analysis
> - `docs/screenshots/debate.png` — live streaming debate
> - `docs/screenshots/graph.png` — interaction graph
> - `docs/screenshots/export.png` — PDF export first page

---

## 🎬 See it in action

A sample finished debate is hosted as a static replay site — you can scroll through the whole thing without running anything locally.

> 🔗 **Live replay:** *(coming soon — hosted on Cloudflare Pages via the `replay/` subproject)*
>
> 📄 **Sample export PDF:** *(coming soon — see `docs/samples/`)*

---

## ⚡ Quick start

**Prerequisites:** Python 3.10+, Node 20+, and at least one LLM API key (free tiers work — Google Gemini, Cerebras, NVIDIA NIM, or Groq).

### 🐳 With Docker (simplest)

```bash
git clone https://github.com/wadekarg/What-If-Sabha.git whatif-sabha
cd whatif-sabha
cp backend/.env.example backend/.env
# edit backend/.env — paste at least one API key
docker compose up
```

Open <http://localhost:3000>.

### 🛠 Local (no Docker)

Backend:

```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then paste a key
uvicorn app.main:app --port 8001 --reload
```

Frontend (new terminal):

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:3000>. The gear icon in the nav lets you paste/override the API key from the UI without touching `.env`.

---

## 🎭 How the debate works

Boru is the interesting part. He's not just picking the next speaker by score — he's actually enforcing a conversation. A short tour of what's in the code:

- 🎙️ **Pending-invitee enforcement** — when Boru names someone (`"Napoleon — your move"`), that character *is* the next speaker. Heuristic scoring is skipped for the turn. Boru's word is law.
- 🗣️ **Vocative routing** — phrases like `"Mrs. Jones, speak"` or `"for Mrs. Jones"` are parsed out of Boru's prose, so the intended speaker actually gets the floor. Works for character-to-character questions too: if A asks B something directly, B is pinned for the next turn.
- ⚖️ **Dispute lifecycle** — the `ArgumentLedger` tracks claim-vs-claim contradictions, escalates them through a couple of confrontation rounds, and then retires them with a pair cooldown so the same two people aren't shoved back into combat forever. Stale disputes auto-retire after ~10 untouched turns.
- 🌀 **Silent rotation** — if the cast is going quiet (40%+ haven't spoken, or three-plus have never spoken), Boru actively pulls silent characters in. The pull gets stronger the longer someone stays frozen out.
- 🔀 **Pair-duel breaker** — after five exchanges dominated by the same two voices, a third voice is forced in to break the ping-pong.
- 🪜 **Phase progression** — `opening → cross_examination → deepening → reckoning → closing`, driven by the ledger's state rather than raw round count.
- 🎯 **Resolution round** — before the closing, Boru forces answers to the top still-open questions. Configurable count, tracked via `resolution_rounds_used`.
- 🔇 **Anti-repetition** — Boru's last few openers are injected into his own prompt as a "don't start with these" list. Dispute subjects get diversified.
- 🛑 **Hard stop after closing** — once the closing is delivered, no late stage directions slip through.

This whole layer is covered by tests in `backend/tests/` (~86 tests across several files — `test_sabha_orchestrator_return.py`, `test_orchestrator_picker.py`, `test_dispute_retirement.py`, `test_reentry_logic.py`, `test_intended_speaker_parsing.py`, `test_boru_anti_repetition.py`, `test_character_speech_act.py`).

---

## 🎨 Content + export features

Once the debate ends, a few things happen:

- 📝 **Alternate-ending narrator** — synthesizes a prose ending using the full ledger, not just the transcript tail.
- 🔮 **Oracle Q&A** — after the debate closes, you can keep asking any character from the alternate timeline questions; they answer in-character, grounded in what was argued.
- 🌐 **Live interaction graph** — force-directed, updating per turn. Arrows styled by speech act (question vs. response vs. statement), thanks to a small classifier that labels each turn.
- 📄 **PDF export** — `frontend/app/lib/exportDebate.ts` builds a bound PDF with title page, cast strip, a synthetic graph, full transcript, and the alternate ending. (jsPDF + html2canvas.) Good for sharing a single debate without needing a server.
- 🌍 **Static replay site** — `replay/` is a Next.js static export. Run `replay/scripts/export_debate.py --latest` to pull a finished debate from SQLite into a JSON bundle, then `npm run build` in `replay/` gives you `replay/out/` — drop-in deploy to Cloudflare Pages (`wrangler.toml` already there). See [`replay/README.md`](replay/README.md).

---

## 🧠 Stack

- 🐍 **Backend** — Python 3.10+, FastAPI, uvicorn, SSE streaming
- ⚛️ **Frontend** — Next.js 16, TypeScript, Tailwind 4, D3 / force-graph
- 💾 **State** — SQLite (debates, turns, characters) + ChromaDB (per-character RAG over story text). Optional Graphiti + Kuzu for persistent character "soul memory".
- 🤖 **LLMs** — a provider router across **Gemini · Cerebras · NVIDIA NIM · Groq**, with role-based routing (character / judge / narrator / analysis) and automatic failover on rate-limit. Anthropic/OpenAI work as optional paid fallbacks.

**Subprojects:**

- `backend/` — FastAPI app, debate engine, agents, routes, persistence
- `frontend/` — Next.js app: upload, story pages, live debate, graph, PDF export
- `replay/` — separate Next.js static export for hosted replays
- `demo/` — standalone HTML demo page

---

## 🧪 Running tests

```bash
cd backend
source venv/bin/activate
pytest tests/ -v

# replay-site tests
cd ../replay && npm test
../backend/venv/bin/pytest scripts/test_export_debate.py
```

The backend suite covers the moderator/picker logic — re-entry triggers, dispute lifecycle, vocative parsing, anti-repetition, speech-act classification, Boru return paths. The content agents (character / narrator / judge) are verified by eye, not by unit tests.

---

## 🛠️ Config reference

Everything lives in `backend/.env` (see `backend/.env.example`). You only need **one** of the API keys; multiple enables failover.

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Google Gemini — good for analysis / extraction |
| `CEREBRAS_API_KEY` | Cerebras — ultra-fast character turns |
| `NVIDIA_API_KEY` | NVIDIA NIM — broad free-tier model selection |
| `GROQ_API_KEY` | Groq — fast judge/narrator |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Optional paid fallbacks |
| `DATABASE_URL` | Default `sqlite+aiosqlite:///./whatif_sabha.db` |
| `UPLOAD_DIR` | Where PDFs + portraits are stored. Default `./uploads` |
| `MAX_UPLOAD_SIZE_MB` | Default 50 |
| `ALLOWED_ORIGINS` | CORS list, comma-separated |
| `ANALYSIS_MODEL` / `CHARACTER_AGENT_MODEL` / `JUDGE_MODEL` / `NARRATOR_MODEL` | Per-role model IDs. Sane defaults in `.env.example` |
| `NVIDIA_JUDGE_MODEL` / `NVIDIA_NARRATOR_MODEL` | NVIDIA-provider overrides |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | Optional — enables Graphiti-backed character memory |
| `ENABLE_LIGHTRAG` | Optional — builds a narrative causal graph at upload (~60s) |
| `REDIS_URL` | Optional caching layer |

**Frontend:**

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_API_URL` | Backend URL. Default `http://localhost:8001` |

---

## 📥 What I've tested it on

| Story | Cast | Example divergences |
|---|---|---|
| *Animal Farm* | Napoleon, Snowball, Boxer, Squealer, Clover, Benjamin, Mr. Jones | *"What if Snowball returned?"* · *"What if the pigs stayed honest?"* |
| *Hamlet* | Hamlet, Claudius, Gertrude, Ophelia, Horatio | *"What if Hamlet acted on the ghost immediately?"* |
| Any PDF you upload | Auto-extracted | You write the divergence. |

The multi-pass character extractor handles longer PDFs by chunking, so you can try your own books — just be mindful of the copyright note below.

---

## 🔒 Known limitations

Keeping this honest — it's a side project, not a product.

- **Narrator prose quality is uneven.** The alternate-ending narrator sometimes produces analytical summary instead of scene-writing. Prompt rewrite is in progress.
- **Not every story has been tested end-to-end.** Tuning has focused on short works like *Animal Farm* and *Hamlet*. Longer books may surface rough edges in extraction or pacing.
- **No authentication.** Single-user prototype — don't put it on the public internet as-is.
- **SQLite + ChromaDB on disk.** No multi-tenancy. Resetting state means clearing `backend/whatif_sabha.db`, `backend/chroma_db/`, and `backend/uploads/`.
- **AI-synthetic default fixtures.** The packaged test assets are AI-generated stand-ins, not scans of copyrighted editions. Bring your own PDFs for real runs.
- **Rate limits on free tiers.** Depending on which provider you're using, a long debate can bump into per-minute limits. The router falls back to other configured providers automatically, but if only one key is set you may see slowdowns.

---

## ⚖️ On the content

Everything a debate produces is AI-generated. The characters you see arguing are language models role-playing based on the PDF you upload — nothing they say appears in the source book, and none of it should be quoted as the author's words.

The demo debates in this repo were tested on George Orwell's **Animal Farm**, which entered the public domain in 2021 (US / UK / most EU jurisdictions after Orwell's life + 70 years). If you want to try the app on a book, please stick to works that are public domain or that you have permission to use. WhatIfSabha doesn't ship with any book — you upload your own PDF.

If you believe this project uses something it shouldn't, open an issue and I'll address it.

---

## 👋 A side-project note

I work on this in spare time, between other things. It started as a small curiosity — what if the characters themselves could argue about an alternate ending? — and it's grown in the directions I've been curious about on whatever given weekend. That means some parts are very polished (the moderator, the dispute ledger, the test suite around them) and some parts are rough (narrator prose, UI polish in places, docs). Issues and ideas are very welcome. If something breaks, drop the story, divergence, and provider combo in the issue — that's usually enough to reproduce.

---

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Gajanan Wadekar.

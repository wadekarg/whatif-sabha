# ☸ WhatIfSabha

### Upload any book. Watch the characters debate what would have happened differently.

---

WhatIfSabha extracts characters from any story (PDF), researches their personalities, generates portraits, and then drops them into a live debate where they argue about an alternate "what if" scenario — in character, with emotions, conflict, and consequences.

You ask: *"What if the pigs had not become corrupted?"*
Napoleon, Snowball, Boxer, and Mr. Jones argue about it. Live. With streaming text, interaction graphs, and a detailed summary at the end.

---

## How It Works

```
Upload PDF  ──>  AI extracts characters  ──>  Research + Portraits
                                                      │
                                                      ▼
              Pick a "what if" scenario  ──>  Characters debate LIVE
                                                      │
                                                      ▼
                                          Detailed debate report
```

**Step 1 — Upload.** Drop in a PDF of any story — a novel, a play, a short story. The AI reads the full text, identifies characters, researches their motivations, and generates storybook-style portraits.

**Step 2 — What If?** Pick a divergence point. The AI suggests some, or write your own. *"What if Romeo never met Juliet?" "What if Dracula chose peace?" "What if the Ring was never found?"*

**Step 3 — The Sabha.** Characters debate your scenario live. They argue, challenge each other, ask hard questions, imagine consequences, and explore the alternate future — all in character, with their own voice, emotions, and blind spots. An interaction graph shows who's talking to whom in real-time.

**Step 4 — The Report.** A detailed summary captures who said what, where they clashed, what questions were answered, what was left unresolved, and what the alternate future would actually look like.

---

## Quick Start

**You only need ONE API key.** Any provider works. Pick whichever you already have.

| Provider | Get a key | Cost |
|----------|-----------|------|
| Google Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Free tier |
| Groq | [console.groq.com/keys](https://console.groq.com/keys) | Free tier |
| Cerebras | [cloud.cerebras.ai](https://cloud.cerebras.ai) | Free tier |
| NVIDIA NIM | [build.nvidia.com](https://build.nvidia.com) | Free tier |
| Anthropic (Claude) | [console.anthropic.com](https://console.anthropic.com/settings/keys) | Paid |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | Paid |

### With Docker (recommended)

```bash
git clone https://github.com/your-username/whatif-sabha.git
cd whatif-sabha
cp backend/.env.example backend/.env
docker compose up
```

Open **http://localhost:3000** — click the gear icon (⚙) — paste your API key — done.

### Without Docker

**Backend:**
```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --port 8001
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:3000** — click ⚙ — paste your API key — start debating.

---

## Features

### Multi-Agent Debate Engine
Each character is an independent AI agent with their own personality, knowledge, emotions, and blind spots. They don't just recite facts — they argue, deflect, confess, and surprise.

### Live Streaming
Debate streams token-by-token. You watch characters think and speak in real-time, not wait for a wall of text.

### Interaction Graph
A D3.js force-directed graph shows who is talking to whom, who's asking questions, and where the heat is. Updated live as the debate unfolds.

### Fair Witness System
Characters who are typically portrayed unfairly (villains, antagonists) get a "Fair Witness" analysis — the AI researches what a more charitable reading of their actions would look like, giving them a richer voice in debate.

### Character Portraits
AI-generated storybook-style portraits for every character, created automatically during analysis.

### Debate Summary
A detailed report at the end: who said what, the fiercest clashes, questions answered and unanswered, and what the alternate future would actually look like.

### Single-Key Mode
Don't want to manage 6 API keys? One key from any supported provider runs the entire app — characters, judge, narrator, analysis, everything.

### Multi-Provider Fallback
For power users: configure multiple providers and the app automatically routes each role to the optimal one (Cerebras for speed, Gemini for analysis, Groq for judging) with automatic fallback on rate limits.

---

## Architecture

```
┌─────────────┐     SSE streaming      ┌──────────────┐
│   Next.js    │ ◄──────────────────── │   FastAPI     │
│   Frontend   │ ────────────────────► │   Backend     │
└─────────────┘     REST API           └──────┬───────┘
                                              │
                    ┌─────────────────────────┼──────────────────┐
                    │                         │                  │
              ┌─────▼─────┐          ┌───────▼───────┐  ┌──────▼──────┐
              │ Character  │          │    Judge      │  │  Narrator   │
              │  Agents    │          │    Agent      │  │   Agent     │
              │ (per char) │          │ (scores each  │  │ (summary +  │
              │            │          │  turn)        │  │  report)    │
              └────────────┘          └───────────────┘  └─────────────┘
                    │                         │                  │
              ┌─────▼──────────────────────────▼──────────────────▼────┐
              │              LLM Provider Layer                        │
              │  Cerebras │ Claude │ OpenAI │ Gemini │ Groq │ NVIDIA  │
              │        (automatic routing + fallback)                  │
              └───────────────────────────────────────────────────────┘
```

**Backend:** FastAPI, SQLite, ChromaDB (vector search), LangChain

**Frontend:** Next.js, D3.js, Tailwind CSS, SSE streaming

**LLM Providers:** Cerebras, Anthropic (Claude), OpenAI, Google Gemini, Groq, NVIDIA NIM, GitHub Models, Cloudflare Workers AI — with automatic fallback chains

---

## The Debate Engine

Each debate turn:

1. **Speaker selection** — heuristic scoring (0 LLM calls) picks who speaks next based on recency, relevance, and unanswered questions
2. **Character speaks** — streams live, with emotion and personality, targeting specific other characters
3. **Judge evaluates** — scores quality, detects emotion, identifies who was addressed
4. **Ledger tracks** — argument tracking system records claims, positions, questions asked/answered
5. **Boru moderates** — the elephant host intervenes only when needed: phase transitions, stalls, repetition callouts

Debate phases: **Opening → Cross-Examination → Deepening → Reckoning → Closing**

Per-turn LLM calls: **2-3** (character + judge, ledger every 2nd turn). Judge and ledger run in parallel.

---

## Tested With

- **Animal Farm** — Napoleon, Snowball, Boxer, Mr. Jones, Squealer debate alternate scenarios
- **Hamlet** — Hamlet, Claudius, Ophelia, Horatio explore what-ifs
- Works with any English-language story in PDF format

The long-term vision: **Mahabharata** — where the what-if questions have been debated for millennia.

---

## Project Structure

```
whatif-sabha/
├── backend/
│   ├── app/
│   │   ├── api/routes/          # REST + SSE endpoints
│   │   ├── core/agents/         # Character, Judge, Narrator, Orchestrator agents
│   │   ├── core/character_research/  # Wikipedia + web research pipeline
│   │   ├── core/rag/            # ChromaDB embeddings
│   │   ├── db/                  # SQLAlchemy models
│   │   └── config.py            # LLM provider routing + fallbacks
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── app/                     # Next.js pages
│   │   ├── components/          # NavBar, Settings
│   │   └── story/[id]/          # Story, Characters, Debate pages
│   └── package.json
├── docker-compose.yml
└── README.md
```

---

## Configuration

All configuration is optional. The app works with just one API key entered through the browser UI.

For advanced users, see `backend/.env.example` for all available settings including:
- Model selection per role (analysis, character, judge, narrator)
- Neo4j for persistent character memory across debates
- LightRAG for narrative causal graphs
- Redis for caching

---

## Contributing

This is an early-stage project. Issues, ideas, and PRs are welcome.

---

## License

MIT

---

**Built with curiosity by [Gaj](https://github.com/your-username)** — because every story deserves a second chance.

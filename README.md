<p align="center">
  <h1 align="center">☸ WhatIfSabha</h1>
  <p align="center"><b>Upload any book. Watch the characters debate what would have happened differently.</b></p>
  <p align="center">
    <img src="https://img.shields.io/badge/python-3.10+-blue?logo=python&logoColor=white" alt="Python 3.10+" />
    <img src="https://img.shields.io/badge/Next.js-15-black?logo=next.js&logoColor=white" alt="Next.js" />
    <img src="https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi&logoColor=white" alt="FastAPI" />
    <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" />
    <img src="https://img.shields.io/badge/LLMs-6_providers-orange" alt="6 LLM Providers" />
    <img src="https://img.shields.io/badge/API_keys_needed-just_1-brightgreen" alt="Just 1 API Key" />
  </p>
</p>

---

WhatIfSabha extracts characters from any story (PDF), researches their personalities, generates portraits, and then drops them into a **live debate** where they argue about an alternate "what if" scenario — in character, with emotions, conflict, and consequences.

> *You ask: "What if the pigs had not become corrupted?"*
>
> *Napoleon, Snowball, Boxer, and Mr. Jones argue about it. Live. With streaming text, interaction graphs, and a detailed war-correspondent-style report at the end.*

---

## 🎯 How It Works

```
📄 Upload PDF  ──►  🔍 AI extracts characters  ──►  📚 Research + 🎨 Portraits
                                                              │
                                                              ▼
                    💡 Pick a "what if" scenario  ──►  ⚡ Characters debate LIVE
                                                              │
                                                              ▼
                                                    📝 Detailed debate report
```

| Step | What Happens |
|------|-------------|
| **📄 Upload** | Drop a PDF of any story — novel, play, short story. AI reads the full text, identifies characters, and generates storybook-style portraits. |
| **🔍 Research** | Each character is researched via Wikipedia, web sources, and multi-perspective AI analysis. RAG (Retrieval-Augmented Generation) retrieves relevant story passages from ChromaDB to ground each character in actual quotes and scenes. |
| **💡 What If?** | Pick a divergence point. AI suggests some, or write your own. *"What if Romeo never met Juliet?" "What if Dracula chose peace?" "What if the Ring was never found?"* |
| **⚡ The Sabha** | Characters debate live — arguing, challenging, confessing, imagining consequences. An interaction graph shows who's talking to whom in real-time. |
| **📝 The Report** | A detailed summary: who said what, fiercest clashes, questions answered and unanswered, and what the alternate future would actually look like. |

---

## 🚀 Quick Start

> **You only need ONE API key.** Any provider works. Pick whichever you already have.

| Provider | Get a key | Cost | Speed |
|----------|-----------|------|-------|
| 🟢 Google Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | **Free** | Fast |
| 🟢 Groq | [console.groq.com/keys](https://console.groq.com/keys) | **Free** | Very fast |
| 🟢 Cerebras | [cloud.cerebras.ai](https://cloud.cerebras.ai) | **Free** | Ultra fast |
| 🟢 NVIDIA NIM | [build.nvidia.com](https://build.nvidia.com) | **Free** | Fast |
| 🟡 Anthropic (Claude) | [console.anthropic.com](https://console.anthropic.com/settings/keys) | Paid | Best quality |
| 🟡 OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | Paid | Reliable |

### 🐳 With Docker (recommended)

```bash
git clone https://github.com/wadekarg/What-If-Sabha.git
cd What-If-Sabha
cp backend/.env.example backend/.env
docker compose up
```

Open **http://localhost:3000** → click ⚙ → paste your API key → done.

### 💻 Without Docker

<details>
<summary><b>Manual setup instructions</b></summary>

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

Open **http://localhost:3000** → click ⚙ → paste your API key → start debating.

</details>

---

## ✨ Features

### 🤖 Multi-Agent Debate Engine
Each character is an independent AI agent with their own personality, knowledge, emotions, and blind spots. They don't just recite facts — they argue, deflect, confess, and surprise. Characters find the cracks in each other's arguments and push into the consequences.

### 📡 Live Streaming
Debate streams token-by-token. You watch characters think and speak in real-time, not wait for a wall of text.

### 🕸️ Interaction Graph
A D3.js force-directed graph shows who is talking to whom, who's asking questions, and where the heat is. Multiple arrows per turn — a character can respond to one person while challenging another. Updated live.

### 🔍 RAG-Powered Character Knowledge
Story text is chunked and embedded into ChromaDB during upload. When characters are extracted, relevant passages are retrieved to ground their profiles in actual quotes, scenes, and relationships from the text. Character chat also uses RAG to reference specific story moments.

### ⚖️ Fair Witness System
Characters typically portrayed unfairly (villains, antagonists) get a "Fair Witness" analysis — AI researches what a more charitable reading of their actions would look like, giving them a richer, more nuanced voice in debate.

### 🎨 Character Portraits
AI-generated storybook-style portraits for every character, created automatically via Pollinations.ai (free, no API key needed).

### 📝 War-Correspondent Debate Report
A detailed 800-1200 word report at the end, structured as: Opening Salvos → Central Fight → Turning Point → Questions Answered → Questions Unanswered → What the Future Looks Like. Written like a journalist who was in the room, not a professor reading a transcript.

### 🐘 Boru — The Elephant Moderator
Boru the Elephant hosts every debate. He opens the Sabha, manages phase transitions, calls out repetition, redirects when characters dodge questions, and stirs the pot when things get too harmonious. He speaks only when needed — the characters are the stars.

### 🔑 Single-Key Mode
One key from any supported provider runs the entire app — characters, judge, narrator, analysis, everything. No multi-provider setup required.

### 🔄 Multi-Provider Fallback
For power users: configure multiple providers and the app automatically routes each role to the optimal one — Cerebras for character speed, Gemini for deep analysis, Groq for fast judging — with automatic fallback on rate limits.

---

## 🏗️ Architecture

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
              └──────────────────────────┬────────────────────────────┘
                                         │
              ┌──────────────────────────▼────────────────────────────┐
              │              Data Layer                                │
              │  ChromaDB (RAG) │ SQLite │ Neo4j (memory) │ Redis    │
              └───────────────────────────────────────────────────────┘
```

| Layer | Tech |
|-------|------|
| **Frontend** | Next.js, D3.js, Tailwind CSS, SSE streaming |
| **Backend** | FastAPI, LangChain, Pydantic |
| **Vector Search (RAG)** | ChromaDB + sentence-transformers (`all-MiniLM-L6-v2`) |
| **Database** | SQLite (aiosqlite) |
| **Character Memory** | Neo4j + Graphiti (optional — persistent memory across debates) |
| **LLM Providers** | Cerebras, Anthropic, OpenAI, Gemini, Groq, NVIDIA NIM, GitHub Models, Cloudflare |
| **Portraits** | Pollinations.ai (free) |

---

## ⚙️ The Debate Engine

Each debate turn:

| Step | What | LLM Calls | Notes |
|------|------|-----------|-------|
| 1️⃣ | **Speaker selection** | 0 | Heuristic scoring — recency, relevance, unanswered questions |
| 2️⃣ | **Character speaks** | 1 | Streams live with emotion, personality, @target addressing |
| 3️⃣ | **Judge evaluates** | 1 | Scores quality, detects emotion, identifies targets |
| 4️⃣ | **Ledger tracks** | 0-1 | Records claims, positions, questions (every 2nd turn) |
| 5️⃣ | **Boru moderates** | 0-1 | Only when needed: phase changes, stalls, repetition |

> Judge and ledger run **in parallel** — halves the silence between speakers.

**Debate Phases:** `Opening` → `Cross-Examination` → `Deepening` → `Reckoning` → `Closing`

**Per-turn cost:** 2-3 LLM calls. A full debate of 30+ turns completes in minutes, not hours.

---

## 📖 Tested With

| Story | Characters | What-If Examples |
|-------|-----------|-----------------|
| 🐷 **Animal Farm** | Napoleon, Snowball, Boxer, Squealer, Mr. Jones, Clover, Benjamin | "What if the pigs had not become corrupted?" |
| 💀 **Hamlet** | Hamlet, Claudius, Ophelia, Horatio, Gertrude | "What if Hamlet had acted immediately?" |
| 📄 **Any PDF** | Auto-extracted | Write your own what-if scenario |

> 🎯 **The long-term vision:** The great epics and texts where what-if questions have been debated for millennia:
>
> **Mahabharata** — *What if Karna revealed his identity before the war?* **Ramayana** — *What if Ravana returned Sita willingly?* **Bible** — *What if Judas refused?* **Greek Epics** — *What if Achilles chose a long life over glory?* **Shahnameh** — *What if Rostam recognized Sohrab?* **Journey to the West** — *What if Sun Wukong never submitted to the Buddha?*

---

## 📁 Project Structure

```
whatif-sabha/
├── backend/
│   ├── app/
│   │   ├── api/routes/               # REST + SSE endpoints
│   │   ├── core/agents/              # Character, Judge, Narrator, Orchestrator, Observer agents
│   │   ├── core/character_research/  # Wikipedia + web research + Fair Witness pipeline
│   │   ├── core/rag/                 # ChromaDB embeddings + retrieval
│   │   ├── core/memory/              # Neo4j character soul memory (optional)
│   │   ├── db/                       # SQLAlchemy models
│   │   └── config.py                 # LLM provider routing + fallback chains
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── app/
│   │   ├── components/               # NavBar, Settings modal
│   │   ├── config.ts                 # Shared API URL config
│   │   └── story/[id]/               # Story, Characters, Debate, Replay pages
│   └── package.json
├── docker-compose.yml
├── LICENSE
└── README.md
```

---

## 🔧 Configuration

All configuration is **optional**. The app works with just one API key entered through the browser UI.

<details>
<summary><b>Advanced configuration options</b></summary>

See `backend/.env.example` for all available settings:

| Setting | What it does |
|---------|-------------|
| Model IDs | Choose which LLM model runs each role (analysis, character, judge, narrator) |
| Neo4j | Persistent character memory across debates — characters remember what they said before |
| LightRAG | Narrative causal graph extraction during upload |
| Redis | Caching layer for faster repeated queries |

</details>

---

## Known Limitations

This is an early prototype:

- **Narrator prose quality** — the alternate-ending narrator currently produces analytical summaries rather than narrative prose. Prompt rewrite in progress.
- **Mahabharata three-pass extraction** is implemented but not yet end-to-end tested on the full text.
- **No RL reward signal** — character objective vectors are inferred after each debate, but there is no true policy-gradient training loop yet.
- **No automated tests** — manual verification only.

---

## 🤝 Contributing

This is an early-stage project. Issues, ideas, and PRs are welcome.

If something breaks, please open an issue with the story you uploaded and the what-if scenario — it helps reproduce the problem.

---

## 📄 License

MIT — do whatever you want with it.

---

<p align="center">
  <b>Built with curiosity by <a href="https://github.com/wadekarg">@wadekarg</a></b> — because every story deserves a second chance.
</p>

# WhatIfSabha — Replay

A static, shareable replay of a completed debate. Deploys free on Cloudflare Pages.

## Build one replay

From the repo root:

```bash
# 1. Export a completed debate from the backend SQLite
backend/venv/bin/python replay/scripts/export_debate.py --latest
#    (or --debate-id <uuid>)

# 2. Wire the debate into the page (only needed after re-scaffold)
cd replay
DEBATE_UUID=$(ls public/debates/*.json | head -1 | xargs basename | sed 's/\.json$//')
sed -i "s/DEBATE_ID/${DEBATE_UUID}/" app/page.tsx

# 3. Install + build
npm install
npm run build
#    → produces replay/out/
```

## Local preview

```bash
cd replay
npm run dev
# open http://localhost:3100
```

## Deploy

- **GitHub integration (recommended):** connect your GitHub repo to a Cloudflare
  Pages project, set build command `cd replay && npm install && npm run build`,
  output directory `replay/out`, root directory `/`. Pushes to `main` auto-deploy.
- **Manual (Wrangler):**
  ```bash
  npx wrangler pages deploy replay/out --project-name whatif-sabha-replay
  ```

## Tests

```bash
cd replay
npm test          # playback state machine tests
```

```bash
backend/venv/bin/pytest replay/scripts/test_export_debate.py -v
```

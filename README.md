# The Solitary Learner? — Chat Interface

Web-based GPT chat interface for the RCT, with full server-side logging.

**Stack:** Vercel (hosting + serverless functions) + Vercel Postgres (storage) + OpenAI `gpt-5.4-mini`.

---

## What it does

- Students enter a Student ID, then chat with an AI Python tutor.
- API key stays **server-side** (in Vercel env vars). Never exposed to browser.
- **Memory with rolling compression:**
  - Up to 50 messages: full verbatim context sent to the model.
  - Past 50: older messages are folded into a running summary (using `gpt-5.4-nano`, ~$0.001 per compression). The bot always sees `[summary of older stuff] + [last 20 messages verbatim]`.
  - Compression is recursive — the summary itself gets re-summarized as the conversation grows, so memory is unbounded but token cost per call stays roughly flat after compression kicks in.
- **Important for research:** compression only affects what's sent to OpenAI for context. The full raw chat log in your `messages` table is **never altered** — every user message and assistant reply is stored verbatim with `student_id`, `session_id`, `role`, `content`, `timestamp`, `tokens_prompt`, `tokens_completion`, `model`. Your export gets everything.
- You can download all logs (or filtered) as a `.txt` or `.csv` file anytime via a password-protected admin endpoint. The `.txt` export also includes the bot's memory summaries at the end of each session — useful if you want to analyze what context the bot was actually working with.

---

## File structure

```
solitary-learner-chat/
├── api/
│   ├── chat.js          # Main chat endpoint (gpt-5.4-mini, 50-msg memory)
│   ├── export.js        # Admin: download logs as .txt or .csv
│   ├── stats.js         # Admin: usage + estimated cost
│   └── init-db.js       # One-time: create database tables
├── lib/
│   └── db.js            # Database schema
├── public/
│   └── index.html       # Student-facing chat UI (single file)
├── package.json
├── vercel.json
├── .env.example
└── README.md
```

---

## Deployment (one-time setup)

### 1. Get an OpenAI API key

Go to https://platform.openai.com/api-keys → create a new key → save it.

### 2. Push to GitHub

```bash
cd solitary-learner-chat
git init
git add .
git commit -m "Initial commit"
# Create a new private repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/solitary-learner-chat.git
git push -u origin main
```

### 3. Deploy to Vercel

1. Sign up at https://vercel.com (free, use your UIUC GitHub login).
2. Click **Add New → Project** → import your repo.
3. Click **Deploy**. (It will deploy but the database isn't connected yet — that's fine.)

### 4. Add a Postgres database

1. In your Vercel project dashboard → **Storage** tab → **Create Database** → **Postgres**.
2. Pick the free Hobby tier. Connect it to your project.
3. Vercel auto-injects `POSTGRES_URL` and friends into your env. Done.

### 5. Set environment variables

In Vercel dashboard → **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `OPENAI_API_KEY` | your `sk-...` key |
| `ADMIN_PASSWORD` | a long random string (e.g. `openssl rand -hex 24`) |

Click **Redeploy** so they take effect.

### 6. Initialize the database tables

Once, after deploying, run:

```bash
curl -X POST https://YOUR-APP.vercel.app/api/init-db \
  -H "x-admin-password: YOUR_ADMIN_PASSWORD"
```

You should see `{"ok": true}`. The tables are now created.

### 7. Test it

Visit `https://YOUR-APP.vercel.app`, log in with a test student ID like `TEST-001`, send a message. You're live.

---

## Daily use during fieldwork

### Sharing with students

Just give them the URL: `https://YOUR-APP.vercel.app`

Each student logs in with their assigned Student ID. (You decide the format — anything matching `[A-Za-z0-9_-]{3,32}` works, e.g. `KOL-CV-0421`, `TPVC-001`, etc.)

### Downloading chat logs

**All logs as one .txt file:**
```
https://YOUR-APP.vercel.app/api/export?password=YOUR_ADMIN_PASSWORD
```

**One specific student:**
```
https://YOUR-APP.vercel.app/api/export?password=YOUR_ADMIN_PASSWORD&studentId=KOL-CV-0421
```

**As CSV instead (better for Stata/pandas):**
```
https://YOUR-APP.vercel.app/api/export?password=YOUR_ADMIN_PASSWORD&format=csv
```

**Only logs after a date:**
```
https://YOUR-APP.vercel.app/api/export?password=YOUR_ADMIN_PASSWORD&since=2026-06-15
```

The browser will download a file like `chatlogs-2026-04-24T10-30-00.txt`.

### Monitoring usage during fieldwork

```
https://YOUR-APP.vercel.app/api/stats?password=YOUR_ADMIN_PASSWORD
```

Returns JSON with: total students, sessions, messages, **token usage, and estimated cost so far**. Useful to track burn rate against your Weiss Fund budget.

---

## ⚠️ Cost note (important — your Weiss budget)

`gpt-5.4-mini` (released March 2026) is priced at **$0.75/M input tokens, $4.50/M output tokens** — significantly more than `gpt-4o-mini` ($0.15/$0.60).

Rough estimate for your study (800 students in AI arm × ~50 messages × rolling 50-msg context):
- Per student: ~30k input tokens, ~10k output tokens cumulatively
- Per student cost: ~$0.067
- **800 students: ~$54** for the AI calls themselves

This is well under your originally budgeted $800 even at the higher rate. But watch `/api/stats` during pilot/rollout — if students chat much more than expected, costs scale linearly. If you want to cap risk, OpenAI dashboards let you set a hard monthly spending limit.

If budget gets tight, switch the model: in `api/chat.js`, change `const MODEL = 'gpt-5.4-mini'` to `'gpt-5.4-nano'` ($0.20/$1.25). Nano is plenty for tutoring.

---

## Customizing

**System prompt (tutor personality):** Edit `SYSTEM_PROMPT` at the top of `api/chat.js`.

**Summarizer prompt (what gets remembered):** Edit `SUMMARIZER_PROMPT` in `api/chat.js`. Currently tuned for tutoring — preserves topics, code, errors, misconceptions.

**Memory tuning:** In `api/chat.js`:
- `MEMORY_THRESHOLD = 50` — when to start compressing
- `KEEP_RECENT = 20` — how many recent messages stay verbatim after compression
- `SUMMARIZER_MODEL = 'gpt-5.4-nano'` — change to `'gpt-5.4-mini'` for higher-quality summaries (4× more expensive)

**Max input length per message:** Change `MAX_MESSAGE_LENGTH = 4000` in `api/chat.js`.

**UI/branding:** Edit `public/index.html`. The styling is all inline.

---

## Data privacy notes

- IP addresses are SHA-256 hashed (truncated to 16 chars) before storage — never raw.
- The student ID is whatever they type in. **You** decide what those IDs map to in your separate enrollment records.
- Vercel Postgres data is encrypted at rest. Connection over TLS.
- For your IRB documentation: data retention, deletion, and de-identification policies should be set in your protocol — this code stores indefinitely until you delete tables.

---

## Local development (optional)

```bash
npm install
npm install -g vercel
vercel link              # link to your Vercel project
vercel env pull .env.local   # pulls env vars locally
npm run dev              # starts local server at http://localhost:3000
```

---

## Questions / issues

The whole thing is ~600 lines of code split across 4 small files. If something breaks during fieldwork:
- Check Vercel **Logs** tab — every API call is logged there.
- Check `/api/stats` to confirm DB is reachable.
- 99% of issues are env vars not being set, or DB not initialized.

Built for "The Solitary Learner?" · Sharanya Bhattacharya · UIUC

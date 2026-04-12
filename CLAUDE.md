# LearnPal — Continuous Prototype

## What this project is

This is the **Continuous paradigm** prototype of LearnPal, a video-based learning app being built for a between-subjects study comparing 3 AI interaction paradigms:

- **Intermittent** (other repo) — user initiates all interactions
- **Continuous** (this repo) — AI support is persistently present and updates in real time alongside the video
- **Proactive** (future) — system actively intervenes

The study measures **engagement** and **knowledge gain**. Participants watch a fixed YouTube video ("The Essential Main Ideas of Neural Networks" by StatQuest, ID: `CqOfi41LfDw`) and interact with the app. A researcher runs a separate pre/post knowledge test.

---

## Core principle of the Continuous paradigm

AI support is **always present, always updating, always relevant, but never interruptive**.

- The video is the primary activity
- All support features update in sync with video playback
- The learner can engage with any feature at any time
- Nothing pauses the video or forces interaction
- No modals, no hard interruptions

---

## Layout (matches screenshot exactly)

```
┌─────────────────────────────────────────────────────────────────┐
│  Header: Logo | Video title | Provider toggle                   │
├──────────────┬──────────────────────────┬───────────────────────┤
│ LEFT (280px) │ CENTER (flex)            │ RIGHT (320px)         │
│              │                          │                       │
│ Explore      │ Video player (16:9)      │ Pal's Key Word        │
│ Highlights   │                          │ Glossary              │
│              │ ── ── ── ── ── ── ──    │ (live-updating)       │
│              │ Playback controls        │                       │
│ ──────────── │                          │ ── ── ── ── ── ──    │
│              │ Transcript               │                       │
│ Live         │ (scrollable, synced)     │ Ask Pal (chat)        │
│ Question     │                          │                       │
│ Feed         │                          │                       │
└──────────────┴──────────────────────────┴───────────────────────┘
```

---

## Features to implement

### 1. Concept Glossary (right column, top)
- Displays key terms and definitions relevant to the **current video position**
- Updates as the video progresses — new terms appear, old ones stay
- Terms are derived from the transcript up to the current position
- Each entry: **Word** (bold) + timestamp + short definition (1-2 sentences)
- Implementation: pre-generate a `glossary.json` file from the transcript using the AI, keyed by timestamp ranges. Surface entries whose timestamp ≤ current playback position.
- The glossary panel scrolls independently

### 2. Explore Highlights (left column, top)
- Surfaces key ideas and important moments from the **currently watched portion**
- Updates as the video progresses
- Each highlight: a short bullet point (1 sentence) tied to a timestamp
- Clicking a highlight seeks the video to that timestamp
- Implementation: pre-generate a `highlights.json` file from the transcript. Show highlights whose timestamp ≤ current playback position, most recent at top.

### 3. Live Question Feed (left column, bottom)
- Comprehension questions appear automatically in sync with video progress
- A new question surfaces when the video crosses a key timestamp
- The learner can answer, skip, or ignore — nothing is forced
- Questions are NOT modal — they appear inline in the feed panel
- Answered questions stay visible (correct/wrong shown)
- Unanswered questions stay available
- Implementation: pre-generate a `questions.json` file with questions keyed to timestamps. Show questions whose timestamp ≤ current playback position.
- Adaptive difficulty: same logic as intermittent — difficulty increases after 2 consecutive correct answers (1=Conceptual, 2=Applied, 3=Creative), stays same on wrong

### 4. AI Chat (right column, bottom)
- Always available, learner-invoked
- Contextually tied to the current video position and session history
- System prompt includes: current transcript context + quiz history (correct/wrong) + highlights seen
- No Snap to Ask Pal feature in this prototype
- Quick suggestions shown before first message (same as intermittent)

### 5. Transcript (center column, bottom)
- Scrollable, synced to video — active line highlighted
- Clicking a line seeks the video to that timestamp
- Same as intermittent prototype

---

## Pre-generated data files needed

Create these JSON files in `src/data/` by running the transcript through AI once:

### `src/data/glossary.json`
```json
[
  {
    "id": "g1",
    "term": "Neural Network",
    "definition": "A computational model inspired by the human brain, made of interconnected nodes that process information in layers.",
    "timestampSeconds": 30,
    "timestampStr": "0:30"
  }
]
```

### `src/data/highlights.json`
```json
[
  {
    "id": "h1",
    "text": "Neural networks are inspired by biological neurons in the brain.",
    "timestampSeconds": 45,
    "timestampStr": "0:45"
  }
]
```

### `src/data/questions.json`
```json
[
  {
    "id": "q1",
    "question": "What does a neural network take as input?",
    "options": ["Images only", "Numbers", "Text only", "Audio files"],
    "correctIndex": 1,
    "explanation": "Neural networks take numerical inputs — images, text, and audio are all converted to numbers first.",
    "timestampSeconds": 60,
    "timestampStr": "1:00",
    "difficulty": 1
  }
]
```

Generate approximately:
- **15-20 glossary terms** spread across the video
- **20-25 highlights** spread across the video
- **15-20 questions** spread across the video (mix of difficulty 1, 2, 3)

Use the existing `src/data/transcript.json` as the source. Run it through Groq or Ollama to generate all three files in one go.

---

## Visual style

**Keep identical to the Intermittent prototype:**
- Font: Inter (UI), Ubuntu (brand logo only)
- Primary blue: `#0336ff`
- Background: `#edf2fa`
- Text: `#121a3e`
- Border: `#e0e2ea`
- Muted text: `#6b7280`
- Card/panel background: `#fff`
- Type scale: same CSS variables (`--fs-2xs` through `--fs-brand`)

**Differences from Intermittent:**
- 3-column layout (not 2-column)
- No Snap to Ask Pal
- No Quiz modal — questions appear inline in the Live Question Feed
- Glossary panel replaces nothing — it's a new addition on the right
- Highlights panel replaces nothing — new addition on the left

---

## Tech stack (already set up)

- **Frontend**: React + Vite, port **5174**
- **Backend**: Node.js + Express + SQLite, port **3002**
- All backend routes already exist and work: `/api/sessions`, `/api/chat`, `/api/quiz`, `/api/events`, `/api/export`
- AI providers: Groq, Ollama, Claude, OpenAI — all routed through backend
- Behaviour tracking already wired: play/pause/ended/first_interaction/session_end

---

## What's already built (do not rebuild)

- `server/` — entire backend is complete and works
- `src/data/transcript.json` — full transcript
- YouTube player integration
- AI provider switching
- Chat with session context (quiz history + snap history in system prompt)
- Adaptive quiz difficulty logic (QUIZ_DIFFICULTY_LEVELS, buildQuizPrompt, callQuizAPI)
- Researcher panel (participant ID, reset, export CSV)
- Behaviour event logging

---

## What needs to be built

1. **Generate the 3 data files** (`glossary.json`, `highlights.json`, `questions.json`) from the transcript
2. **Glossary component** — render glossary terms, filter by current playback position, animate new entries appearing
3. **Highlights component** — render highlights, filter by position, clicking seeks video
4. **Live Question Feed component** — render questions inline as they unlock, handle answer/skip, show feedback inline, track correct/wrong for adaptive difficulty and session context
5. **Wire everything to `currentPlaybackSeconds`** — all three features gate their content on current video position

---

## Researcher panel

Already built. Top-right corner, 25% opacity (full on hover):
- Participant ID text input (saved to database on change)
- Reset button (clears all state, creates new session, seeks video to 0)
- Export CSV button (downloads `/api/export`)

---

## Study context

- Controlled device (researcher's machine)
- Single video, full watch session
- No time limit
- Participant ID entered by researcher before handing device over
- Empty participant ID = researcher testing session (filtered out during analysis)
- Reset between participants resets all state and creates a new DB session

---

## Running the project

```bash
# Terminal 1 — backend
npm run server

# Terminal 2 — frontend
npm run dev
```

Frontend: http://localhost:5174
Backend: http://localhost:3002

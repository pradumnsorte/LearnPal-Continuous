import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import transcriptRows from './data/transcript.json'
import glossaryData from './data/glossary.json'
import highlightsData from './data/highlights.json'
import questionsData from './data/questions.json'
import brandIcon from './assets/brand-icon.svg'
import palCharacter from './assets/pal-character.svg'

const VIDEO_ID = 'CqOfi41LfDw'

// ─── YouTube API ────────────────────────────────────────────────────────────

let ytApiPromise = null

const loadYouTubeIframeApi = () => {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT)
  if (ytApiPromise) return ytApiPromise

  ytApiPromise = new Promise((resolve) => {
    const previousReady = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousReady === 'function') previousReady()
      resolve(window.YT)
    }
    const existing = document.querySelector('script[src="https://www.youtube.com/iframe_api"]')
    if (!existing) {
      const script = document.createElement('script')
      script.src = 'https://www.youtube.com/iframe_api'
      document.body.appendChild(script)
    }
  })

  return ytApiPromise
}

// ─── AI providers ────────────────────────────────────────────────────────────

const PROVIDERS = { CLAUDE: 'claude', OPENAI: 'openai', GROQ: 'groq', OLLAMA: 'ollama' }
const PROVIDER_CYCLE = [PROVIDERS.CLAUDE, PROVIDERS.OPENAI, PROVIDERS.GROQ, PROVIDERS.OLLAMA]
const PROVIDER_LABELS = {
  [PROVIDERS.CLAUDE]: '✦ Claude',
  [PROVIDERS.OPENAI]: '⬡ GPT-4o',
  [PROVIDERS.GROQ]:   '⚡ Groq',
  [PROVIDERS.OLLAMA]: '🦙 Ollama',
}

const QUICK_SUGGESTIONS = [
  'Give me a summary in simple terms',
  'Explain the topic in simple terms',
  'Explain with real life example',
]

const formatTime = (totalSeconds = 0) => {
  if (!Number.isFinite(totalSeconds)) return '0:00'
  const mins = Math.floor(totalSeconds / 60)
  const secs = Math.floor(totalSeconds % 60)
  return `${mins}:${String(secs).padStart(2, '0')}`
}

// ─── System prompt ───────────────────────────────────────────────────────────

const buildSystemPrompt = (currentSeconds, quizHistory = [], messages = []) => {
  const mins = Math.floor(currentSeconds / 60)
  const secs = Math.floor(currentSeconds % 60)
  const timeStr = `${mins}:${String(secs).padStart(2, '0')}`

  const recentContext = transcriptRows
    .filter((r) => r.seconds <= currentSeconds)
    .slice(-6)
    .map((r) => `[${r.time}] ${r.text}`)
    .join('\n')

  const quizBlock = quizHistory.length > 0
    ? `\nQuiz attempts this session:\n${quizHistory
        .map((q) => `- "${q.question}" — ${q.isCorrect ? 'answered correctly' : 'answered incorrectly'}`)
        .join('\n')}`
    : ''

  const snaps = messages.filter((m) => m.isSnippet && m.snippet)
  const snapBlock = snaps.length > 0
    ? `\nVisual regions the user asked about:\n${snaps
        .map((m) => `- At ${m.snippet.timestampStr}: "${m.snippet.userPrompt || 'asked for explanation'}"`)
        .join('\n')}`
    : ''

  const sessionContext = quizBlock || snapBlock
    ? `\n--- Session context ---${quizBlock}${snapBlock}\n`
    : ''

  return `You are Pal, a friendly learning assistant embedded in LearnPal, a video learning app.

The user is watching: "The Essential Main Ideas of Neural Networks" by StatQuest.
Current video position: ${timeStr}

Recent transcript context:
${recentContext || 'Video just started.'}
${sessionContext}
Help the user understand the video. Be concise (under 150 words unless asked for more), clear, and educational. Use simple language and real-world examples when helpful. Use the session context to personalise your responses — if the user got a quiz question wrong, address that gap.`
}

// ─── AI chat ─────────────────────────────────────────────────────────────────

const callAI = async (provider, messages, currentSeconds, sessionId = null, quizHistory = []) => {
  const systemPrompt = buildSystemPrompt(currentSeconds, quizHistory, messages)
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, messages, systemPrompt, sessionId }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error ?? `Server error ${res.status}`)
  }
  const data = await res.json()
  return data.reply
}

// ─── Quiz generator ───────────────────────────────────────────────────────────

const QUIZ_DIFFICULTY_LEVELS = {
  1: {
    label: 'Conceptual',
    instruction: 'Ask a CONCEPTUAL question — test recall and definition.',
  },
  2: {
    label: 'Applied',
    instruction: 'Ask an APPLIED question — test reasoning and understanding.',
  },
  3: {
    label: 'Creative',
    instruction: 'Ask a CREATIVE question — test synthesis and deep understanding.',
  },
}

const buildQuizPrompt = (currentSeconds, previousQuestions, difficulty) => {
  const watchedRows = transcriptRows.filter((r) => r.seconds <= currentSeconds)
  const transcriptContext = watchedRows.map((r) => `[${r.time}] ${r.text}`).join('\n')
  const level = QUIZ_DIFFICULTY_LEVELS[difficulty]

  const previousBlock = previousQuestions.length > 0
    ? `\n\nDo NOT repeat or closely resemble any of these already-asked questions:\n${previousQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    : ''

  return `You are a quiz generator for an educational video app.

The user has watched this portion of "The Essential Main Ideas of Neural Networks" by StatQuest:
${transcriptContext}${previousBlock}

Difficulty: ${level.label}
${level.instruction}

Generate exactly ONE multiple-choice quiz question.

Respond ONLY with a valid JSON object — no markdown, no explanation, nothing else:
{
  "question": "...",
  "options": ["...", "...", "...", "..."],
  "correctIndex": 0,
  "explanation": "..."
}

Rules:
- Exactly 4 options
- correctIndex is 0-based
- Explanation: 1-2 sentences clarifying why the answer is correct`
}

const callQuizAPI = async (provider, prompt) => {
  const res = await fetch('/api/quiz/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, prompt }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error ?? `Server error ${res.status}`)
  }
  return res.json()
}

const generateQuizQuestion = async (provider, currentSeconds, previousQuestions = [], difficulty = 1) => {
  const watchedRows = transcriptRows.filter((r) => r.seconds <= currentSeconds)
  if (watchedRows.length < 3) {
    throw new Error('Watch a bit more of the video before generating a quiz question.')
  }
  const prompt = buildQuizPrompt(currentSeconds, previousQuestions, difficulty)
  return callQuizAPI(provider, prompt)
}

// ─── Glossary ─────────────────────────────────────────────────────────────────

function Glossary({ currentSeconds }) {
  const [isPaused, setIsPaused] = useState(false)
  const [frozenAt, setFrozenAt] = useState(null)
  const [removedIds, setRemovedIds] = useState(new Set())
  const [pinnedIds, setPinnedIds] = useState(new Set())
  const prevCountRef = useRef(0)
  const [newIds, setNewIds] = useState(new Set())

  const effectiveSeconds = isPaused ? (frozenAt ?? currentSeconds) : currentSeconds
  const visible = glossaryData.filter((g) => g.timestampSeconds <= effectiveSeconds && !removedIds.has(g.id))

  useEffect(() => {
    if (visible.length > prevCountRef.current) {
      const added = visible.slice(prevCountRef.current).map((g) => g.id)
      setNewIds(new Set(added))
      const timer = setTimeout(() => setNewIds(new Set()), 1200)
      prevCountRef.current = visible.length
      return () => clearTimeout(timer)
    }
    prevCountRef.current = visible.length
  }, [visible.length])

  const togglePause = () => {
    if (!isPaused) { setFrozenAt(currentSeconds); setIsPaused(true) }
    else { setFrozenAt(null); setIsPaused(false) }
  }

  const togglePin = (id) => setPinnedIds((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const removeItem = (id) => setRemovedIds((prev) => new Set([...prev, id]))

  const pinned = visible.filter((g) => pinnedIds.has(g.id))
  const unpinned = [...visible.filter((g) => !pinnedIds.has(g.id))].reverse()
  const sorted = [...pinned, ...unpinned]

  return (
    <section className="lp-glossary">
      <div className="lp-glossary-topbar">
        <h2>Pal&apos;s Key Word Glossary</h2>
      </div>
      <div className="lp-glossary-content">
        <div className="lp-section-controls">
          <span className={`lp-live-chip${isPaused ? ' lp-live-chip-paused' : ''}`}>
            {isPaused ? 'Paused' : 'Live sync'}
          </span>
          <button type="button" className="lp-section-stop" onClick={togglePause}>
            {isPaused ? 'Resume' : 'Stop'}
          </button>
        </div>
        {sorted.length === 0 ? (
          <p className="lp-placeholder">Key terms will appear as the video progresses.</p>
        ) : (
          <ul className="lp-glossary-list">
            {sorted.map((g) => (
              <li key={g.id} className={`lp-glossary-item${newIds.has(g.id) ? ' lp-glossary-new' : ''}${pinnedIds.has(g.id) ? ' lp-glossary-pinned' : ''}`}>
                <div className="lp-glossary-header">
                  <span className="lp-glossary-term">
                    {pinnedIds.has(g.id) && <span className="lp-pin-dot" aria-label="Pinned" />}
                    {g.term}
                  </span>
                  <span className="lp-glossary-ts">{g.timestampStr}</span>
                </div>
                <p className="lp-glossary-def">{g.definition}</p>
                <div className="lp-glossary-actions">
                  <button type="button" className="lp-glossary-action-btn" onClick={() => togglePin(g.id)}>
                    {pinnedIds.has(g.id) ? 'Unpin' : 'Pin'}
                  </button>
                  <button type="button" className="lp-glossary-action-btn lp-glossary-remove-btn" onClick={() => removeItem(g.id)}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

// ─── Highlights ───────────────────────────────────────────────────────────────

function Highlights({ currentSeconds, onSeek, onDetailClick }) {
  const [isPaused, setIsPaused] = useState(false)
  const [frozenAt, setFrozenAt] = useState(null)
  const prevCountRef = useRef(0)
  const [newIds, setNewIds] = useState(new Set())

  const effectiveSeconds = isPaused ? (frozenAt ?? currentSeconds) : currentSeconds
  const visible = highlightsData.filter((h) => h.timestampSeconds <= effectiveSeconds)
  const bookmarkItems = [...visible].slice(-4)

  useEffect(() => {
    if (visible.length > prevCountRef.current) {
      const added = visible.slice(prevCountRef.current).map((h) => h.id)
      setNewIds(new Set(added))
      const timer = setTimeout(() => setNewIds(new Set()), 1200)
      prevCountRef.current = visible.length
      return () => clearTimeout(timer)
    }
    prevCountRef.current = visible.length
  }, [visible.length])

  const togglePause = () => {
    if (!isPaused) { setFrozenAt(currentSeconds); setIsPaused(true) }
    else { setFrozenAt(null); setIsPaused(false) }
  }

  return (
    <section className="lp-highlights">
      <div className="lp-section-header-row">
        <h2>Explore highlights</h2>
        <button type="button" className="lp-section-stop" onClick={togglePause}>
          {isPaused ? 'Resume' : 'Hide'}
        </button>
      </div>
      <p className="lp-info-strip">
        {isPaused
          ? 'Highlights paused — other modules continue running.'
          : 'Parts of the video are highlighted as this lesson progresses.'}
      </p>
      {visible.length === 0 ? (
        <p className="lp-placeholder">Highlights will appear as the video progresses.</p>
      ) : (
        <ul className="lp-highlights-list">
          {[...visible].reverse().map((h) => (
            <li
              key={h.id}
              className={`lp-highlight-item${newIds.has(h.id) ? ' lp-highlight-new' : ''}`}
              onClick={() => onSeek(h.timestampSeconds)}
            >
              <div className="lp-highlight-title">
                <span className="lp-highlight-dot" />
                <span>{h.timestampStr}</span>
              </div>
              <span className="lp-highlight-text">{h.text}</span>
              <button
                type="button"
                className="lp-highlight-cta"
                onClick={(e) => { e.stopPropagation(); onDetailClick(h) }}
              >
                Detail
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="lp-bookmarks">
        <div className="lp-bookmarks-title">Bookmarks</div>
        <div className="lp-bookmarks-divider" />
        {bookmarkItems.length === 0 ? (
          <p className="lp-placeholder">No bookmarks yet.</p>
        ) : (
          <ul className="lp-bookmarks-list">
            {bookmarkItems.map((item, idx) => (
              <li key={`bm-${item.id}`}>
                <button type="button" className="lp-bookmark-item" onClick={() => onSeek(item.timestampSeconds)}>
                  <span className="lp-bookmark-index">{idx + 1}.</span>
                  <span className="lp-bookmark-time">{item.timestampStr}</span>
                  <span className="lp-bookmark-text">{item.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

// ─── Live Question Feed ───────────────────────────────────────────────────────

function LiveQuestionFeed({ currentSeconds, onAnswered, onExplainAnswer, quizDifficulty, setQuizDifficulty, consecutiveCorrect, setConsecutiveCorrect }) {
  const [isPaused, setIsPaused] = useState(false)
  const [frozenAt, setFrozenAt] = useState(null)
  const [answers, setAnswers] = useState({})
  const prevCountRef = useRef(0)
  const [newIds, setNewIds] = useState(new Set())
  const optionLabels = ['A', 'B', 'C', 'D']

  const effectiveSeconds = isPaused ? (frozenAt ?? currentSeconds) : currentSeconds
  const unlocked = questionsData.filter((q) => q.timestampSeconds <= effectiveSeconds)

  useEffect(() => {
    if (unlocked.length > prevCountRef.current) {
      const added = unlocked.slice(prevCountRef.current).map((q) => q.id)
      setNewIds(new Set(added))
      const timer = setTimeout(() => setNewIds(new Set()), 1500)
      prevCountRef.current = unlocked.length
      return () => clearTimeout(timer)
    }
    prevCountRef.current = unlocked.length
  }, [unlocked.length])

  const togglePause = () => {
    if (!isPaused) { setFrozenAt(currentSeconds); setIsPaused(true) }
    else { setFrozenAt(null); setIsPaused(false) }
  }

  const selectOption = (qid, idx) => {
    setAnswers((prev) => {
      if (prev[qid]?.submitted) return prev
      return { ...prev, [qid]: { ...prev[qid], selected: idx } }
    })
  }

  const submit = (q) => {
    const state = answers[q.id]
    if (!state || state.selected === null || state.selected === undefined || state.submitted) return
    const isCorrect = state.selected === q.correctIndex
    setAnswers((prev) => ({ ...prev, [q.id]: { ...prev[q.id], submitted: true, isCorrect } }))
    onAnswered(q, isCorrect)
    if (isCorrect) {
      const streak = consecutiveCorrect + 1
      if (streak >= 2 && quizDifficulty < 3) { setQuizDifficulty(quizDifficulty + 1); setConsecutiveCorrect(0) }
      else if (streak >= 2) { setConsecutiveCorrect(0) }
      else { setConsecutiveCorrect(streak) }
    } else {
      setConsecutiveCorrect(0)
    }
  }

  const skipQuestion = (qid) => {
    setAnswers((prev) => ({ ...prev, [qid]: { ...prev[qid], skipped: true } }))
  }

  const displayed = [...unlocked].reverse()

  return (
    <section className="lp-question-feed">
      <div className="lp-section-header-row">
        <h2>Live question feed</h2>
        <button type="button" className="lp-section-stop" onClick={togglePause}>
          {isPaused ? 'Resume' : 'Stop'}
        </button>
      </div>
      <p className="lp-info-strip">
        {isPaused
          ? 'Question feed paused — other modules continue running.'
          : 'Questions update as the lesson progresses. Answer on the go for better comprehension.'}
      </p>
      {displayed.length === 0 ? (
        <p className="lp-placeholder">Questions will appear as you watch.</p>
      ) : (
        <ul className="lp-qfeed-list">
          {displayed.map((q) => {
            const state = answers[q.id] ?? {}
            const isNew = newIds.has(q.id)
            return (
              <li key={q.id} className={`lp-qfeed-item${isNew ? ' lp-qfeed-new' : ''}`}>
                <div className="lp-qfeed-meta">
                  <span className="lp-qfeed-ts">{q.timestampStr}</span>
                  <span className={`lp-qfeed-diff lp-qfeed-diff-${q.difficulty}`}>
                    {q.difficulty === 1 ? 'Conceptual' : q.difficulty === 2 ? 'Applied' : 'Creative'}
                  </span>
                </div>
                <p className="lp-qfeed-question">{q.question}</p>
                <ul className="lp-qfeed-options">
                  {q.options.map((opt, idx) => {
                    let cls = 'lp-qfeed-option'
                    if (state.submitted) {
                      if (idx === q.correctIndex) cls += ' lp-qfeed-correct'
                      else if (idx === state.selected) cls += ' lp-qfeed-wrong'
                    } else if (state.selected === idx) {
                      cls += ' lp-qfeed-selected'
                    }
                    const label = optionLabels[idx] ?? String.fromCharCode(65 + idx)
                    return (
                      <li key={idx}>
                        <button
                          type="button"
                          className={cls}
                          onClick={() => selectOption(q.id, idx)}
                          disabled={!!state.submitted || !!state.skipped}
                        >
                          <span className="lp-option-label">{label}.</span>
                          {opt}
                        </button>
                      </li>
                    )
                  })}
                </ul>
                {!state.submitted && !state.skipped && (
                  <div className="lp-qfeed-actions">
                    <button type="button" className="lp-qfeed-skip" onClick={() => skipQuestion(q.id)}>
                      Skip
                    </button>
                    {state.selected !== null && state.selected !== undefined && (
                      <button type="button" className="lp-qfeed-submit" onClick={() => submit(q)}>
                        Submit
                      </button>
                    )}
                  </div>
                )}
                {state.skipped && !state.submitted && (
                  <div className="lp-qfeed-actions">
                    <p className="lp-qfeed-skipped">Skipped — you can still answer above.</p>
                    {state.selected !== null && state.selected !== undefined && (
                      <button type="button" className="lp-qfeed-submit" onClick={() => submit(q)}>
                        Submit
                      </button>
                    )}
                  </div>
                )}
                {state.submitted && (
                  <>
                    <div className={`lp-qfeed-feedback ${state.isCorrect ? 'lp-qfeed-fb-correct' : 'lp-qfeed-fb-wrong'}`}>
                      <span>{state.isCorrect ? 'Correct!' : 'Not quite.'}</span>
                      <p>{q.explanation}</p>
                    </div>
                    <div className="lp-qfeed-post-actions">
                      <button
                        type="button"
                        className="lp-qfeed-explain-btn"
                        onClick={() => onExplainAnswer(q, state.selected, state.isCorrect)}
                      >
                        Explain this answer
                      </button>
                    </div>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  // Player refs
  const playerHostRef   = useRef(null)
  const playerRef       = useRef(null)
  const playbackPollRef = useRef(null)
  const isPlayingRef    = useRef(false)
  const logEventRef     = useRef(null)
  const firstInteractionLoggedRef = useRef(false)

  // Transcript refs
  const transcriptListRef  = useRef(null)
  const transcriptItemRefs = useRef(new Map())
  const userScrolledRef    = useRef(false)
  const userScrollTimerRef = useRef(null)

  // Chat scroll ref
  const chatBottomRef = useRef(null)

  // Playback state
  const [isPlaying, setIsPlaying]           = useState(false)
  const [duration, setDuration]             = useState(0)
  const [currentPlaybackSeconds, setCurrentPlaybackSeconds] = useState(0)
  const [activeTranscriptId, setActiveTranscriptId]         = useState(transcriptRows[0]?.id ?? '')

  // AI / session state
  const [aiProvider, setAiProvider] = useState(PROVIDERS.GROQ)
  const [sessionId, setSessionId]   = useState(null)
  const [participantId, setParticipantId] = useState('')

  // Chat state
  const [messages, setMessages]   = useState([])
  const [chatInput, setChatInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [aiError, setAiError]     = useState(null)

  // Quiz state (legacy dynamic quiz — kept for system prompt context)
  const [currentQuiz, setCurrentQuiz]         = useState(null)
  const [quizLoading, setQuizLoading]         = useState(false)
  const [quizError, setQuizError]             = useState(null)
  const [selectedOption, setSelectedOption]   = useState(null)
  const [askedQuestions, setAskedQuestions]   = useState([])
  const [quizDifficulty, setQuizDifficulty]   = useState(1)
  const [consecutiveCorrect, setConsecutiveCorrect] = useState(0)
  const [quizHistory, setQuizHistory]         = useState([])
  const [showQuiz, setShowQuiz]               = useState(false)
  const [quizFeedback, setQuizFeedback]       = useState(false)

  // Live question feed state (feeds into quizHistory for chat context)
  const [feedDifficulty, setFeedDifficulty]   = useState(1)
  const [feedConsecCorrect, setFeedConsecCorrect] = useState(0)

  // ── Session creation ───────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: VIDEO_ID, videoTitle: 'The Essential Main Ideas of Neural Networks' }),
    })
      .then((r) => r.json())
      .then((data) => setSessionId(data.id))
      .catch(() => {})
  }, [])

  // ── Event logging ──────────────────────────────────────────────────────────

  const logEvent = useCallback((eventType, playbackSeconds = null) => {
    if (!sessionId) return
    const body = JSON.stringify({ sessionId, eventType, playbackSeconds })
    if (eventType === 'session_end') {
      navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }))
    } else {
      fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).catch(() => {})
    }
  }, [sessionId])

  useEffect(() => { logEventRef.current = logEvent }, [logEvent])

  useEffect(() => {
    const handleUnload = () => {
      logEvent('session_end', playerRef.current?.getCurrentTime?.() ?? null)
    }
    window.addEventListener('beforeunload', handleUnload)
    return () => window.removeEventListener('beforeunload', handleUnload)
  }, [logEvent])

  // ── YouTube player ─────────────────────────────────────────────────────────

  useEffect(() => {
    let disposed = false

    const initPlayer = async () => {
      await loadYouTubeIframeApi()
      if (disposed || !playerHostRef.current) return

      playerRef.current = new window.YT.Player(playerHostRef.current, {
        videoId: VIDEO_ID,
        playerVars: { controls: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: (e) => {
            const d = e.target.getDuration()
            if (d > 0) setDuration(d)
          },
          onStateChange: (e) => {
            const playing = e.data === 1
            const ended   = e.data === 0
            isPlayingRef.current = playing
            setIsPlaying(playing)
            const pos = e.target.getCurrentTime?.() ?? null
            if (playing) logEventRef.current?.('video_play', pos)
            else if (ended) logEventRef.current?.('video_ended', pos)
            else logEventRef.current?.('video_pause', pos)
          },
        },
      })

      playbackPollRef.current = window.setInterval(() => {
        const player = playerRef.current
        if (!player || typeof player.getCurrentTime !== 'function') return
        const t = player.getCurrentTime()
        setCurrentPlaybackSeconds(t)
      }, 500)
    }

    initPlayer()
    return () => {
      disposed = true
      window.clearInterval(playbackPollRef.current)
      playerRef.current?.destroy?.()
      playerRef.current = null
    }
  }, [])

  // ── Transcript auto-scroll ─────────────────────────────────────────────────

  useEffect(() => {
    if (userScrolledRef.current) return
    const active = transcriptRows
      .filter((r) => r.seconds <= currentPlaybackSeconds)
      .at(-1)
    if (!active) return
    setActiveTranscriptId(active.id)
    const el = transcriptItemRefs.current.get(active.id)
    if (el && transcriptListRef.current) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [currentPlaybackSeconds])

  const setTranscriptItemRef = (id, node) => {
    if (node) transcriptItemRefs.current.set(id, node)
    else transcriptItemRefs.current.delete(id)
  }

  // ── Chat auto-scroll ───────────────────────────────────────────────────────

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ── Chat ───────────────────────────────────────────────────────────────────

  const sendMessage = useCallback(async (content) => {
    const clean = content.trim()
    if (!clean || isLoading) return

    const userMsg  = { role: 'user', content: clean }
    const updated  = [...messages, userMsg]
    setMessages(updated)
    setChatInput('')
    setAiError(null)
    setIsLoading(true)

    if (!firstInteractionLoggedRef.current) {
      firstInteractionLoggedRef.current = true
      logEvent('first_interaction', currentPlaybackSeconds)
    }

    try {
      const reply = await callAI(
        aiProvider,
        updated.map(({ role, content: c }) => ({ role, content: c })),
        currentPlaybackSeconds,
        sessionId,
        quizHistory
      )
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }])
    } catch (err) {
      setAiError(err.message)
    } finally {
      setIsLoading(false)
    }
  }, [messages, isLoading, aiProvider, currentPlaybackSeconds, sessionId, quizHistory, logEvent])

  // ── Quiz ───────────────────────────────────────────────────────────────────

  const fetchQuiz = async (prevQuestions) => {
    setQuizLoading(true)
    setQuizError(null)
    setCurrentQuiz(null)
    setSelectedOption(null)
    setQuizFeedback(false)
    try {
      const q = await generateQuizQuestion(aiProvider, currentPlaybackSeconds, prevQuestions, quizDifficulty)
      setCurrentQuiz(q)
      setAskedQuestions((prev) => [...prev, q.question])
    } catch (err) {
      setQuizError(err.message)
    } finally {
      setQuizLoading(false)
    }
  }

  const submitQuiz = () => {
    if (selectedOption === null) return
    setQuizFeedback(true)
    const isCorrect = selectedOption === currentQuiz.correctIndex
    setQuizHistory((prev) => [...prev, { question: currentQuiz.question, isCorrect }])
    if (isCorrect) {
      const newStreak = consecutiveCorrect + 1
      if (newStreak >= 2 && quizDifficulty < 3) {
        setQuizDifficulty(quizDifficulty + 1)
        setConsecutiveCorrect(0)
      } else if (newStreak >= 2) {
        setConsecutiveCorrect(0)
      } else {
        setConsecutiveCorrect(newStreak)
      }
    } else {
      setConsecutiveCorrect(0)
    }
    if (sessionId && currentQuiz) {
      fetch('/api/quiz/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          question: currentQuiz.question,
          options: currentQuiz.options,
          correctIndex: currentQuiz.correctIndex,
          selectedIndex: selectedOption,
          isCorrect,
          difficulty: quizDifficulty,
          provider: aiProvider,
        }),
      }).catch(() => {})
    }
  }

  // ── Live Question Feed handler ────────────────────────────────────────────

  const handleFeedAnswered = useCallback((q, isCorrect) => {
    setQuizHistory((prev) => [...prev, { question: q.question, isCorrect }])
    if (sessionId) {
      fetch('/api/quiz/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          question: q.question,
          options: q.options,
          correctIndex: q.correctIndex,
          selectedIndex: null,
          isCorrect,
          difficulty: q.difficulty,
          provider: aiProvider,
        }),
      }).catch(() => {})
    }
    if (!firstInteractionLoggedRef.current) {
      firstInteractionLoggedRef.current = true
      logEvent('first_interaction', currentPlaybackSeconds)
    }
  }, [sessionId, aiProvider, currentPlaybackSeconds, logEvent])

  // ── Highlight Detail → Chat ───────────────────────────────────────────────

  const handleHighlightDetail = useCallback((h) => {
    const msg = `I'm watching at ${h.timestampStr} and want a deeper explanation of this concept from the video: "${h.text}" — can you explain it in detail with a simple real-life example?`
    sendMessage(msg)
  }, [sendMessage])

  // ── Explain Answer → Chat ─────────────────────────────────────────────────

  const handleExplainAnswer = useCallback((q, selectedIdx, isCorrect) => {
    const chosen = q.options[selectedIdx]
    const correct = q.options[q.correctIndex]
    const msg = isCorrect
      ? `At ${q.timestampStr} I answered this question correctly: "${q.question}" — I chose "${chosen}". Can you explain in simple terms why this is the right answer?`
      : `At ${q.timestampStr} I answered this question: "${q.question}" — I chose "${chosen}" but the correct answer is "${correct}". Can you explain why "${correct}" is correct and where my thinking went wrong?`
    sendMessage(msg)
  }, [sendMessage])

  const submitQuickSuggestion = (text) => {
    sendMessage(text)
  }

  // ── Researcher controls ────────────────────────────────────────────────────

  const saveParticipantId = (id) => {
    if (!sessionId) return
    fetch(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantId: id }),
    }).catch(() => {})
  }

  const resetSession = () => {
    playerRef.current?.pauseVideo?.()
    playerRef.current?.seekTo?.(0, true)
    setMessages([])
    setAiError(null)
    setChatInput('')
    setCurrentQuiz(null)
    setQuizError(null)
    setSelectedOption(null)
    setAskedQuestions([])
    setQuizDifficulty(1)
    setConsecutiveCorrect(0)
    setQuizHistory([])
    setShowQuiz(false)
    setQuizFeedback(false)
    setFeedDifficulty(1)
    setFeedConsecCorrect(0)
    firstInteractionLoggedRef.current = false
    setParticipantId('')
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: VIDEO_ID, videoTitle: 'The Essential Main Ideas of Neural Networks' }),
    })
      .then((r) => r.json())
      .then((data) => setSessionId(data.id))
      .catch(() => {})
  }

  const progressPct = duration > 0
    ? Math.min(100, (currentPlaybackSeconds / duration) * 100)
    : 0
  const currentTimeStr = formatTime(currentPlaybackSeconds)
  const durationStr = formatTime(duration)

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="lp-root">

      {/* Header */}
      <header className="lp-header">
        <div className="lp-brand">
          <img src={brandIcon} alt="LearnPal" className="lp-brand-icon" />
          <span className="lp-brand-name">
            <span className="lp-brand-learn">Learn</span>
            <span className="lp-brand-pal">Pal</span>
          </span>
        </div>
        <button
          type="button"
          className="lp-provider-toggle"
          onClick={() =>
            setAiProvider((p) => {
              const idx = PROVIDER_CYCLE.indexOf(p)
              return PROVIDER_CYCLE[(idx + 1) % PROVIDER_CYCLE.length]
            })
          }
        >
          {PROVIDER_LABELS[aiProvider]}
        </button>
      </header>

      {/* Main layout */}
      <main className="lp-main">
        <aside className="lp-utility-rail" aria-label="Primary navigation">
          <button type="button" className="lp-rail-btn" aria-label="Menu">
            <span className="lp-icon lp-icon-menu" aria-hidden="true" />
          </button>
          <div className="lp-rail-bottom">
            <button type="button" className="lp-rail-btn" aria-label="Settings">
              <span className="lp-icon lp-icon-gear" aria-hidden="true" />
            </button>
            <button type="button" className="lp-rail-avatar" aria-label="Profile">
              <span className="lp-icon lp-icon-user" aria-hidden="true" />
            </button>
          </div>
        </aside>

        <div className="lp-workspace">

          {/* ── Center column: Video + [Highlights | Questions] + Transcripts ── */}
          <div className="lp-center-col">
            <section className="lp-video-panel">
              <div className="lp-video-topbar">
                <h2 className="lp-video-panel-title">The Essential Main Ideas of Neural Networks</h2>
              </div>
              <div className="lp-video-frame">
                <div ref={playerHostRef} className="lp-player" />
              </div>
              <div className="lp-video-controls">
                <div className="lp-progress-track">
                  <span className="lp-progress-fill" style={{ width: `${progressPct}%` }} />
                </div>
                <div className="lp-video-controls-row">
                  <div className="lp-control-group">
                    <button type="button" className="lp-control-btn" aria-label="Play">
                      <span className="lp-icon lp-icon-play" aria-hidden="true" />
                    </button>
                    <button type="button" className="lp-control-btn" aria-label="Volume">
                      <span className="lp-icon lp-icon-volume" aria-hidden="true" />
                    </button>
                    <button type="button" className="lp-control-btn" aria-label="Rewind">
                      <span className="lp-icon lp-icon-back" aria-hidden="true" />
                    </button>
                    <button type="button" className="lp-control-btn" aria-label="Forward">
                      <span className="lp-icon lp-icon-forward" aria-hidden="true" />
                    </button>
                    <span className="lp-video-time">{currentTimeStr} / {durationStr}</span>
                  </div>
                  <div className="lp-control-group">
                    <button type="button" className="lp-control-btn" aria-label="Captions">
                      <span className="lp-icon lp-icon-cc" aria-hidden="true" />
                    </button>
                    <button type="button" className="lp-control-btn" aria-label="Speed">
                      <span className="lp-icon lp-icon-speed" aria-hidden="true" />
                    </button>
                    <button type="button" className="lp-control-btn" aria-label="Settings">
                      <span className="lp-icon lp-icon-gear" aria-hidden="true" />
                    </button>
                    <button type="button" className="lp-control-btn" aria-label="Fullscreen">
                      <span className="lp-icon lp-icon-fullscreen" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>
            </section>

            {/* Highlights + Question Feed side by side below video */}
            <div className="lp-secondary-row">
              <Highlights
                currentSeconds={currentPlaybackSeconds}
                onSeek={(t) => {
                  playerRef.current?.seekTo?.(t, true)
                  playerRef.current?.playVideo?.()
                  setCurrentPlaybackSeconds(t)
                }}
                onDetailClick={handleHighlightDetail}
              />
              <LiveQuestionFeed
                currentSeconds={currentPlaybackSeconds}
                onAnswered={handleFeedAnswered}
                onExplainAnswer={handleExplainAnswer}
                quizDifficulty={feedDifficulty}
                setQuizDifficulty={setFeedDifficulty}
                consecutiveCorrect={feedConsecCorrect}
                setConsecutiveCorrect={setFeedConsecCorrect}
              />
            </div>

            <section className="lp-transcripts">
              <div className="lp-transcripts-header">
                <h2>Transcripts</h2>
              </div>
              <div className="lp-transcripts-divider" />
              <ul
                className="lp-transcript-list"
                ref={transcriptListRef}
                onMouseEnter={() => { userScrolledRef.current = true }}
                onMouseLeave={() => {
                  clearTimeout(userScrollTimerRef.current)
                  userScrollTimerRef.current = setTimeout(() => {
                    userScrolledRef.current = false
                  }, 4000)
                }}
              >
                {transcriptRows.map((row) => (
                  <li
                    key={row.id}
                    ref={(node) => setTranscriptItemRef(row.id, node)}
                    className={`lp-transcript-item${activeTranscriptId === row.id ? ' lp-active' : ''}`}
                    onClick={() => {
                      playerRef.current?.seekTo?.(row.seconds, true)
                      playerRef.current?.playVideo?.()
                      setCurrentPlaybackSeconds(row.seconds)
                    }}
                  >
                    <span className="lp-transcript-time">{row.time}</span>
                    <span className="lp-transcript-text">{row.text}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          {/* ── Right column: Glossary + Chat ── */}
          <aside className="lp-right-col">
            <Glossary currentSeconds={currentPlaybackSeconds} />
            <div className="lp-right-divider" />

            <section className="lp-chat">
              <div className="lp-chat-messages">
                {messages.length === 0 && !isLoading ? (
                  <div className="lp-greeting-wrap">
                    <img src={palCharacter} alt="Pal" />
                    <div className="lp-greeting-bubbles">
                      <p className="lp-greet-light">Hi there,</p>
                      <p className="lp-greet-strong">How can I help you?</p>
                    </div>
                  </div>
                ) : (
                  <div className="lp-message-list">
                    {messages.map((msg, i) => (
                      <div key={i} className={`lp-message lp-message-${msg.role}`}>
                        {msg.content}
                      </div>
                    ))}
                    {isLoading && (
                      <div className="lp-message lp-message-assistant">
                        <div className="lp-typing-indicator"><span /><span /><span /></div>
                      </div>
                    )}
                  </div>
                )}
                {aiError && <p className="lp-error-msg">! {aiError}</p>}
                <div ref={chatBottomRef} />
              </div>

              <div className="lp-chat-input-row">
                <div className="lp-chat-input-wrap">
                  <input
                    type="text"
                    className="lp-chat-input"
                    placeholder="Ask me anything..."
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') sendMessage(chatInput) }}
                  />
                  <button
                    type="button"
                    className="lp-send-btn"
                    onClick={() => sendMessage(chatInput)}
                    disabled={isLoading || !chatInput.trim()}
                    aria-label="Send message"
                  >
                    &gt;
                  </button>
                </div>
                <button type="button" className="lp-mic-btn" aria-label="Microphone">
                  <span className="lp-icon lp-icon-mic" aria-hidden="true" />
                </button>
              </div>
              <div className="lp-quick-suggestions">
                <p>Quick suggestions</p>
                <div className="lp-chip-list">
                  {QUICK_SUGGESTIONS.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="lp-chat-chip"
                      onClick={() => submitQuickSuggestion(item)}
                      disabled={isLoading}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          </aside>
        </div>
      </main>

      {/* Researcher panel */}
      <div className="lp-researcher-panel">
        <input
          type="text"
          className="lp-researcher-input"
          placeholder="Participant ID"
          value={participantId}
          onChange={(e) => {
            setParticipantId(e.target.value)
            saveParticipantId(e.target.value)
          }}
        />
        <button type="button" className="lp-researcher-reset" onClick={resetSession}>
          Reset
        </button>
        <a className="lp-researcher-export" href="/api/export" target="_blank" rel="noreferrer">
          Export CSV
        </a>
      </div>

    </div>
  )
}

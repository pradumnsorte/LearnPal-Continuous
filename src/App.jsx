import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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

function Glossary({ currentSeconds, aiProvider, onCycleProvider }) {
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
        <button
          type="button"
          className="lp-provider-toggle"
          onClick={onCycleProvider}
          title="Switch AI provider"
        >
          {PROVIDER_LABELS[aiProvider]}
        </button>
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
        <div className="lp-section-heading-group">
          <h2>Explore highlights</h2>
          <div className="lp-info-tip">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8"/>
              <line x1="12" y1="8" x2="12" y2="8.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <line x1="12" y1="11" x2="12" y2="16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
            <div className="lp-tip-bubble" role="tooltip">
              {isPaused
                ? 'Highlights paused — other modules continue running.'
                : 'Parts of the video are highlighted as this lesson progresses.'}
            </div>
          </div>
        </div>
        <button type="button" className="lp-section-stop" onClick={togglePause}>
          {isPaused ? 'Resume' : 'Hide'}
        </button>
      </div>
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
        <div className="lp-section-heading-group">
          <h2>Live question feed</h2>
          <div className="lp-info-tip">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8"/>
              <line x1="12" y1="8" x2="12" y2="8.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <line x1="12" y1="11" x2="12" y2="16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
            <div className="lp-tip-bubble" role="tooltip">
              {isPaused
                ? 'Question feed paused — other modules continue running.'
                : 'Questions update as the lesson progresses. Answer on the go for better comprehension.'}
            </div>
          </div>
        </div>
        <button type="button" className="lp-section-stop" onClick={togglePause}>
          {isPaused ? 'Resume' : 'Stop'}
        </button>
      </div>
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
  const playerStageRef  = useRef(null)
  const isCompactRef    = useRef(false)
  const controlsTimerRef = useRef(null)
  const progressRef     = useRef(null)
  const isSeekingRef    = useRef(false)
  const centerColumnRef = useRef(null)
  const playerControlsModeRef = useRef('custom')
  const savedTimeRef    = useRef(0)

  // Settings refs
  const gearBtnRef      = useRef(null)
  const settingsPanelRef = useRef(null)

  // Secondary row ref — used to dynamically sync --feature-row-h
  const secondaryRowRef = useRef(null)

  // Transcript refs
  const transcriptListRef  = useRef(null)
  const transcriptItemRefs = useRef(new Map())
  const userScrolledRef    = useRef(false)
  const userScrollTimerRef = useRef(null)

  // Chat scroll ref
  const chatBottomRef = useRef(null)

  // Right column resize
  const rightColRef          = useRef(null)
  const dividerDraggingRef   = useRef(false)
  const dividerStartY        = useRef(0)
  const dividerStartHeight   = useRef(0)
  const [glossaryHeight, setGlossaryHeight] = useState(null) // null = equal flex split

  // Playback state
  const [isPlaying, setIsPlaying]           = useState(false)
  const [duration, setDuration]             = useState(0)
  const [currentPlaybackSeconds, setCurrentPlaybackSeconds] = useState(0)
  const [activeTranscriptId, setActiveTranscriptId]         = useState(transcriptRows[0]?.id ?? '')

  // Custom controls state
  const [volume, setVolume]               = useState(100)
  const [isMuted, setIsMuted]             = useState(false)
  const [playbackRate, setPlaybackRate]   = useState(1)
  const [showControls, setShowControls]   = useState(true)
  const [isFullscreen, setIsFullscreen]   = useState(false)
  const [showSpeedMenu, setShowSpeedMenu] = useState(false)
  const [isCompact, setIsCompact]         = useState(false)
  const [playerControlsMode, setPlayerControlsMode] = useState('custom') // 'custom' | 'native'
  const [showSettings, setShowSettings]   = useState(false)
  const [playerKey, setPlayerKey]         = useState(0)

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

    const startPlaybackPolling = () => {
      window.clearInterval(playbackPollRef.current)
      playbackPollRef.current = window.setInterval(() => {
        const player = playerRef.current
        if (!player || typeof player.getCurrentTime !== 'function') return
        const current = player.getCurrentTime()
        if (Number.isFinite(current)) setCurrentPlaybackSeconds(current)
      }, 500)
    }

    const initPlayer = async () => {
      await loadYouTubeIframeApi()
      if (disposed || !playerHostRef.current || !window.YT?.Player) return

      playerRef.current = new window.YT.Player(playerHostRef.current, {
        host: 'https://www.youtube-nocookie.com',
        videoId: VIDEO_ID,
        playerVars: {
          controls: playerControlsModeRef.current === 'native' ? 1 : 0,
          rel: 0, modestbranding: 1, iv_load_policy: 3, playsinline: 1, autoplay: 0,
        },
        events: {
          onReady: (e) => {
            startPlaybackPolling()
            const d = e.target.getDuration()
            if (d > 0) setDuration(d)
            setVolume(e.target.getVolume())
            setIsMuted(e.target.isMuted())
            if (savedTimeRef.current > 0) {
              e.target.seekTo(savedTimeRef.current, true)
              savedTimeRef.current = 0
            }
          },
          onStateChange: (e) => {
            const playing = e.data === 1
            const ended   = e.data === 0
            isPlayingRef.current = playing
            setIsPlaying(playing)
            const d = e.target.getDuration()
            if (d > 0) setDuration(d)
            const pos = e.target.getCurrentTime?.() ?? null
            if (playing) logEventRef.current?.('video_play', pos)
            else if (ended) logEventRef.current?.('video_ended', pos)
            else logEventRef.current?.('video_pause', pos)
            if (playerControlsModeRef.current === 'custom') {
              if (playing) {
                clearTimeout(controlsTimerRef.current)
                controlsTimerRef.current = setTimeout(() => setShowControls(false), 3000)
              } else {
                clearTimeout(controlsTimerRef.current)
                setShowControls(true)
              }
            }
          },
        },
      })
    }

    initPlayer()
    return () => {
      disposed = true
      window.clearInterval(playbackPollRef.current)
      clearTimeout(controlsTimerRef.current)
      if (playerRef.current && typeof playerRef.current.destroy === 'function') {
        playerRef.current.destroy()
      }
      playerRef.current = null
    }
  }, [playerKey])

  // ── Transcript auto-scroll ─────────────────────────────────────────────────

  // Effect 1: track which line is active (fires every poll tick)
  useEffect(() => {
    if (!transcriptRows.length) return
    let currentId = transcriptRows[0].id
    for (let i = 0; i < transcriptRows.length; i += 1) {
      if (currentPlaybackSeconds >= transcriptRows[i].seconds) {
        currentId = transcriptRows[i].id
      } else {
        break
      }
    }
    setActiveTranscriptId(currentId)
  }, [currentPlaybackSeconds])

  // Effect 2: scroll the list to the active line (fires only when active line changes)
  // Uses list.scrollTo() — NOT scrollIntoView() — so only the transcript list scrolls,
  // never the center column.
  useEffect(() => {
    if (userScrolledRef.current) return
    const list = transcriptListRef.current
    const activeNode = transcriptItemRefs.current.get(activeTranscriptId)
    if (!list || !activeNode) return
    const listRect = list.getBoundingClientRect()
    const activeRect = activeNode.getBoundingClientRect()
    const target = list.scrollTop + (activeRect.top - listRect.top) - 8
    list.scrollTo({ top: Math.max(target, 0), behavior: 'smooth' })
  }, [activeTranscriptId])

  const setTranscriptItemRef = (id, node) => {
    if (node) transcriptItemRefs.current.set(id, node)
    else transcriptItemRefs.current.delete(id)
  }

  // ── Chat auto-scroll ───────────────────────────────────────────────────────

  useEffect(() => {
    const el = chatBottomRef.current
    if (el) el.scrollTop = el.scrollHeight
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

  const seekPercent = duration > 0 ? (currentPlaybackSeconds / duration) * 100 : 0

  // ── Fullscreen sync ───────────────────────────────────────────────────────

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  // ── Sticky shrinking player ───────────────────────────────────────────────

  const handleMainScroll = useCallback(() => {
    const el = centerColumnRef.current
    if (!el) return
    if (!isCompactRef.current && el.scrollTop > 1) {
      isCompactRef.current = true
      setIsCompact(true)
    } else if (isCompactRef.current && el.scrollTop < 1) {
      isCompactRef.current = false
      setIsCompact(false)
    }
  }, [])

  const handleTranscriptScroll = useCallback(() => {
    userScrolledRef.current = true
    clearTimeout(userScrollTimerRef.current)
    userScrollTimerRef.current = setTimeout(() => {
      userScrolledRef.current = false
    }, 4000)
  }, [])

  // ── Sync --feature-row-h to the actual secondary row height ──────────────

  useLayoutEffect(() => {
    const el = secondaryRowRef.current
    if (!el) return
    const sync = () => {
      document.documentElement.style.setProperty(
        '--feature-row-h',
        `${el.offsetHeight}px`
      )
    }
    sync() // immediate measurement on mount
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // ── Settings panel ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!showSettings) return
    const close = (e) => {
      if (settingsPanelRef.current?.contains(e.target)) return
      if (gearBtnRef.current?.contains(e.target)) return
      setShowSettings(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [showSettings])

  const switchPlayerControls = (next) => {
    if (next === playerControlsMode) { setShowSettings(false); return }
    savedTimeRef.current = playerRef.current?.getCurrentTime?.() ?? 0
    playerControlsModeRef.current = next
    setPlayerControlsMode(next)
    setShowControls(true)
    setShowSettings(false)
    setPlayerKey((k) => k + 1)
  }

  // ── Custom player controls ────────────────────────────────────────────────

  const handleStageMouseMove = () => {
    setShowControls(true)
    clearTimeout(controlsTimerRef.current)
    if (isPlayingRef.current) {
      controlsTimerRef.current = setTimeout(() => setShowControls(false), 3000)
    }
  }

  const handleStageMouseLeave = () => {
    clearTimeout(controlsTimerRef.current)
    if (isPlayingRef.current) setShowControls(false)
  }

  const togglePlay = () => {
    const p = playerRef.current
    if (!p) return
    isPlayingRef.current ? p.pauseVideo() : p.playVideo()
  }

  const seekRelative = (delta) => {
    const p = playerRef.current
    if (!p) return
    const t = Math.max(0, (p.getCurrentTime() || 0) + delta)
    p.seekTo(t, true)
    setCurrentPlaybackSeconds(t)
  }

  const seekToRatio = (clientX) => {
    const rect = progressRef.current?.getBoundingClientRect()
    if (!rect || !duration) return
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const t = ratio * duration
    setCurrentPlaybackSeconds(t)
    playerRef.current?.seekTo(t, true)
  }

  const handleSeekPointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    isSeekingRef.current = true
    seekToRatio(e.clientX)
  }

  const handleSeekPointerMove = (e) => {
    if (!isSeekingRef.current) return
    seekToRatio(e.clientX)
  }

  const handleSeekPointerUp = () => { isSeekingRef.current = false }

  const handleVolumeChange = (val) => {
    const p = playerRef.current
    if (!p) return
    setVolume(val)
    p.setVolume(val)
    if (val === 0) { p.mute(); setIsMuted(true) }
    else if (isMuted) { p.unMute(); setIsMuted(false) }
  }

  const toggleMute = () => {
    const p = playerRef.current
    if (!p) return
    if (isMuted) {
      p.unMute()
      setIsMuted(false)
      if (volume === 0) { setVolume(50); p.setVolume(50) }
    } else {
      p.mute()
      setIsMuted(true)
    }
  }

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      playerStageRef.current?.requestFullscreen()
    } else {
      document.exitFullscreen()
    }
  }

  // ── Right column glossary/chat resize ─────────────────────────────────────

  const handleDividerPointerDown = (e) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dividerDraggingRef.current = true
    dividerStartY.current = e.clientY
    // Snapshot the current glossary height (use offsetHeight of the wrapper)
    const glossaryEl = rightColRef.current?.querySelector('.lp-glossary-resize-wrapper')
    dividerStartHeight.current = glossaryEl?.offsetHeight ?? Math.floor((rightColRef.current?.offsetHeight ?? 600) / 2)
  }

  const handleDividerPointerMove = (e) => {
    if (!dividerDraggingRef.current) return
    const colH = rightColRef.current?.offsetHeight ?? 600
    const delta = e.clientY - dividerStartY.current
    const next = dividerStartHeight.current + delta
    const min = 80
    const max = colH - 150
    setGlossaryHeight(Math.max(min, Math.min(max, next)))
  }

  const handleDividerPointerUp = () => {
    dividerDraggingRef.current = false
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="lp-root">

      {/* Header */}
      <header className="lp-header">
        <div className="lp-brand">
          <img src={brandIcon} alt="LearnPal logo" />
          <h1>
            <span>Learn</span>Pal
          </h1>
        </div>
      </header>

      {/* Main layout */}
      <main className="lp-main">
        <aside className="lp-utility-rail" aria-label="Primary navigation">
          <button type="button" className="lp-rail-btn" aria-label="Menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3 12h18M3 6h18M3 18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
          <div className="lp-rail-bottom">
            <div className="lp-settings-anchor">
              <button
                ref={gearBtnRef}
                type="button"
                className={`lp-rail-btn${showSettings ? ' lp-rail-btn-active' : ''}`}
                aria-label="Settings"
                aria-expanded={showSettings}
                onClick={() => setShowSettings((v) => !v)}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>

              {showSettings && (
                <div ref={settingsPanelRef} className="lp-settings-panel" role="dialog" aria-label="Settings">
                  <p className="lp-settings-label">Player controls</p>
                  <div className="lp-settings-seg">
                    <button
                      type="button"
                      className={`lp-seg-opt${playerControlsMode === 'custom' ? ' lp-seg-active' : ''}`}
                      onClick={() => switchPlayerControls('custom')}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M8 5v14l11-7z"/>
                      </svg>
                      Custom
                    </button>
                    <button
                      type="button"
                      className={`lp-seg-opt${playerControlsMode === 'native' ? ' lp-seg-active' : ''}`}
                      onClick={() => switchPlayerControls('native')}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" strokeWidth="1.8"/>
                        <path d="M8 10l2.5 2.5L8 15M12 15h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      YouTube
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="lp-rail-avatar" aria-label="User profile">
              P
            </div>
          </div>
        </aside>

        <div className="lp-workspace">

          {/* ── Center column: Video + [Highlights | Questions] + Transcripts ── */}
          <div className="lp-center-col" ref={centerColumnRef} onScroll={handleMainScroll}>
            {/* Video player */}
            <div className={`lp-player-wrap${isCompact ? ' lp-player-compact' : ''}`}>
              <div
                ref={playerStageRef}
                className={`lp-player-stage${playerControlsMode === 'custom' && !showControls ? ' lp-player-nocursor' : ''}`}
                onMouseMove={handleStageMouseMove}
                onMouseLeave={handleStageMouseLeave}
              >
                <div ref={playerHostRef} className="lp-youtube-player" />

                {/* Transparent overlay — routes clicks to togglePlay, custom mode only */}
                {playerControlsMode === 'custom' && (
                  <div className="lp-player-click-capture" onClick={togglePlay} aria-hidden="true" />
                )}

                {/* Custom controls overlay — hidden in YouTube mode */}
                {playerControlsMode === 'custom' && <div className={`lp-controls${showControls ? ' lp-controls-visible' : ''}`}>

                  {/* Seek bar */}
                  <div
                    className="lp-seek-bar"
                    ref={progressRef}
                    onPointerDown={handleSeekPointerDown}
                    onPointerMove={handleSeekPointerMove}
                    onPointerUp={handleSeekPointerUp}
                  >
                    <div className="lp-seek-track">
                      <div className="lp-seek-fill" style={{ width: `${seekPercent}%` }} />
                      <div className="lp-seek-thumb" style={{ left: `${seekPercent}%` }} />
                    </div>
                  </div>

                  {/* Controls row */}
                  <div className="lp-controls-row">
                    <div className="lp-ctrl-left">

                      {/* Play / Pause */}
                      <button type="button" className="lp-ctrl-btn" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
                        {isPlaying ? (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" />
                          </svg>
                        ) : (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M5 3l14 9-14 9V3z" />
                          </svg>
                        )}
                      </button>

                      {/* Rewind 10s */}
                      <button type="button" className="lp-ctrl-btn" onClick={() => seekRelative(-10)} aria-label="Rewind 10 seconds">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <path d="M11.99 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6h-2c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
                          <text x="12" y="17" textAnchor="middle" fontSize="6" fontWeight="bold" fill="currentColor">10</text>
                        </svg>
                      </button>

                      {/* Forward 10s */}
                      <button type="button" className="lp-ctrl-btn" onClick={() => seekRelative(10)} aria-label="Forward 10 seconds">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <path d="M12.01 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z" />
                          <text x="12" y="17" textAnchor="middle" fontSize="6" fontWeight="bold" fill="currentColor">10</text>
                        </svg>
                      </button>

                      {/* Volume */}
                      <div className="lp-vol-group">
                        <button type="button" className="lp-ctrl-btn" onClick={toggleMute} aria-label={isMuted ? 'Unmute' : 'Mute'}>
                          {(isMuted || volume === 0) ? (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                              <path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.99 8.99 0 0 0 17.73 18l1.73 1.73L21 18.46 5.73 3H4.27zM12 4L9.91 6.09 12 8.18V4z" />
                            </svg>
                          ) : volume < 50 ? (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                              <path d="M18.5 12A4.5 4.5 0 0 0 16 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
                            </svg>
                          ) : (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                            </svg>
                          )}
                        </button>
                        <div className="lp-vol-track">
                          <input
                            type="range" min="0" max="100"
                            value={isMuted ? 0 : volume}
                            onChange={(e) => handleVolumeChange(Number(e.target.value))}
                            className="lp-vol-slider"
                            aria-label="Volume"
                          />
                        </div>
                      </div>

                      {/* Time display */}
                      <span className="lp-ctrl-time">{formatTime(currentPlaybackSeconds)} / {formatTime(duration)}</span>
                    </div>

                    <div className="lp-ctrl-right">

                      {/* Playback speed */}
                      <div className="lp-speed-group">
                        <button
                          type="button"
                          className="lp-ctrl-btn lp-speed-btn"
                          onClick={(e) => { e.stopPropagation(); setShowSpeedMenu((v) => !v) }}
                          aria-label="Playback speed"
                        >
                          {playbackRate === 1 ? '1×' : `${playbackRate}×`}
                        </button>
                        {showSpeedMenu && (
                          <div className="lp-speed-menu">
                            {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
                              <button
                                key={r}
                                type="button"
                                className={`lp-speed-opt${playbackRate === r ? ' lp-speed-current' : ''}`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  playerRef.current?.setPlaybackRate(r)
                                  setPlaybackRate(r)
                                  setShowSpeedMenu(false)
                                }}
                              >
                                {r === 1 ? 'Normal' : `${r}×`}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Fullscreen */}
                      <button type="button" className="lp-ctrl-btn" onClick={toggleFullscreen} aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>
                        {isFullscreen ? (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                          </svg>
                        ) : (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>
                </div>}
              </div>
            </div>

            {/* Highlights + Question Feed side by side below video */}
            <div className="lp-secondary-row" ref={secondaryRowRef}>
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
                onScroll={handleTranscriptScroll}
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
          <aside className="lp-right-col" ref={rightColRef}>
            <div
              className="lp-glossary-resize-wrapper"
              style={glossaryHeight !== null
                ? { height: `${glossaryHeight}px`, flexShrink: 0 }
                : { flex: 1, minHeight: 0 }}
            >
              <Glossary
                currentSeconds={currentPlaybackSeconds}
                aiProvider={aiProvider}
                onCycleProvider={() =>
                  setAiProvider((p) => {
                    const idx = PROVIDER_CYCLE.indexOf(p)
                    return PROVIDER_CYCLE[(idx + 1) % PROVIDER_CYCLE.length]
                  })
                }
              />
            </div>

            {/* Draggable divider */}
            <div
              className="lp-right-divider"
              onPointerDown={handleDividerPointerDown}
              onPointerMove={handleDividerPointerMove}
              onPointerUp={handleDividerPointerUp}
              role="separator"
              aria-label="Resize glossary and chat"
            />

            <section className="lp-chat">
              <div className="lp-chat-hero" ref={chatBottomRef}>
                {messages.length === 0 && !isLoading ? (
                  <div className="lp-chat-start">
                    <div className="lp-greeting-wrap">
                      <img src={palCharacter} alt="Pal mascot" />
                      <div className="lp-greeting-bubbles">
                        <p className="lp-greet-light">Hi there,</p>
                        <p className="lp-greet-strong">How can I help you?</p>
                      </div>
                    </div>

                    <div className="lp-suggestions-inline">
                      <p className="lp-suggestions-label">Try asking</p>
                      <div className="lp-suggestions-grid">
                        {QUICK_SUGGESTIONS.map((s) => (
                          <button
                            key={s}
                            type="button"
                            className="lp-suggestion-card"
                            onClick={() => submitQuickSuggestion(s)}
                            disabled={isLoading}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="lp-suggestion-arrow">
                              <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="lp-snap-chat-flow">
                    {messages.map((msg, i) =>
                      msg.role === 'user' ? (
                        <div key={i} className="lp-flow-user-end">
                          <div className="lp-flow-chip">{msg.content}</div>
                        </div>
                      ) : (
                        <div key={i} className="lp-flow-assistant">
                          <p>{msg.content}</p>
                        </div>
                      )
                    )}
                    {isLoading && (
                      <div className="lp-flow-assistant">
                        <div className="lp-typing-indicator"><span /><span /><span /></div>
                      </div>
                    )}
                    {aiError && (
                      <div className="lp-flow-assistant">
                        <p className="lp-error-msg">⚠ {aiError}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <section className="lp-chat-bottom">
                <div className="lp-input-row">
                  <form
                    className="lp-input-main"
                    onSubmit={(e) => { e.preventDefault(); sendMessage(chatInput) }}
                  >
                    <input
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      placeholder="Ask me anything..."
                      aria-label="Ask Pal input"
                      disabled={isLoading}
                    />
                    <button type="submit" aria-label="Send message" disabled={isLoading || !chatInput.trim()}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>
                  </form>
                </div>

              </section>
            </section>

            <p className="lp-ai-disclaimer">
              Pal can make mistakes. Always verify important information.
            </p>
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

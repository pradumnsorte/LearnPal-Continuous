import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import transcriptRows from './data/transcript.json'
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

  // Quiz state
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

  // ── Chat ───────────────────────────────────────────────────────────────────

  const sendMessage = async (content) => {
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
  }

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

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="lp-root">

      {/* Header */}
      <header className="lp-header">
        <div className="lp-brand">
          <img src={brandIcon} alt="LearnPal" className="lp-brand-icon" />
          <span className="lp-brand-name">LearnPal</span>
        </div>
        <h1 className="lp-video-title">The Essential Main Ideas of Neural Networks</h1>
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

      {/* Main 3-column layout */}
      <main className="lp-main">

        {/* ── Left column: Highlights + Live Question Feed ── */}
        <aside className="lp-left-col">
          <section className="lp-highlights">
            <h2>Explore Highlights</h2>
            {/* TODO: highlights content synced to video position */}
            <p className="lp-placeholder">Highlights will appear as the video progresses.</p>
          </section>

          <section className="lp-question-feed">
            <h2>Live Question Feed</h2>
            {/* TODO: comprehension questions synced to video position */}
            <p className="lp-placeholder">Questions will appear as you watch.</p>
          </section>
        </aside>

        {/* ── Center column: Video + Transcript ── */}
        <div className="lp-center-col">
          <div className="lp-player-stage">
            <div ref={playerHostRef} className="lp-player" />
          </div>

          <section className="lp-transcripts">
            <div className="lp-transcripts-header">
              <h2>Transcript</h2>
            </div>
            <ul className="lp-transcript-list" ref={transcriptListRef}
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
          <section className="lp-glossary">
            <h2>Pal's Key Word Glossary</h2>
            {/* TODO: glossary terms synced to video position */}
            <p className="lp-placeholder">Key terms will appear as the video progresses.</p>
          </section>

          <section className="lp-chat">
            <div className="lp-chat-title">Ask Pal</div>

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
              {aiError && <p className="lp-error-msg">⚠ {aiError}</p>}
            </div>

            <div className="lp-chat-input-row">
              <input
                type="text"
                className="lp-chat-input"
                placeholder="Ask anything…"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') sendMessage(chatInput) }}
              />
              <button
                type="button"
                className="lp-send-btn"
                onClick={() => sendMessage(chatInput)}
                disabled={isLoading || !chatInput.trim()}
              >
                Ask
              </button>
            </div>
            <p className="lp-ai-disclaimer">Pal can make mistakes. Always verify important information.</p>
          </section>
        </aside>
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

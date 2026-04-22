import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
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

const PROVIDERS = { GROQ: 'groq', AZURE: 'azure', AZURE_54: 'azure-54', OLLAMA: 'ollama' }
const PROVIDER_CYCLE = [PROVIDERS.AZURE, PROVIDERS.AZURE_54, PROVIDERS.GROQ, PROVIDERS.OLLAMA]
const PROVIDER_LABELS = {
  [PROVIDERS.AZURE]:    '⬡ GPT-4o mini',
  [PROVIDERS.AZURE_54]: '⬡ GPT-5.4 mini',
  [PROVIDERS.GROQ]:     '⚡ Groq',
  [PROVIDERS.OLLAMA]:   '🦙 Ollama',
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

The user is currently learning about neural networks (video: "The Essential Main Ideas of Neural Networks" by StatQuest, position: ${timeStr}).

The following topics are being covered at this moment — use this as background knowledge to stay relevant, not as a source to cite:
${recentContext || 'Video just started.'}
${sessionContext}
You are a subject-matter expert in machine learning and neural networks. Explain every concept from first principles, with full depth — don't summarise, don't simplify away important detail, and never truncate. Go beyond the immediate question: bring in related concepts, real-world applications, intuitive analogies, and historical context where they add value. Your goal is to leave the user with a genuinely deeper understanding than any single video could provide.

Never reference the video, transcript, or presenter as a source. Do not say "the transcript says", "in the video", "the presenter mentions", "as stated", or anything similar. You simply know this material — explain it that way. The background topics above are only to help you stay contextually relevant; they are not a script to follow or cite.

Use the session context to personalise your responses — if the user got a quiz question wrong, directly address that misconception with a clear, corrective explanation.

Format your responses using markdown: use **bold** for key terms, bullet points or numbered lists for multi-part answers, and short paragraphs. Keep it conversational and clear — like a brilliant tutor who genuinely loves the subject.`
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

// ─── Live analysis ────────────────────────────────────────────────────────────

const callAnalyse = async (provider, chunk, previousTerms, previousQuestions, frameBase64 = null, previousHighlights = []) => {
  const res = await fetch('/api/analyse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, chunk, previousTerms, previousQuestions, frameBase64, previousHighlights }),
  })
  if (!res.ok) throw new Error(`Analyse error ${res.status}`)
  return res.json()
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

function Glossary({ currentSeconds, aiProvider, onCycleProvider, items = [] }) {
  const [isPaused, setIsPaused] = useState(false)
  const [frozenAt, setFrozenAt] = useState(null)
  const [removedIds, setRemovedIds] = useState(new Set())
  const [pinnedIds, setPinnedIds] = useState(new Set())
  const prevCountRef = useRef(0)
  const [newIds, setNewIds] = useState(new Set())
  const [revealedIds, setRevealedIds] = useState(new Set())

  const effectiveSeconds = isPaused ? (frozenAt ?? currentSeconds) : currentSeconds

  useEffect(() => {
    const toAdd = items.filter(g => (g.arrivedAt ?? 0) <= effectiveSeconds && !revealedIds.has(g.id))
    if (toAdd.length > 0) {
      setRevealedIds(prev => { const n = new Set(prev); toAdd.forEach(g => n.add(g.id)); return n })
    }
  }, [effectiveSeconds, items])

  const visible = items.filter((g) => revealedIds.has(g.id) && !removedIds.has(g.id))

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
        <div className="lp-glossary-topbar-left">
          <h2>Pal&apos;s Key Word Glossary</h2>
          <span className={`lp-live-status${isPaused ? ' lp-live-status--paused' : ''}`}>
            <span className="lp-live-dot" />
            {isPaused ? 'Paused' : 'Live'}
          </span>
        </div>
        <div className="lp-glossary-topbar-right">
          <button
            type="button"
            className="lp-provider-toggle"
            onClick={onCycleProvider}
            title="Switch AI provider"
          >
            {PROVIDER_LABELS[aiProvider]}
          </button>
          <button type="button" className={`lp-section-stop${isPaused ? ' lp-section-stop--cta' : ''}`} onClick={togglePause}>
            {isPaused ? 'Resume' : 'Stop'}
          </button>
        </div>
      </div>
      <div className="lp-glossary-content">
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
                  <span className="lp-glossary-ts">{g.arrivedStr ?? formatTime(g.arrivedAt)}</span>
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

// ─── Frame dot overlay (concentric marker on video) ──────────────────────────

function FrameDot({ reg, videoBounds, onAsk, onOpen, onClose }) {
  const [open, setOpen] = useState(false)
  const dotRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const close = (e) => { if (!dotRef.current?.contains(e.target)) { setOpen(false); onClose?.() } }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open, onClose])

  const toggle = (e) => {
    e.stopPropagation()
    const opening = !open
    setOpen(opening)
    if (opening) onOpen?.()
    else onClose?.()
  }

  return (
    <div
      ref={dotRef}
      className={`lp-frame-dot${open ? ' lp-frame-dot--open' : ''}`}
      style={{
        left: `${videoBounds.left + (reg.x + reg.width  / 2) / 100 * videoBounds.width}%`,
        top:  `${videoBounds.top  + (reg.y + reg.height / 2) / 100 * videoBounds.height}%`,
      }}
      onClick={toggle}
    >
      <span className="lp-frame-dot-core" />
      {open && (
        <div className="lp-frame-dot-tooltip">
          <span className="lp-frame-dot-tooltip-label">{reg.label}</span>
          <span className="lp-frame-dot-tooltip-desc">{reg.description}</span>
          <button
            type="button"
            className="lp-frame-dot-tooltip-ask"
            onClick={(e) => { e.stopPropagation(); onAsk?.() }}
          >
            Ask Pal about this
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Highlights ───────────────────────────────────────────────────────────────

function Highlights({ currentSeconds, onSeek, onPause, onDetailClick, onShowRegions, items = [] }) {
  const [isPaused, setIsPaused] = useState(false)
  const [frozenAt, setFrozenAt] = useState(null)
  const prevCountRef = useRef(0)
  const [newIds, setNewIds] = useState(new Set())
  const [revealedIds, setRevealedIds] = useState(new Set())
  const [featuredId, setFeaturedId] = useState(null)
  const [tipOpen, setTipOpen] = useState(false)
  const tipRef = useRef(null)

  useEffect(() => {
    if (!tipOpen) return
    const close = (e) => { if (!tipRef.current?.contains(e.target)) setTipOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [tipOpen])

  const effectiveSeconds = isPaused ? (frozenAt ?? currentSeconds) : currentSeconds

  // Revealed set only grows — seeking back never hides already-shown items
  useEffect(() => {
    const toAdd = items.filter(h => (h.arrivedAt ?? 0) <= effectiveSeconds && !revealedIds.has(h.id))
    if (toAdd.length > 0) {
      setRevealedIds(prev => { const n = new Set(prev); toAdd.forEach(h => n.add(h.id)); return n })
    }
  }, [effectiveSeconds, items])

  const visible = items.filter(h => revealedIds.has(h.id))

  useEffect(() => {
    if (visible.length > prevCountRef.current) {
      const added = visible.slice(prevCountRef.current).map((h) => h.id)
      setNewIds(new Set(added))
      const timer = setTimeout(() => setNewIds(new Set()), 1200)
      // Always promote the newest AI-generated highlight to featured
      setFeaturedId(added[added.length - 1])
      prevCountRef.current = visible.length
      return () => clearTimeout(timer)
    }
    prevCountRef.current = visible.length
  }, [visible.length])

  const togglePause = () => {
    if (!isPaused) { setFrozenAt(currentSeconds); setIsPaused(true) }
    else { setFrozenAt(null); setIsPaused(false) }
  }

  // Latest first — featured is pinned until user promotes another
  const sorted = [...visible].sort((a, b) => (b.arrivedAt ?? 0) - (a.arrivedAt ?? 0))
  const featured = visible.find(h => h.id === featuredId) ?? sorted[0]
  const older = sorted.filter(h => h.id !== featured?.id)

  const handleOldClick = (h) => {
    // Promote clicked item to featured, seek video to it
    setFeaturedId(h.id)
    onSeek(h.arrivedAt ?? 0)
    if (h.regions?.length && onShowRegions) onShowRegions(h.regions)
  }

  return (
    <section className="lp-highlights">
      <div className="lp-section-header-row">
        <div className="lp-section-heading-group">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" stroke="#0336ff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <h2>Explore highlights</h2>
          <div className="lp-info-tip" ref={tipRef}>
            <button
              type="button"
              className={`lp-info-tip-btn${tipOpen ? ' lp-info-tip-btn--open' : ''}`}
              onClick={() => {
                const opening = !tipOpen
                setTipOpen(opening)
                if (opening) onPause?.()
              }}
              aria-label="About this section"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8"/>
                <line x1="12" y1="8" x2="12" y2="8.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                <line x1="12" y1="11" x2="12" y2="16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </button>
            {tipOpen && (
              <div className="lp-tip-bubble lp-tip-bubble--open" role="tooltip">
                {isPaused ? (
                  <>
                    <strong>Highlights paused.</strong> New highlights won't be generated, but the rest of LearnPal continues running normally. Resume anytime.
                  </>
                ) : (
                  <>
                    <strong>Explore Highlights</strong> automatically identifies key concepts and interesting moments as you watch. The most recent highlight appears in full — click it to jump to that point in the video or ask Pal about it. Earlier highlights collapse into the list below.
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        <button type="button" className={`lp-section-stop${isPaused ? ' lp-section-stop--cta' : ''}`} onClick={togglePause}>
          {isPaused ? 'Resume' : 'Hide'}
        </button>
      </div>

      {!featured ? (
        <p className="lp-placeholder">Highlights will appear as the video progresses.</p>
      ) : (
        <>
          <div
            className={`lp-highlight-item${newIds.has(featured.id) ? ' lp-highlight-new' : ''}`}
            onClick={() => handleOldClick(featured)}
          >
            <div className="lp-highlight-title">
              <span className="lp-highlight-dot" />
              <span>{featured.arrivedStr ?? formatTime(featured.arrivedAt)}</span>
            </div>
            <span className="lp-highlight-text">{featured.text}</span>
            <button
              type="button"
              className="lp-highlight-cta"
              onClick={(e) => { e.stopPropagation(); onDetailClick(featured) }}
            >
              Detail
            </button>
          </div>

          {older.length > 0 && (
            <>
              <div className="lp-highlights-older-label">Earlier ({older.length})</div>
              <ul className="lp-highlights-older-list">
                {older.map((h) => (
                  <li
                    key={h.id}
                    className={`lp-highlight-compact${newIds.has(h.id) ? ' lp-highlight-new' : ''}`}
                    onClick={() => handleOldClick(h)}
                  >
                    <span className="lp-highlight-compact-time">{h.arrivedStr ?? formatTime(h.arrivedAt)}</span>
                    <span className="lp-highlight-compact-text">{h.text}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}

// ─── Live Question Feed ───────────────────────────────────────────────────────

function LiveQuestionFeed({ currentSeconds, onAnswered, onExplainAnswer, quizDifficulty, setQuizDifficulty, consecutiveCorrect, setConsecutiveCorrect, items = [] }) {
  const [isPaused, setIsPaused] = useState(false)
  const [frozenAt, setFrozenAt] = useState(null)
  const [answers, setAnswers] = useState({})
  const [currentIdx, setCurrentIdx] = useState(0)
  const userNavigatedRef = useRef(false)
  const prevCountRef = useRef(0)
  const [newIds, setNewIds] = useState(new Set())
  const [tipOpen, setTipOpen] = useState(false)
  const tipRef = useRef(null)
  const optionLabels = ['A', 'B', 'C', 'D']

  useEffect(() => {
    if (!tipOpen) return
    const close = (e) => { if (!tipRef.current?.contains(e.target)) setTipOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [tipOpen])

  const effectiveSeconds = isPaused ? (frozenAt ?? currentSeconds) : currentSeconds
  const [revealedIds, setRevealedIds] = useState(new Set())

  useEffect(() => {
    const toAdd = items.filter(q => (q.arrivedAt ?? 0) <= effectiveSeconds && !revealedIds.has(q.id))
    if (toAdd.length > 0) {
      setRevealedIds(prev => { const n = new Set(prev); toAdd.forEach(q => n.add(q.id)); return n })
    }
  }, [effectiveSeconds, items])

  const unlocked = items.filter(q => revealedIds.has(q.id))

  useEffect(() => {
    if (unlocked.length > prevCountRef.current) {
      const added = unlocked.slice(prevCountRef.current).map((q) => q.id)
      setNewIds(new Set(added))
      const timer = setTimeout(() => setNewIds(new Set()), 1500)
      if (!userNavigatedRef.current) setCurrentIdx(unlocked.length - 1)
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

  const statusOf = (qq) => {
    const s = answers[qq.id]
    if (!s) return 'unanswered'
    if (s.submitted) return s.isCorrect ? 'correct' : 'wrong'
    if (s.skipped) return 'skipped'
    return 'unanswered'
  }

  const safeIdx = Math.min(currentIdx, Math.max(0, unlocked.length - 1))
  const q = unlocked[safeIdx]
  const state = q ? (answers[q.id] ?? {}) : {}

  const goPrev = () => {
    userNavigatedRef.current = true
    setCurrentIdx((i) => Math.max(0, i - 1))
  }

  const goNext = () => {
    setCurrentIdx((i) => {
      const next = Math.min(unlocked.length - 1, i + 1)
      // Back on the newest → allow auto-advance again
      if (next === unlocked.length - 1) userNavigatedRef.current = false
      else userNavigatedRef.current = true
      return next
    })
  }

  const jumpTo = (i) => {
    setCurrentIdx(i)
    userNavigatedRef.current = i !== unlocked.length - 1
  }

  return (
    <section className="lp-question-feed">
      <div className="lp-section-header-row">
        <div className="lp-section-heading-group">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" stroke="#0336ff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <h2>Live question feed</h2>
          <div className="lp-info-tip" ref={tipRef}>
            <button
              type="button"
              className={`lp-info-tip-btn${tipOpen ? ' lp-info-tip-btn--open' : ''}`}
              onClick={() => setTipOpen(o => !o)}
              aria-label="About this section"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8"/>
                <line x1="12" y1="8" x2="12" y2="8.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                <line x1="12" y1="11" x2="12" y2="16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </button>
            {tipOpen && (
              <div className="lp-tip-bubble lp-tip-bubble--open" role="tooltip">
                {isPaused ? (
                  <>
                    <strong>Question feed paused.</strong> No new questions will be generated, but the rest of LearnPal continues running normally. Resume anytime.
                  </>
                ) : (
                  <>
                    <strong>Live Question Feed</strong> generates quiz questions in real time based on what you're watching. Answer each one to test your understanding, then ask Pal to explain if you're unsure. Use the numbered pills to revisit earlier questions — green means correct, red means wrong, grey means skipped.
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        <button type="button" className={`lp-section-stop${isPaused ? ' lp-section-stop--cta' : ''}`} onClick={togglePause}>
          {isPaused ? 'Resume' : 'Stop'}
        </button>
      </div>

      {unlocked.length === 0 || !q ? (
        <p className="lp-placeholder">Questions will appear as you watch.</p>
      ) : (
        <>
          {/* Status pills — clickable jumps */}
          <div className="lp-qfeed-pills" role="tablist">
            {unlocked.map((qq, i) => {
              const status = statusOf(qq)
              const isActive = i === safeIdx
              return (
                <button
                  key={qq.id}
                  type="button"
                  className={`lp-qfeed-pill lp-qfeed-pill-${status}${isActive ? ' lp-qfeed-pill-active' : ''}`}
                  onClick={() => jumpTo(i)}
                  title={`Q${i + 1} — ${status}`}
                >
                  {i + 1}
                </button>
              )
            })}
          </div>

          {/* Pager: prev ◀ | card | ▶ next */}
          <div className="lp-qfeed-pager">
            <button
              type="button"
              className="lp-qfeed-nav"
              onClick={goPrev}
              disabled={safeIdx === 0}
              aria-label="Previous question"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>

            <div className={`lp-qfeed-item${newIds.has(q.id) ? ' lp-qfeed-new' : ''}`}>
              <div className="lp-qfeed-meta">
                <span className="lp-qfeed-idx">Q{safeIdx + 1}/{unlocked.length}</span>
                <span className="lp-qfeed-ts">{q.arrivedStr ?? formatTime(q.arrivedAt)}</span>
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
            </div>

            <button
              type="button"
              className="lp-qfeed-nav"
              onClick={goNext}
              disabled={safeIdx >= unlocked.length - 1}
              aria-label="Next question"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        </>
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
  const localVideoRef   = useRef(null)
  const canvasRef       = useRef(null)
  const videoSourceRef  = useRef('local')

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
  const [videoSource, setVideoSource]     = useState('local') // 'youtube' | 'local'
  const [videoBounds, setVideoBounds]     = useState({ left: 0, top: 0, width: 100, height: 100 }) // % within stage

  // AI / session state
  const [aiProvider, setAiProvider] = useState(PROVIDERS.AZURE)
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

  // Live AI analysis state
  const [liveGlossary, setLiveGlossary]     = useState([])
  const [liveHighlights, setLiveHighlights] = useState([])
  const [liveQuestions, setLiveQuestions]   = useState([])
  const [frameRegions, setFrameRegions]     = useState([]) // overlays on video
  const lastAnalysedRowRef      = useRef(-1)
  const isAnalysingRef          = useRef(false)
  const liveGlossaryRef         = useRef([])
  const liveQuestionsRef        = useRef([])
  const liveHighlightsRef       = useRef([])
  const frameOverlayTimerRef    = useRef(null)

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

  // ── Video content bounds — maps region coords (% of frame) to stage coords ──
  // The stage may not be 16:9 (compact mode shrinks height while width stays
  // fixed), so object-fit:contain letterboxes the video. We measure the stage
  // and compute where the actual video pixels land within it.
  useEffect(() => {
    const stage = playerStageRef.current
    if (!stage) return
    const VIDEO_ASPECT = 16 / 9 // capture canvas is always 480×270
    const compute = () => {
      const sw = stage.offsetWidth
      const sh = stage.offsetHeight
      if (!sw || !sh) return
      const stageAspect = sw / sh
      let vw, vh, vl, vt
      if (stageAspect > VIDEO_ASPECT) {
        // Stage wider than video — pillarbox (black bars left/right)
        vh = sh
        vw = sh * VIDEO_ASPECT
        vl = (sw - vw) / 2
        vt = 0
      } else {
        // Stage taller than video — letterbox (black bars top/bottom)
        vw = sw
        vh = sw / VIDEO_ASPECT
        vl = 0
        vt = (sh - vh) / 2
      }
      setVideoBounds({ left: vl / sw * 100, top: vt / sh * 100, width: vw / sw * 100, height: vh / sh * 100 })
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [])

  // ── Unified live analysis — transcript chunk + optional video frame ────────
  // Triggered every 4–12 transcript rows. When playing local video, a 480×270
  // JPEG frame is captured and sent alongside the transcript so a single API
  // call returns glossary terms, highlights, questions, AND visual regions.

  useEffect(() => {
    const coveredRows = transcriptRows.filter((r) => r.seconds <= currentPlaybackSeconds)
    if (coveredRows.length < 4) return
    const lastIdx = coveredRows.length - 1
    if (lastIdx - lastAnalysedRowRef.current < 4) return
    if (isAnalysingRef.current) return

    const chunkStart = lastAnalysedRowRef.current + 1
    const chunk = coveredRows.slice(chunkStart, chunkStart + 12)
    if (chunk.length === 0) return

    // Capture a low-res frame if local video is playing (480×270 ≈ 20 KB JPEG)
    let frameBase64 = null
    if (videoSourceRef.current === 'local' && isPlayingRef.current) {
      const video  = localVideoRef.current
      const canvas = canvasRef.current
      if (video && canvas && video.readyState >= 2) {
        canvas.width  = 480
        canvas.height = 270
        canvas.getContext('2d').drawImage(video, 0, 0, 480, 270)
        frameBase64 = canvas.toDataURL('image/jpeg', 0.65).replace('data:image/jpeg;base64,', '')
      }
    }

    isAnalysingRef.current = true

    const arrivedAt = currentPlaybackSeconds
    const arrivedStr = formatTime(arrivedAt)
    const prevTerms      = liveGlossaryRef.current.map((g) => g.term)
    const prevQs         = liveQuestionsRef.current.map((q) => q.question)
    const prevHighlights = liveHighlightsRef.current.map((h) => h.text)

    callAnalyse(aiProvider, chunk, prevTerms, prevQs, frameBase64, prevHighlights)
      .then((result) => {
        const hasQuestion = result.questions?.length > 0
        const advance = hasQuestion ? chunk.length : Math.max(2, Math.floor(chunk.length / 2))
        lastAnalysedRowRef.current = chunkStart + advance - 1

        const stamp = { arrivedAt, arrivedStr }

        if (result.glossaryTerms?.length) {
          const newItems = result.glossaryTerms.map((g, i) => ({ ...g, id: `g-${Date.now()}-${i}`, ...stamp }))
          liveGlossaryRef.current = [...liveGlossaryRef.current, ...newItems]
          setLiveGlossary((prev) => [...prev, ...newItems])
        }
        if (result.highlights?.length) {
          const newHighlights = result.highlights.map((h, i) => ({ ...h, id: `h-${Date.now()}-${i}`, ...stamp }))
          liveHighlightsRef.current = [...liveHighlightsRef.current, ...newHighlights]
          setLiveHighlights((prev) => [...prev, ...newHighlights])
        }
        if (hasQuestion) {
          const newQs = result.questions.map((q, i) => ({ ...q, id: `q-${Date.now()}-${i}`, ...stamp }))
          liveQuestionsRef.current = [...liveQuestionsRef.current, ...newQs]
          setLiveQuestions((prev) => [...prev, ...newQs])
        }

        // Visual regions — show overlays on video, add to Explore Highlights
        // Only ever show one marker at a time: take the first region from this batch.
        if (result.regions?.length && videoSourceRef.current === 'local') {
          const newRegions = result.regions.slice(0, 1).map((reg, i) => ({
            ...reg,
            id: `fr-${Date.now()}-${i}`,
            ...stamp,
          }))
          setFrameRegions(newRegions)
          clearTimeout(frameOverlayTimerRef.current)
          frameOverlayTimerRef.current = setTimeout(() => setFrameRegions([]), 4000)

          setLiveHighlights((prev) => [
            ...prev,
            ...newRegions.map((reg) => ({
              id: `fh-${reg.id}`,
              text: `${reg.label}: ${reg.description}`,
              arrivedAt: reg.arrivedAt,
              arrivedStr: reg.arrivedStr,
              regions: [reg],
            })),
          ])
        }
      })
      .catch((err) => {
        lastAnalysedRowRef.current = chunkStart + Math.max(2, Math.floor(chunk.length / 2)) - 1
        console.warn('[analyse]', err.message)
      })
      .finally(() => { isAnalysingRef.current = false })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPlaybackSeconds, aiProvider])

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
      if (videoSourceRef.current !== 'youtube') return
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

  // ── Local video player ─────────────────────────────────────────────────────

  useEffect(() => {
    const video = localVideoRef.current
    if (!video) return

    const onTimeUpdate = () => {
      if (videoSourceRef.current !== 'local') return
      const t = video.currentTime
      if (Number.isFinite(t)) setCurrentPlaybackSeconds(t)
    }
    const onLoadedMetadata = () => {
      if (videoSourceRef.current === 'local') setDuration(video.duration)
    }
    const onPlay = () => {
      if (videoSourceRef.current !== 'local') return
      isPlayingRef.current = true
      setIsPlaying(true)
      logEventRef.current?.('video_play', video.currentTime)
      if (playerControlsModeRef.current === 'custom') {
        clearTimeout(controlsTimerRef.current)
        controlsTimerRef.current = setTimeout(() => setShowControls(false), 3000)
      }
    }
    const onPause = () => {
      if (videoSourceRef.current !== 'local') return
      isPlayingRef.current = false
      setIsPlaying(false)
      logEventRef.current?.('video_pause', video.currentTime)
      clearTimeout(controlsTimerRef.current)
      setShowControls(true)
    }
    const onEnded = () => {
      if (videoSourceRef.current !== 'local') return
      isPlayingRef.current = false
      setIsPlaying(false)
      logEventRef.current?.('video_ended', video.currentTime)
      setShowControls(true)
    }

    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('ended', onEnded)

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('ended', onEnded)
    }
  }, [])

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
    const when = q.arrivedStr ? ` (around ${q.arrivedStr})` : ''
    const msg = isCorrect
      ? `I just answered a quiz question${when} correctly.\n\nQuestion: "${q.question}"\nMy answer: "${chosen}" ✓\n\nCan you explain in simple terms why this is correct?`
      : `I just got a quiz question${when} wrong.\n\nQuestion: "${q.question}"\nMy answer: "${chosen}" ✗\nCorrect answer: "${correct}"\n\nCan you explain why "${correct}" is the right answer and where my thinking went wrong?`
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
    playerPause()
    playerSeekTo(0)
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
    const playerH = playerStageRef.current?.offsetHeight ?? 200
    const onThreshold = playerH * 0.25
    if (!isCompactRef.current && el.scrollTop > onThreshold) {
      isCompactRef.current = true
      setIsCompact(true)
    } else if (isCompactRef.current && el.scrollTop < 4) {
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

  // ── Disable scroll anchoring to prevent compact-toggle feedback loop ───────

  useEffect(() => {
    const el = centerColumnRef.current
    if (el) el.style.overflowAnchor = 'none'
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

  // ── Unified player helpers (works for both YouTube and local video) ──────────

  const playerGetTime = () => {
    if (videoSourceRef.current === 'local') return localVideoRef.current?.currentTime ?? 0
    return playerRef.current?.getCurrentTime?.() ?? 0
  }

  const playerPlay = () => {
    if (videoSourceRef.current === 'local') localVideoRef.current?.play()
    else playerRef.current?.playVideo?.()
  }

  const playerPause = () => {
    if (videoSourceRef.current === 'local') localVideoRef.current?.pause()
    else playerRef.current?.pauseVideo?.()
  }

  const playerSeekTo = (t) => {
    const clamped = Math.max(0, t)
    if (videoSourceRef.current === 'local') {
      if (localVideoRef.current) localVideoRef.current.currentTime = clamped
    } else {
      playerRef.current?.seekTo?.(clamped, true)
    }
    setCurrentPlaybackSeconds(clamped)
  }

  // ── Switch video source ───────────────────────────────────────────────────

  const switchVideoSource = (next) => {
    if (next === videoSource) { setShowSettings(false); return }
    const t = playerGetTime()
    // Pause whichever player is active
    if (videoSourceRef.current === 'local') localVideoRef.current?.pause()
    else playerRef.current?.pauseVideo?.()
    // Seek the incoming player to the current time
    if (next === 'local') {
      if (localVideoRef.current) localVideoRef.current.currentTime = t
    } else {
      playerRef.current?.seekTo?.(t, true)
    }
    videoSourceRef.current = next
    setVideoSource(next)
    setShowSettings(false)
    setShowControls(true)
    setIsPlaying(false)
    isPlayingRef.current = false
  }

  const switchPlayerControls = (next) => {
    if (next === playerControlsMode) { setShowSettings(false); return }
    savedTimeRef.current = playerGetTime()
    playerControlsModeRef.current = next
    setPlayerControlsMode(next)
    setShowControls(true)
    setShowSettings(false)
    if (videoSourceRef.current === 'youtube') setPlayerKey((k) => k + 1)
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
    isPlayingRef.current ? playerPause() : playerPlay()
  }

  const seekRelative = (delta) => {
    const t = Math.max(0, playerGetTime() + delta)
    playerSeekTo(t)
  }

  const seekToRatio = (clientX) => {
    const rect = progressRef.current?.getBoundingClientRect()
    if (!rect || !duration) return
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    playerSeekTo(ratio * duration)
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
    setVolume(val)
    if (videoSourceRef.current === 'local') {
      const v = localVideoRef.current
      if (!v) return
      v.volume = val / 100
      if (val === 0) { v.muted = true; setIsMuted(true) }
      else if (isMuted) { v.muted = false; setIsMuted(false) }
    } else {
      const p = playerRef.current
      if (!p) return
      p.setVolume(val)
      if (val === 0) { p.mute(); setIsMuted(true) }
      else if (isMuted) { p.unMute(); setIsMuted(false) }
    }
  }

  const toggleMute = () => {
    if (videoSourceRef.current === 'local') {
      const v = localVideoRef.current
      if (!v) return
      if (isMuted) {
        v.muted = false
        setIsMuted(false)
        if (volume === 0) { setVolume(50); v.volume = 0.5 }
      } else {
        v.muted = true
        setIsMuted(true)
      }
    } else {
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
                  <p className="lp-settings-label">Video source</p>
                  <div className="lp-settings-seg">
                    <button
                      type="button"
                      className={`lp-seg-opt${videoSource === 'youtube' ? ' lp-seg-active' : ''}`}
                      onClick={() => switchVideoSource('youtube')}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M23 7s-.3-2-1.2-2.8c-1.1-1.2-2.4-1.2-3-1.3C16.1 2.7 12 2.7 12 2.7s-4.1 0-6.8.2c-.6.1-1.9.1-3 1.3C1.3 5 1 7 1 7S.7 9.1.7 11.3v2c0 2.1.3 4.2.3 4.2s.3 2 1.2 2.8c1.1 1.2 2.6 1.1 3.3 1.2C7.3 21.7 12 21.7 12 21.7s4.1 0 6.8-.3c.6-.1 1.9-.1 3-1.3.9-.8 1.2-2.8 1.2-2.8s.3-2.1.3-4.2v-2C23.3 9.1 23 7 23 7zM9.7 15.5V8.2l8.1 3.7-8.1 3.6z"/>
                      </svg>
                      YouTube
                    </button>
                    <button
                      type="button"
                      className={`lp-seg-opt${videoSource === 'local' ? ' lp-seg-active' : ''}`}
                      onClick={() => switchVideoSource('local')}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      Local
                    </button>
                  </div>
                  <p className="lp-settings-label" style={{ marginTop: 12 }}>Player controls</p>
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
                {/* Both players always in DOM — toggled via visibility */}
                <div
                  ref={playerHostRef}
                  className="lp-youtube-player"
                  style={{ display: videoSource === 'youtube' ? 'block' : 'none' }}
                />
                <video
                  ref={localVideoRef}
                  src="/neural-networks.mp4"
                  className="lp-youtube-player"
                  style={{
                    display: videoSource === 'local' ? 'block' : 'none',
                    objectFit: 'contain',
                    background: '#000',
                  }}
                />
                <canvas ref={canvasRef} style={{ display: 'none' }} />

                {/* Frame highlight dots — local mode only, centered on each region */}
                {videoSource === 'local' && frameRegions.map((reg) => (
                  <FrameDot
                    key={reg.id}
                    reg={reg}
                    videoBounds={videoBounds}
                    onAsk={() => sendMessage(`At ${reg.arrivedStr}, I noticed this on screen: "${reg.label}" — ${reg.description}. Can you explain this in more detail?`)}
                    onOpen={() => {
                      playerPause()
                      clearTimeout(frameOverlayTimerRef.current)
                    }}
                    onClose={() => {
                      frameOverlayTimerRef.current = setTimeout(() => setFrameRegions([]), 2500)
                    }}
                  />
                ))}

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
                                  if (videoSourceRef.current === 'local') {
                                    if (localVideoRef.current) localVideoRef.current.playbackRate = r
                                  } else {
                                    playerRef.current?.setPlaybackRate(r)
                                  }
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
                  playerSeekTo(t)
                  playerPlay()
                }}
                onPause={playerPause}
                onDetailClick={handleHighlightDetail}
                onShowRegions={(regs) => {
                  setFrameRegions(regs)
                  clearTimeout(frameOverlayTimerRef.current)
                  frameOverlayTimerRef.current = setTimeout(() => setFrameRegions([]), 4000)
                }}
                items={liveHighlights}
              />
              <LiveQuestionFeed
                currentSeconds={currentPlaybackSeconds}
                onAnswered={handleFeedAnswered}
                onExplainAnswer={handleExplainAnswer}
                quizDifficulty={feedDifficulty}
                setQuizDifficulty={setFeedDifficulty}
                consecutiveCorrect={feedConsecCorrect}
                setConsecutiveCorrect={setFeedConsecCorrect}
                items={liveQuestions}
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
                      playerSeekTo(row.seconds)
                      playerPlay()
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
                items={liveGlossary}
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
                          <div className="lp-flow-assistant--md">
                            <ReactMarkdown>{msg.content}</ReactMarkdown>
                          </div>
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

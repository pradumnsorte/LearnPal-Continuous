// ── Abuse guards for the publicly-hosted demo ────────────────────────────────
//
// The LLM routes (/api/chat, /api/quiz/generate, /api/analyse) take a prompt
// straight from the request body and bill our provider account. Unguarded they
// are a free LLM endpoint for anyone who finds the URL, so they get three
// cheap layers: a browser-origin check, a per-IP rate limit, and payload caps.
//
// None of this is authentication — a determined caller can forge an Origin
// header. The goal is to bound the damage: casual scraping and scripted abuse
// stop, and the per-IP ceiling caps the spend even when someone gets through.

const isLocalhost = (host = '') => /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/.test(host)

// ── Browser-origin check ─────────────────────────────────────────────────────
// Browsers attach Origin to every POST, including same-origin ones, so the app
// itself always passes. Bare curl/scripted callers send neither Origin nor
// Referer and are refused.

export const requireBrowserOrigin = (req, res, next) => {
  const raw = req.get('origin') || req.get('referer')
  if (!raw) return res.status(403).json({ error: 'Forbidden' })

  let callerHost
  try {
    callerHost = new URL(raw).host
  } catch {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const selfHost = req.get('host') ?? ''
  const allowedHost = process.env.ALLOWED_ORIGIN
    ? new URL(process.env.ALLOWED_ORIGIN).host
    : null

  if (callerHost === selfHost || callerHost === allowedHost || isLocalhost(callerHost)) {
    return next()
  }
  return res.status(403).json({ error: 'Forbidden' })
}

// ── Per-IP rate limit ────────────────────────────────────────────────────────
// In-memory only: the demo runs as a single instance, and a restart clearing
// the counters is acceptable for what this defends against.

const WINDOW_MS = Number(process.env.LLM_RATE_WINDOW_MS) || 10 * 60 * 1000
const MAX_CALLS = Number(process.env.LLM_RATE_MAX) || 60

const hits = new Map()

// Drop expired buckets so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of hits) if (now > entry.resetAt) hits.delete(ip)
}, WINDOW_MS).unref?.()

const clientIp = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown'

export const rateLimitLlm = (req, res, next) => {
  const ip = clientIp(req)
  const now = Date.now()
  const entry = hits.get(ip)

  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS })
    return next()
  }

  entry.count += 1
  if (entry.count > MAX_CALLS) {
    res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000))
    return res.status(429).json({ error: 'Too many AI requests — please wait a minute and try again.' })
  }
  next()
}

// ── Payload caps ─────────────────────────────────────────────────────────────
// Bounds the cost of any single call that does get through.

const MAX_SYSTEM_PROMPT_CHARS = 20000
const MAX_MESSAGES = 60
const MAX_MESSAGE_CHARS = 8000

export const capLlmPayload = (req, res, next) => {
  const { systemPrompt, messages, prompt } = req.body ?? {}

  for (const [name, value] of [['systemPrompt', systemPrompt], ['prompt', prompt]]) {
    if (typeof value === 'string' && value.length > MAX_SYSTEM_PROMPT_CHARS) {
      return res.status(413).json({ error: `${name} is too long` })
    }
  }

  if (Array.isArray(messages)) {
    if (messages.length > MAX_MESSAGES) {
      return res.status(413).json({ error: 'Too many messages in one request' })
    }
    for (const m of messages) {
      if (typeof m?.content === 'string' && m.content.length > MAX_MESSAGE_CHARS) {
        return res.status(413).json({ error: 'Message is too long' })
      }
    }
  }

  next()
}

export const llmGuards = [requireBrowserOrigin, rateLimitLlm, capLlmPayload]

// ── Export gate ──────────────────────────────────────────────────────────────
// The export routes dump every session, message, quiz answer and event for all
// participants. With EXPORT_TOKEN set they require it; without one they are
// reachable only from localhost, which keeps the local research workflow
// working while never exposing study data on the hosted demo.

export const requireExportAccess = (req, res, next) => {
  const expected = process.env.EXPORT_TOKEN

  // Keyed off the Host the request was addressed to, not the client IP: on a
  // hosted deployment Host is the public domain, so export stays closed there
  // even if someone reaches the server from inside the network.
  if (!expected) {
    if (isLocalhost(req.get('host') ?? '')) return next()
    return res.status(404).end()
  }

  const supplied = req.get('x-export-token') || req.query.token
  if (supplied !== expected) return res.status(404).end()
  next()
}

import { Router } from 'express'

const router = Router()

// ── Provider dispatch (text-only, JSON output) ────────────────────────────────

const callProvider = async (provider, systemPrompt, userPrompt) => {
  const messages = [{ role: 'user', content: userPrompt }]

  if (provider === 'groq') {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 800,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
      }),
    })
    if (!res.ok) throw new Error(`Groq error ${res.status}`)
    const data = await res.json()
    return data.choices[0].message.content
  }

  if (provider === 'ollama') {
    const model = process.env.OLLAMA_MODEL || 'llama3.2'
    const res = await fetch('http://localhost:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 800,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
      }),
    })
    if (!res.ok) throw new Error(`Ollama error ${res.status}`)
    const data = await res.json()
    return data.choices[0].message.content
  }

  if (provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: systemPrompt,
        messages,
      }),
    })
    if (!res.ok) throw new Error(`Claude error ${res.status}`)
    const data = await res.json()
    return data.content[0].text
  }

  if (provider === 'azure') {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-01'
    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.AZURE_OPENAI_API_KEY,
      },
      body: JSON.stringify({
        max_tokens: 800,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
      }),
    })
    if (!res.ok) throw new Error(`Azure OpenAI error ${res.status}`)
    const data = await res.json()
    return data.choices[0].message.content
  }

  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 800,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
      }),
    })
    if (!res.ok) throw new Error(`OpenAI error ${res.status}`)
    const data = await res.json()
    return data.choices[0].message.content
  }

  throw new Error('Unknown provider')
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { provider, chunk, previousTerms = [], previousQuestions = [] } = req.body

  if (!provider || !Array.isArray(chunk) || chunk.length === 0) {
    return res.status(400).json({ error: 'provider and chunk are required' })
  }

  const chunkText = chunk.map((r) => `[${r.time}] ${r.text}`).join('\n')

  const prevTermsLine = previousTerms.length > 0
    ? `\nDo NOT repeat these already-identified terms: ${previousTerms.join(', ')}.`
    : ''

  const prevQsLine = previousQuestions.length > 0
    ? `\nDo NOT repeat or closely resemble these already-asked questions:\n${previousQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    : ''

  const systemPrompt = `You are an AI learning assistant analysing an educational video about neural networks. You generate structured support content from transcript chunks. Always return valid JSON only — no markdown, no explanation.`

  const userPrompt = `New transcript chunk from "The Essential Main Ideas of Neural Networks" by StatQuest:

${chunkText}
${prevTermsLine}
${prevQsLine}

Return ONLY this JSON structure:
{
  "glossaryTerms": [{ "term": "...", "definition": "..." }],
  "highlights": [{ "text": "..." }],
  "questions": [{
    "question": "...",
    "options": ["...", "...", "...", "..."],
    "correctIndex": 0,
    "explanation": "...",
    "difficulty": 1
  }]
}

Rules:
- glossaryTerms: 1–3 technically new or difficult terms first introduced in THIS chunk. Plain-English definition, 1 sentence each.
- highlights: 0–2 key conceptual or visual moments from THIS chunk worth surfacing to the learner. 1–2 sentences each.
- questions: exactly 1 multiple-choice comprehension question from THIS chunk. 4 options, correctIndex 0-based. difficulty: 1=Conceptual, 2=Applied, 3=Creative.
- Return an empty array for any category with nothing useful from this chunk.`

  try {
    const raw = await callProvider(provider, systemPrompt, userPrompt)

    // Parse — strip any accidental markdown fences
    const cleaned = raw.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(cleaned)

    res.json({
      glossaryTerms: Array.isArray(parsed.glossaryTerms) ? parsed.glossaryTerms : [],
      highlights:    Array.isArray(parsed.highlights)    ? parsed.highlights    : [],
      questions:     Array.isArray(parsed.questions)     ? parsed.questions     : [],
    })
  } catch (err) {
    console.error('[analyse]', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router

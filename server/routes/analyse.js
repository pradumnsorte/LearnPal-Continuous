import { Router } from 'express'

const router = Router()

// ── Provider dispatch (text + optional vision) ────────────────────────────────

const callProvider = async (provider, systemPrompt, userPrompt, frameBase64 = null) => {
  const hasImage = !!frameBase64

  // Build user message content — multimodal when image present
  const buildContent = (type) => {
    if (!hasImage) return userPrompt
    const textPart = { type: 'text', text: userPrompt }
    if (type === 'anthropic') {
      return [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frameBase64 } },
        textPart,
      ]
    }
    // OpenAI / Azure
    return [
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frameBase64}` } },
      textPart,
    ]
  }

  if (provider === 'groq') {
    // Groq doesn't support vision — send text only, regions will be []
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
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
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
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
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
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: buildContent('anthropic') }],
      }),
    })
    if (!res.ok) throw new Error(`Claude error ${res.status}`)
    const data = await res.json()
    return data.content[0].text
  }

  if (provider === 'azure' || provider === 'azure-54') {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
    const deployment = provider === 'azure-54' ? process.env.AZURE_OPENAI_DEPLOYMENT_54 : process.env.AZURE_OPENAI_DEPLOYMENT
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview'
    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': process.env.AZURE_OPENAI_API_KEY },
      body: JSON.stringify({
        ...(provider === 'azure-54' ? { max_completion_tokens: 1000 } : { max_tokens: 1000 }),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: buildContent('openai') },
        ],
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
        max_tokens: 1000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: buildContent('openai') },
        ],
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
  const { provider, chunk, previousTerms = [], previousQuestions = [], frameBase64 = null } = req.body

  if (!provider || !Array.isArray(chunk) || chunk.length === 0) {
    return res.status(400).json({ error: 'provider and chunk are required' })
  }

  const hasImage = !!frameBase64
  const chunkText = chunk.map((r) => `[${r.time}] ${r.text}`).join('\n')

  const prevTermsLine = previousTerms.length > 0
    ? `\nDo NOT repeat these already-identified terms: ${previousTerms.join(', ')}.`
    : ''

  const prevQsLine = previousQuestions.length > 0
    ? `\nDo NOT repeat or closely resemble these already-asked questions:\n${previousQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    : ''

  const systemPrompt = `You are an AI learning assistant analysing an educational video about neural networks. You generate structured support content from transcript chunks and (when attached) the current video frame.

Each output category has a DISTINCT purpose — never produce overlapping content across them:
  • glossaryTerms → NEW technical vocabulary being introduced in speech
  • regions       → SPECIFIC visual objects/components visible in the attached frame
  • highlights    → WHOLE-SCENE visual compositions worth examining as a unit (rare)
  • questions     → testable concrete knowledge from this chunk

Be conservative. Empty arrays are BETTER than redundant, obvious, or low-value content. Always return valid JSON only — no markdown, no explanation.`

  const regionsSchema = hasImage
    ? `,\n  "regions": [\n    {\n      "label": "short name (2-4 words)",\n      "description": "1-2 sentences: what this region shows and why it matters",\n      "x": 25,\n      "y": 30,\n      "width": 20,\n      "height": 15\n    }\n  ]`
    : ',\n  "regions": []'

  const regionsRule = hasImage
    ? `- regions: 0–3 specific visual elements in the attached frame that a learner would benefit from having pointed out. Valid examples: a node in a neural network diagram, a weight/bias label on a connection, a labelled axis on a chart, a specific term in an equation, an arrow indicating data flow, a highlighted curve on a graph. EXCLUDE: the speaker's face or body, generic logos/watermarks, plain title text, background decoration, UI chrome, or anything not being actively referenced in the current speech. The element must be knowledge-bearing — removing it would hurt understanding of the concept. x, y, width, height are percentages (0–100). Return [] if the frame has nothing worth pointing out (speaker on camera, blank slide, generic title, etc.).`
    : `- regions: [] (no frame provided)`

  const userPrompt = `New transcript chunk from "The Essential Main Ideas of Neural Networks" by StatQuest:

${chunkText}
${prevTermsLine}
${prevQsLine}
${hasImage ? '\nA video frame captured at this moment is attached. Examine it carefully before producing regions/highlights.' : ''}

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
  }]${regionsSchema}
}

Rules:
- glossaryTerms: 1–3 technically new or difficult terms first introduced in THIS chunk. Plain-English definition, 1 sentence each. Skip terms that are obvious from context or that a learner would already know.

- ${regionsRule}

- highlights: WHOLE-SCENE visual compositions only — use VERY sparingly (0 per chunk most of the time; at most 1). Fire ONLY when pausing and examining the entire current visual as a complete unit would meaningfully help learning: e.g., a full neural network diagram has just been revealed, a multi-step equation is written out on screen, a comparison chart with multiple labelled parts is being shown. Each highlight is 1 sentence describing what the overall scene shows and why the whole composition matters. DO NOT emit a highlight for:
  • New terminology or concept introductions  → that belongs in glossaryTerms
  • A single visible object or diagram part    → that belongs in regions
  • Spoken explanation without a visual anchor
  • Recaps, motivations, transitions, summaries, or general statements
  • Anything already captured by a region in this same response
  When in doubt, return [].

- questions: Only if this chunk introduces or explains a concept worth testing. The question must make the learner THINK and apply understanding — not recall a specific phrase or number from the video. Ask "why does this work?", "what would happen if…?", "which of these is an example of X?" style questions. Never ask "what did the speaker say about Y?" or test verbatim facts. 4 options, correctIndex 0-based, difficulty 1=Conceptual 2=Applied 3=Creative. Skip if the chunk is a transition, recap, or has no substantial concept worth reasoning about.

- Return [] for any category with nothing genuinely worthwhile.`

  try {
    const raw = await callProvider(provider, systemPrompt, userPrompt, frameBase64)

    const cleaned = raw.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(cleaned)

    // Validate and clamp regions
    const regions = (Array.isArray(parsed.regions) ? parsed.regions : [])
      .filter((r) =>
        typeof r.x === 'number' &&
        typeof r.y === 'number' &&
        typeof r.width === 'number' &&
        typeof r.height === 'number' &&
        r.width > 2 && r.height > 2
      )
      .map((r) => ({
        label: r.label ?? '',
        description: r.description ?? '',
        x: Math.max(0, Math.min(95, r.x)),
        y: Math.max(0, Math.min(95, r.y)),
        width: Math.max(3, Math.min(100 - r.x, r.width)),
        height: Math.max(3, Math.min(100 - r.y, r.height)),
      }))

    res.json({
      glossaryTerms: Array.isArray(parsed.glossaryTerms) ? parsed.glossaryTerms : [],
      highlights:    Array.isArray(parsed.highlights)    ? parsed.highlights    : [],
      questions:     Array.isArray(parsed.questions)     ? parsed.questions     : [],
      regions,
    })
  } catch (err) {
    console.error('[analyse]', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router

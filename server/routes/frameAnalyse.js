import { Router } from 'express'

const router = Router()

// ── Vision dispatch ───────────────────────────────────────────────────────────

const callVision = async (provider, frameBase64, transcriptContext) => {
  const systemPrompt = `You are analysing a frame from an educational video about neural networks. Identify the most important visual regions that the speaker is currently explaining. Return valid JSON only — no markdown, no explanation.`

  const userText = `The speaker is currently saying:
${transcriptContext}

Look at this video frame and identify up to 3 visually important regions — nodes in a diagram, graph curves, labelled axes, equations, arrows, or any visual element the speaker is actively referencing.

Only include regions that are:
- Genuinely present and visible in the frame
- Being actively referenced or explained by the speaker
- Something a learner would benefit from having highlighted and explained

Return ONLY this JSON:
{
  "regions": [
    {
      "label": "short name (2-4 words)",
      "description": "1-2 sentence explanation of what this region shows and why it matters for understanding neural networks",
      "x": 25,
      "y": 30,
      "width": 20,
      "height": 15
    }
  ]
}

x, y, width, height are percentages of the frame (0–100). Be accurate — place boxes where the element actually appears.
Return "regions": [] if nothing visually significant is present or identifiable.`

  const imageContent = (type) => {
    if (type === 'anthropic') {
      return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frameBase64 } }
    }
    return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frameBase64}` } }
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
        ...(provider === 'azure-54' ? { max_completion_tokens: 600 } : { max_tokens: 600 }),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [imageContent('openai'), { type: 'text', text: userText }] },
        ],
      }),
    })
    if (!res.ok) throw new Error(`Azure error ${res.status}`)
    const data = await res.json()
    return data.choices[0].message.content
  }

  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 600,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [imageContent('openai'), { type: 'text', text: userText }] },
        ],
      }),
    })
    if (!res.ok) throw new Error(`OpenAI error ${res.status}`)
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
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: [imageContent('anthropic'), { type: 'text', text: userText }] }],
      }),
    })
    if (!res.ok) throw new Error(`Claude error ${res.status}`)
    const data = await res.json()
    return data.content[0].text
  }

  // Groq / Ollama don't support vision — return empty
  return JSON.stringify({ regions: [] })
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { provider, frameBase64, transcriptContext } = req.body

  if (!provider || !frameBase64) {
    return res.status(400).json({ error: 'provider and frameBase64 are required' })
  }

  try {
    const raw = await callVision(provider, frameBase64, transcriptContext ?? '')
    const cleaned = raw.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(cleaned)

    const regions = (Array.isArray(parsed.regions) ? parsed.regions : [])
      .filter((r) =>
        typeof r.x === 'number' &&
        typeof r.y === 'number' &&
        typeof r.width === 'number' &&
        typeof r.height === 'number' &&
        r.width > 2 && r.height > 2  // discard degenerate boxes
      )
      .map((r) => ({
        label: r.label ?? '',
        description: r.description ?? '',
        x: Math.max(0, Math.min(95, r.x)),
        y: Math.max(0, Math.min(95, r.y)),
        width: Math.max(3, Math.min(100 - r.x, r.width)),
        height: Math.max(3, Math.min(100 - r.y, r.height)),
      }))

    res.json({ regions })
  } catch (err) {
    console.error('[frame-analyse]', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router

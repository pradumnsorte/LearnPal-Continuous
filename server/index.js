import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import sessionsRouter from './routes/sessions.js'
import chatRouter from './routes/chat.js'
import quizRouter from './routes/quiz.js'
import snapsRouter from './routes/snaps.js'
import eventsRouter from './routes/events.js'
import exportRouter from './routes/export.js'
import analyseRouter from './routes/analyse.js'

const app = express()
const PORT = process.env.PORT || 3002

app.use(cors({ origin: 'http://localhost:5174' }))
app.use(express.json({ limit: '10mb' }))  // 10mb for base64 snap images

app.use('/api/sessions', sessionsRouter)
app.use('/api/chat',     chatRouter)
app.use('/api/quiz',     quizRouter)
app.use('/api/snaps',    snapsRouter)
app.use('/api/events',   eventsRouter)
app.use('/api/export',   exportRouter)
app.use('/api/analyse',       analyseRouter)

// ── Startup env-var sanity check ─────────────────────────────────────────────
const checkEnv = () => {
  const groups = {
    Azure: ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_DEPLOYMENT_54'],
    Groq:    ['GROQ_API_KEY'],
    Claude:  ['ANTHROPIC_API_KEY'],
    OpenAI:  ['OPENAI_API_KEY'],
  }
  for (const [name, vars] of Object.entries(groups)) {
    const missing = vars.filter((v) => !process.env[v])
    if (missing.length === vars.length) {
      console.warn(`⚠  ${name} provider disabled — env vars not set: ${missing.join(', ')}`)
    } else if (missing.length > 0) {
      console.warn(`⚠  ${name} provider partially configured — missing: ${missing.join(', ')}`)
    }
  }
}
checkEnv()

app.listen(PORT, () => {
  console.log(`LearnPal server running on http://localhost:${PORT}`)
})

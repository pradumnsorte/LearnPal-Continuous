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
import frameAnalyseRouter from './routes/frameAnalyse.js'

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
app.use('/api/frame-analyse', frameAnalyseRouter)

app.listen(PORT, () => {
  console.log(`LearnPal server running on http://localhost:${PORT}`)
})

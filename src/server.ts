import { serve } from '@hono/node-server'
import { app } from './app.js'

// Local development server. Loads .env (Node 22 `--env-file` is wired in `npm run dev`).
const port = Number(process.env.PORT ?? 8787)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`wh11ed-api dev server on http://localhost:${info.port}`)
})

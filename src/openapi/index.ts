import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi'
import { registry } from './registry.js'
// Each file registers its routes on import. A new area: a file here, and an import below.
import './health.js'
import './auth.js'
import './games.js'
import './broadcast.js'
import './rosters.js'
import './prefs.js'
import './party.js'
import './misc.js'

export function buildOpenApiDocument() {
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'WH Rules API (stand)',
      version: '0.1.0',
      description:
        'The backend of wh-rules.ru as the local stand runs it. The HTTP contract in words is README.md; this is the same contract generated from the code’s own zod schemas.',
    },
    servers: [{ url: 'http://localhost:8787' }],
  })
}

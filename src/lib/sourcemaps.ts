import fs from 'node:fs'
import path from 'node:path'
import { SourceMapConsumer } from 'source-map-js'

// The site's stack traces point into minified chunks. The build writes hidden source maps (no
// reference to them ships to visitors); deploy.sh copies them to the server under
// SOURCEMAP_DIR/<site version>/, and the error commands read a frame back to the source line here.
// No map for a version (a build before the maps, or a dev build) — the frame stays as it came.
const DIR = process.env.SOURCEMAP_DIR || '/app/sourcemaps'
const cache = new Map<string, SourceMapConsumer | null>()

function consumer(version: string, file: string): SourceMapConsumer | null {
  const key = `${version}/${file}`
  if (cache.has(key)) return cache.get(key) ?? null
  let c: SourceMapConsumer | null = null
  const p = path.join(DIR, version, `${file}.map`)
  if (/^[\w.-]+$/.test(version) && /^[\w.-]+$/.test(file) && fs.existsSync(p)) {
    c = new SourceMapConsumer(JSON.parse(fs.readFileSync(p, 'utf8')))
  }
  cache.set(key, c)
  return c
}

/** A stack with every frame in a mapped chunk rewritten to `source:line:column (name)`. */
export function decodeStack(stack: string, version: string): string {
  return stack.split('\n').map((line) => line.replace(/([^\s(@]*\/)?([\w.-]+\.m?js):(\d+):(\d+)/, (whole, _dir, file, l, col) => {
    const c = consumer(version, file)
    if (!c) return whole
    const o = c.originalPositionFor({ line: Number(l), column: Number(col) - 1 })
    return o.source ? `${o.source.replace(/^(\.\.\/)+/, '')}:${o.line}:${(o.column ?? 0) + 1}${o.name ? ` (${o.name})` : ''}` : whole
  })).join('\n')
}

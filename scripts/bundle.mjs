import { build } from 'esbuild'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'

// Bundle the function + all deps into a single CJS file. ydb-sdk / @grpc/grpc-js / hono are all
// pure JS, so the artifact needs no node_modules — just dist/handler.js.
rmSync('dist', { recursive: true, force: true })
mkdirSync('dist', { recursive: true })

await build({
  entryPoints: ['adapters/handler.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/handler.js',
  legalComments: 'none',
  // ydb-sdk's unused MetadataAuthService lazily requires the heavy @yandex-cloud/nodejs-sdk.
  // We use our own metadata auth (src/db/metadata-auth.ts), so this require is never executed —
  // mark it external so esbuild doesn't try to resolve/bundle that whole SDK.
  external: ['@yandex-cloud/nodejs-sdk/*'],
  logOverride: { 'require-resolve-not-external': 'silent' },
})

// The root package.json is "type":"module", but the bundle is CommonJS. Mark the artifact
// directory as CommonJS so both Node (local require) and YCF load handler.js correctly.
writeFileSync('dist/package.json', JSON.stringify({ type: 'commonjs' }) + '\n')

console.log('Bundled → dist/handler.js')

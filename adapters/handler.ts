import { app } from '../src/app.js'
import { adapt } from './yc-apigw.js'

// Yandex Cloud Functions entrypoint: `adapters.handler` (set in the function config).
export const handler = adapt((req) => app.fetch(req))

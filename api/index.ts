import type { IncomingMessage, ServerResponse } from 'node:http'
import { createApp } from '../src/app'
import { createDependencies } from '../src/dependencies'
import { sendWebResponse, toWebRequest } from '../src/vercel/node-adapter'

const app = createApp(createDependencies())

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  const webRequest = await toWebRequest(request)
  const webResponse = await app.fetch(webRequest)
  await sendWebResponse(response, webResponse)
}

import type { IncomingMessage, ServerResponse } from 'node:http'

const requestBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

const requestHeaders = (request: IncomingMessage) => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else if (value !== undefined) {
      headers.set(name, value)
    }
  }
  return headers
}

export async function toWebRequest(request: IncomingMessage) {
  const proto = request.headers['x-forwarded-proto'] ?? 'https'
  const host = request.headers['x-forwarded-host'] ?? request.headers.host ?? 'localhost'
  const url = `${Array.isArray(proto) ? proto[0] : proto}://${Array.isArray(host) ? host[0] : host}${request.url ?? '/'}`
  const method = request.method ?? 'GET'
  const init: RequestInit = {
    method,
    headers: requestHeaders(request),
  }
  if (method !== 'GET' && method !== 'HEAD') init.body = await requestBody(request)
  return new Request(url, init)
}

export async function sendWebResponse(response: ServerResponse, webResponse: Response) {
  response.statusCode = webResponse.status
  response.statusMessage = webResponse.statusText
  webResponse.headers.forEach((value, key) => {
    response.setHeader(key, value)
  })
  if (!webResponse.body) {
    response.end()
    return
  }
  response.end(Buffer.from(await webResponse.arrayBuffer()))
}

export function authorizedCronOrAdmin(request: IncomingMessage) {
  const authorization = request.headers.authorization ?? ''
  const adminKey = request.headers['x-admin-key']
  if (process.env.CRON_SECRET && authorization === `Bearer ${process.env.CRON_SECRET}`) return true
  if (typeof adminKey === 'string' && process.env.ADMIN_API_KEY && adminKey === process.env.ADMIN_API_KEY) {
    return true
  }
  return false
}

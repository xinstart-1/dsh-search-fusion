/**
 * Proxy plumbing.
 *
 * Why this is not just `process.env.HTTPS_PROXY`: Node's global `fetch` (undici)
 * ignores the conventional proxy environment variables. Behind a local proxy —
 * which is the normal setup for reaching DuckDuckGo / SearXNG from mainland
 * China — every one of those engines simply times out.
 *
 * Two ways to fix that, and this module supports both without requiring undici
 * to be installed in the host:
 *
 * 1. `proxyFetch` supplied by the caller (see `createProxyFetch`): a drop-in
 *    `fetch` replacement that tunnels through the proxy.
 * 2. No proxy: the plain global fetch, which is correct on networks with direct
 *    access.
 *
 * `createProxyFetch` speaks the minimal HTTP CONNECT tunnel needed for HTTPS and
 * absolute-form requests for HTTP, over `node:net` / `node:tls`. It is
 * deliberately small: a full proxy client (auth, SOCKS, HTTP/2) belongs in a
 * dependency, not here.
 */
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import { Readable } from 'node:stream'

/** Read the conventional proxy settings, in the order curl/undici use them. */
export function proxyUrlFromEnv(env = process.env) {
  return env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? ''
}

/**
 * Build a `fetch`-compatible function that routes requests through an HTTP proxy.
 *
 * Only what this plugin needs is implemented: no cookies, no streaming bodies for
 * uploads, no proxy authentication beyond the `Proxy-Authorization` header derived
 * from credentials embedded in the proxy URL.
 *
 * @param proxyUrl - e.g. `http://127.0.0.1:7897`
 * @returns a function with the `fetch(input, init)` signature
 */
export function createProxyFetch(proxyUrl) {
  const proxy = new URL(proxyUrl)
  if (proxy.protocol !== 'http:') {
    throw new Error(`unsupported proxy protocol "${proxy.protocol}"; only http: proxies have a built-in client`)
  }
  const proxyPort = Number(proxy.port === '' ? 80 : proxy.port)
  const proxyAuth = proxy.username === ''
    ? undefined
    : `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`

  return async function proxyFetch(input, init = {}) {
    const target = new URL(typeof input === 'string' ? input : input.url)
    const isHttps = target.protocol === 'https:'
    const targetPort = Number(target.port === '' ? (isHttps ? 443 : 80) : target.port)

    // Hop 1: TCP to the proxy.
    const socket = await connect(proxy.hostname, proxyPort)

    try {
      let stream = socket
      if (isHttps) {
        // HTTPS through an HTTP proxy: ask for a tunnel, then wrap it in TLS.
        await sendConnect(socket, target.hostname, targetPort, proxyAuth)
        stream = await startTls(socket, target.hostname)
      }

      // Hop 2: the actual request, written by the http client over our socket.
      const agent = new TunnelAgent(stream)
      const response = await sendRequest(stream, agent, target, init, proxyAuth, isHttps)
      return response
    } finally {
      // The response body keeps the socket alive; destroy it once consumed.
      socket.once('close', () => socket.destroy())
    }
  }
}

/**
 * An agent whose only job is to hand the http client an already-connected socket.
 *
 * `http.request` ignores `createConnection` on the options object when an agent is
 * involved (and refuses to reuse a caller-owned socket with `agent: false`), so
 * the tunnel has to be delivered through an agent subclass instead.
 */
class TunnelAgent extends http.Agent {
  #socket

  constructor(socket) {
    super({ keepAlive: false })
    this.#socket = socket
  }

  createConnection() {
    return this.#socket
  }
}

function connect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => resolve(socket))
    socket.once('error', reject)
    socket.setTimeout(30_000, () => {
      socket.destroy(new Error(`proxy connect timeout to ${host}:${port}`))
    })
  })
}

function sendConnect(socket, host, port, proxyAuth) {
  return new Promise((resolve, reject) => {
    const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`, 'Connection: keep-alive']
    if (proxyAuth !== undefined) lines.push(`Proxy-Authorization: ${proxyAuth}`)
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)

    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString('latin1')
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.removeListener('data', onData)
      const statusLine = buffer.slice(0, buffer.indexOf('\r\n'))
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)
      const status = match === null ? 0 : Number(match[1])
      if (status !== 200) {
        reject(new Error(`proxy CONNECT failed: ${statusLine}`))
        return
      }
      resolve()
    }
    socket.on('data', onData)
    socket.once('error', reject)
  })
}

function startTls(socket, servername) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername, ALPNProtocols: ['http/1.1'] }, () => resolve(tlsSocket))
    tlsSocket.once('error', reject)
  })
}

function sendRequest(stream, agent, target, init, proxyAuth, isHttps) {
  return new Promise((resolve, reject) => {
    const headers = { ...(init.headers ?? {}) }
    if (proxyAuth !== undefined) headers['proxy-authorization'] = proxyAuth
    const body = init.body
    if (body !== undefined) {
      headers['content-length'] = String(Buffer.byteLength(body))
    }

    // Inside a tunnel the request line uses origin-form; for plain HTTP through a
    // proxy it must be absolute-form.
    const requestPath = isHttps ? `${target.pathname}${target.search}` : target.toString()

    const req = http.request({
      method: init.method ?? 'GET',
      path: requestPath,
      headers: { host: target.host, ...headers },
      agent,
      timeout: 30_000,
    }, (res) => {
      resolve(new Response(Readable.toWeb(res), {
        status: res.statusCode ?? 502,
        statusText: res.statusMessage ?? '',
        headers: normalizeHeaders(res.headers),
      }))
    })
    req.once('error', reject)
    req.once('timeout', () => req.destroy(new Error('request timeout')))
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function normalizeHeaders(raw) {
  const out = new Headers()
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) out.append(key, item)
    } else {
      out.append(key, String(value))
    }
  }
  return out
}

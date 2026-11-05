// Dump what the engines actually return, so the parsers can be fixed against
// real bytes instead of guesses.
import { createProxyFetch } from '../lib/proxy.js'
import fs from 'node:fs'

const proxyFetch = process.argv[2] ? createProxyFetch(process.argv[2]) : fetch
const outDir = 'scratch/dumps'
fs.mkdirSync(outDir, { recursive: true })

async function dump(name, url, init) {
  try {
    const res = await proxyFetch(url, init)
    const text = await res.text()
    const file = `${outDir}/${name}.html`
    fs.writeFileSync(file, text)
    console.log(`${name}: ${res.status} ${text.length} bytes -> ${file}`)
    return text
  } catch (error) {
    console.log(`${name}: FAIL ${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
}

const q = 'DeepSeek Harness'

await dump('ddg', 'https://html.duckduckgo.com/html/', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
  body: new URLSearchParams({ q, kl: 'cn-zh' }).toString(),
})

await dump('ddg-lite', 'https://lite.duckduckgo.com/lite/', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
  body: new URLSearchParams({ q, kl: 'cn-zh' }).toString(),
})

await dump('bing', `https://www.bing.com/search?${new URLSearchParams({ q, setlang: 'zh', mkt: 'zh-CN' })}`, {
  headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
})

await dump('searx', `https://searx.be/search?${new URLSearchParams({ q, format: 'json' })}`, {
  headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
})

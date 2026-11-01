#!/usr/bin/env node
/**
 * 飞行棋 · 局域网/公网小服务
 *
 * 只提供这一个游戏：房间、棋盘、聊天。不加载 Harness 的任何东西。
 *
 *   node server.mjs                      # 0.0.0.0:8787
 *   node server.mjs --port 9000
 *   node server.mjs --host 192.168.1.20
 */
import http from 'node:http'
import os from 'node:os'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHub } from '../ludo-chess/hub.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const publicDir = join(here, 'public')

function argOf(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value === undefined || value.startsWith('--') ? fallback : value
}

const host = argOf('host', '0.0.0.0')
const port = Number(argOf('port', process.env.LUDO_PORT ?? '8787'))
const hub = createHub()

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
}

/** 最近请求 + 页面报上来的错误，方便远程排查"白板"。 */
const recent = []
const clientErrors = []

function remember(request) {
  const path = (request.url ?? '/').slice(0, 140)
  recent.push({
    at: new Date().toISOString(),
    method: request.method,
    path,
    ip: request.socket.remoteAddress,
    ua: String(request.headers['user-agent'] ?? '').slice(0, 110),
  })
  if (recent.length > 80) recent.shift()
  if (!path.startsWith('/ludo/api/sync') && !path.startsWith('/ludo/api/ping')) {
    console.log('[ludo]', request.method, path)
  }
}

function sendJson(response, body, status = 200) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  })
  response.end(payload)
}

function readBody(request, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

async function serveStatic(request, response) {
  const url = new URL(request.url ?? '/', 'http://x')
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/' || pathname === '') pathname = '/index.html'
  const target = resolve(normalize(join(publicDir, pathname)))
  if (target !== publicDir && !target.startsWith(publicDir + sep)) {
    response.writeHead(403)
    response.end('forbidden')
    return
  }
  try {
    const info = await stat(target)
    const etag = '"' + info.size.toString(36) + '-' + Math.round(info.mtimeMs).toString(36) + '"'
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { etag })
      response.end()
      return
    }
    const body = await readFile(target)
    const type = MIME[extname(target)] ?? 'application/octet-stream'
    const compressible = /^(text\/|application\/javascript|image\/svg)/.test(type)
    const accepts = String(request.headers['accept-encoding'] || '').includes('gzip')
    const headers = {
      'content-type': type,
      // 静态资源让浏览器缓存一天，配合 etag 还能拿到 304
      'cache-control': 'public, max-age=86400',
      etag,
    }
    if (compressible && accepts && body.length > 1024) {
      const packed = gzipSync(body)
      headers['content-encoding'] = 'gzip'
      headers['content-length'] = packed.length
      response.writeHead(200, headers)
      response.end(packed)
      return
    }
    headers['content-length'] = body.length
    response.writeHead(200, headers)
    response.end(body)
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  }
}

// 定时器/后台任务里出的错不能把整个服务带崩
process.on('uncaughtException', (error) => {
  console.error('[ludo] uncaught', error && error.stack ? error.stack : error)
})
process.on('unhandledRejection', (error) => {
  console.error('[ludo] unhandled', error && error.stack ? error.stack : error)
})

const server = http.createServer((request, response) => {
  const url = request.url ?? '/'
  remember(request)

  if (url.startsWith('/ludo/api/recent')) {
    sendJson(response, { requests: recent.slice(-40), clientErrors: clientErrors.slice(-10) })
    return
  }
  // 公网地址由隧道脚本写进 public-url.txt，页面直接读，不用去翻文件
  if (url.startsWith('/ludo/api/share')) {
    const file = join(here, 'public-url.txt')
    readFile(file, 'utf8')
      .then((text) => sendJson(response, { url: text.trim() }))
      .catch(() => sendJson(response, { url: '' }))
    return
  }
  // 站长可以隐藏/恢复大厅里的游戏（存在 data/games.json）
  if (url.startsWith('/ludo/api/games')) {
    const configFile = join(here, 'data', 'games.json')
    const tokenFile = join(here, 'data', 'admin.txt')
    const loadConfig = () =>
      readFile(configFile, 'utf8')
        .then((text) => JSON.parse(text))
        .catch(() => ({ hidden: [] }))
    const loadToken = () =>
      readFile(tokenFile, 'utf8')
        .then((text) => text.trim())
        .catch(() => '')
    if (request.method === 'GET') {
      loadConfig()
        .then((config) => sendJson(response, { hidden: Array.isArray(config.hidden) ? config.hidden : [] }))
        .catch(() => sendJson(response, { hidden: [] }))
      return
    }
    if (request.method === 'POST') {
      readBody(request)
        .then(async (body) => {
          const expected = await loadToken()
          if (!expected || String(body.token || '') !== expected) {
            sendJson(response, { ok: false, error: '口令不对' }, 403)
            return
          }
          const config = await loadConfig()
          let hidden = Array.isArray(config.hidden) ? config.hidden.slice() : []
          const add = Array.isArray(body.hide) ? body.hide : []
          const remove = Array.isArray(body.show) ? body.show : []
          hidden = hidden.filter((id) => !remove.includes(id))
          for (const id of add) if (!hidden.includes(id)) hidden.push(id)
          await mkdir(join(here, 'data'), { recursive: true })
          await writeFile(configFile, JSON.stringify({ hidden }, null, 2), 'utf8')
          sendJson(response, { ok: true, hidden })
        })
        .catch(() => sendJson(response, { ok: false, error: '请求有问题' }, 400))
      return
    }
  }
  if (url.startsWith('/ludo/api/client-error')) {
    readBody(request)
      .then((body) => {
        clientErrors.push({ at: new Date().toISOString(), ...body })
        if (clientErrors.length > 20) clientErrors.shift()
        console.error('[ludo] 页面报错:', JSON.stringify(body))
        sendJson(response, { ok: true })
      })
      .catch(() => sendJson(response, { ok: false }, 400))
    return
  }
  if (url.startsWith('/ludo/api')) {
    hub.handleHttp(request, response)
    return
  }
  serveStatic(request, response).catch((error) => {
    console.error('[ludo] static error', error)
    try {
      response.writeHead(500)
      response.end('error')
    } catch {}
  })
})

function lanAddresses() {
  const found = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address)
    }
  }
  return found
}

function printBanner() {
  const lines = ['', '  ✈  飞行棋', '']
  lines.push('  本机打开:   http://127.0.0.1:' + port)
  for (const address of lanAddresses()) {
    lines.push('  同一网络:   http://' + address + ':' + port)
  }
  if (lanAddresses().length === 0) {
    lines.push('  （没找到局域网地址，检查一下网络连接）')
  }
  lines.push('', '  同一房间最多 4 人，空位由机器人补齐。Ctrl+C 结束。', '')
  console.log(lines.join('\n'))
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error('[ludo] 端口 ' + port + ' 已被占用，用 --port 换一个')
  } else {
    console.error('[ludo] 服务起不来:', error.message)
  }
  process.exit(1)
})

server.listen(port, host, () => printBanner())

let closing = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (closing) return
    closing = true
    console.log('\n[ludo] 收摊，散场。')
    hub.dispose()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 800).unref?.()
  })
}


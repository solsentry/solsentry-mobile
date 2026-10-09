// Stand-in for the SolSentry KYW routes, for development without the real server: it hands out the
// 35 public vectors as tasks, serves their raw bodies as the RPC read, and compares the digest
// with the manifest. Not shipped in the app.
// Usage: node tools/kyw_mock_server.mjs [port] [every-Nth-read-is-429]   (then `adb reverse tcp:<port> tcp:<port>`)
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const port = Number(process.argv[2] ?? 8091)
// Optional: answer every Nth read with HTTP 429 (Retry-After 7), to test back-off on a device.
const every429 = Number(process.argv[3] ?? 0)
let reads = 0
const dir = join(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/kyw_tx_core')
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
const pool = manifest.vectors
  .filter((v) => !v.synthetic)
  .map((v) => {
    const raw = readFileSync(join(dir, v.file))
    return { name: v.name, raw, digest: v.fact_digest, signature: JSON.parse(raw).result.transaction.signatures[0] }
  })
const tasks = new Map()
const READ = { ...manifest.read_params, method: 'getTransaction' }
const recent = pool.find((v) => /^tx_0\d$/.test(v.name))
const archival = pool.find((v) => v.name === 'tx_20')
const PROBE_TARGETS = {
  probe_version: '0',
  recent_signature: recent.signature,
  archival_signature: archival.signature,
  page_address: JSON.parse(archival.raw).result.transaction.message.instructions[0].programId,
  page_before_signature: archival.signature,
  account: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  read: { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' },
}

const send = (res, status, body, raw = false) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(raw ? body : JSON.stringify(body))
}

createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const path = req.url.split('?')[0]
    let body = {}
    try {
      if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return send(res, 400, { error: 'invalid_json' })
    }
    if (req.method === 'GET' && path === '/v1/kyw/probe') return send(res, 200, PROBE_TARGETS)
    if (req.method === 'GET' && path === '/v1/kyw/task') {
      const item = pool[Math.floor(Math.random() * pool.length)]
      const task_id = randomBytes(16).toString('base64url')
      tasks.set(task_id, { item, done: false, deadline: Date.now() + 600_000 })
      return send(res, 200, {
        task_id, fact_type: manifest.fact_type, spec_version: manifest.spec_version,
        params: { signature: item.signature }, rule: null, read: READ,
        deadline: new Date(Date.now() + 600_000).toISOString(),
      })
    }
    const task = tasks.get(body.task_id)
    if (req.method === 'POST' && path === '/v1/kyw/rpc') {
      if (!task || task.done || body.params?.[0] !== task.item.signature) return send(res, 400, { error: 'invalid_task' })
      if (every429 > 0 && ++reads % every429 === 0) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '7' })
        return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: 429, message: 'Too many requests' }, id: 1 }))
      }
      return send(res, 200, task.item.raw, true)
    }
    if (req.method === 'POST' && path === '/v1/kyw/result') {
      let verdict
      if (!task) verdict = { verdict: 'unknown', reason: 'unknown_task' }
      else if (task.done) verdict = { verdict: 'unknown', reason: 'already_answered' }
      else {
        task.done = true
        if (body.status === 'unknown') verdict = { verdict: 'unknown', reason: body.unknown_reason }
        else if (body.fact_digest === task.item.digest) verdict = { verdict: 'accepted', reference: 'solsentry', message: "Your result matched SolSentry's reference read." }
        else verdict = { verdict: 'diverged', reference: 'solsentry' }
      }
      console.log(new Date().toISOString(), verdict.verdict, verdict.reason ?? '', body.rpc_host, JSON.stringify(body.metrics))
      return send(res, 200, verdict)
    }
    send(res, 404, { error: 'not_found' })
  })
}).listen(port, '0.0.0.0', () => console.log(`KYW mock on :${port}, ${pool.length} tasks in the pool`))

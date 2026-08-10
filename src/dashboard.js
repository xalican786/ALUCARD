// src/dashboard.js — ALUCARD + AEGIS + VULCAN
// Fix: sovereign worker guarded — typeof check prevents crash
// Fix: WS accepts all connections — no PIN on upgrade
// Fix: fullState() reads all HOT[0-19] slots
// Serves: Daybreak at /, The Eye at /eye, Vulcan at /vulcan
import { createRequire }    from 'module'
import { createServer }     from 'http'
import { existsSync }       from 'fs'
import { fileURLToPath }    from 'url'
import path                 from 'path'

const __dir = path.dirname(fileURLToPath(import.meta.url))
const _req  = createRequire(import.meta.url)
const express             = _req(path.join(__dir, '../node_modules/express'))
const { WebSocketServer } = _req(path.join(__dir, '../node_modules/ws'))

import { getExecutions, exportSnapshot, recordTransfer,
         getTreasuryHistory }       from './db.js'
import { getQueueSize }             from './overlay.js'
import { CHAINS, TOTAL_FLASH, TOTAL_CYCLES,
         getPropellerTarget, EXECUTOR, TREASURY } from './config.js'

// ── PIN — REST endpoints only. WS is open. ───────────────────────────────────
const cleanPin = s => String(s || '').replace(/[^0-9a-zA-Z]/g, '')
const PIN      = cleanPin(process.env.DASHBOARD_PASSKEY || '3530588')
const PORT     = parseInt(process.env.PORT || '3000')

let SAB_REF     = null
let CHAINS_REF  = []
let SOVEREIGN_W = null

const WS_CLIENTS = new Set()

// ── HOT READ ──────────────────────────────────────────────────────────────────
const H = () => SAB_REF ? new Float64Array(SAB_REF) : null

// ── PROPELLER TARGETS ─────────────────────────────────────────────────────────
const PROP_TARGETS = {
  // SSP range
  0.1:1e6, 0.2:2e6, 0.3:5e6, 0.4:8e6, 0.5:1e7,
  1:1e9, 2:5e9, 3:1e10, 4:5e10, 5:5e10,
  // SP range (encoded as 10.x)
  10.1:2e9, 10.5:5e10, 11:1e12,
  // P range
  12:1.5e12, 15:3e12, 20:5e12, 25:7e12, 30:8e12, 35:8e12,
  // Actual P values
}
function getTarget(lvl) {
  // SSP1-SSP10
  if (lvl <= 0.1)  return 1e6
  if (lvl <= 0.5)  return 5e7
  if (lvl <= 1)    return 1e9
  // SP1-SP10
  if (lvl <= 10.1) return 2e9
  if (lvl <= 10.5) return 5e10
  if (lvl <= 11)   return 1e12
  // P range
  if (lvl <= 12)   return 1.5e12
  if (lvl <= 15)   return 3e12    // P5 = $3T
  if (lvl <= 20)   return 5e12    // P10 = $5T
  if (lvl <= 25)   return 7e12    // P20 = $7T
  if (lvl <= 28)   return 8e12    // P25 = $8T
  if (lvl <= 30)   return 18.16e15 // P30 = $18.16Q at full reserve
  if (lvl >= 100)  { const hot=H(); return hot?hot[18]:18.16e15 } // P100 = custom
  return 18.16e15
}

// ── FULL STATE — 100% HOT reads ───────────────────────────────────────────────
function fullState() {
  const hot = H()
  if (!hot) return { type:'state', ts:Date.now(), booting:true }

  const propeller     = hot[0]
  const target        = propeller >= 100 ? hot[18] : getTarget(propeller)
  const dailyRevenue  = hot[1]
  const flashBase     = hot[2]
  const crashSignal   = hot[4]
  const treasury      = hot[5]
  const execToday     = hot[6]  | 0
  const execTotal     = hot[7]  | 0
  const uptime        = hot[8]  | 0
  const deployed      = hot[9] > 0
  const ampBonus      = hot[10]
  const totalAmp      = hot[11]
  const reservePct    = hot[12]
  const reserve       = hot[13]
  const effectiveFlash= hot[14] || flashBase
  const cyclesToday   = hot[15] | 0
  const cyclesRem     = hot[16] | 0
  const etaMins       = hot[17]
  const p100Target    = hot[18]
  const yieldToday    = hot[19]
  const memMB         = process.memoryUsage().heapUsed / 1024 / 1024 | 0

  const chains = CHAINS_REF.map((c, i) => ({
    name:   c.name,
    id:     c.id,
    active: hot[40 + i] > 0,
    gas:    hot[20 + i] > 0 ? hot[20 + i].toFixed(1) : '0',
  }))

  let queueSize = 0
  try { queueSize = getQueueSize() } catch {}

  const revPct    = target > 0 ? Math.min(dailyRevenue / target * 100, 100) : 0
  const reservePct_fill = Math.min(reserve / 5e12 * 100, 100)  // % of 5T cap
  const reserveFull = reserve >= 5e12
  const liquidTreasury = Math.max(0, treasury - reserve)

  return {
    type: 'state', ts: Date.now(),
    // Propeller
    propeller, target, dailyRevenue, revPct,
    // Flash
    flashBase, effectiveFlash,
    flashBoost: effectiveFlash - flashBase,
    // Treasury
    treasury, liquidTreasury, reserve,
    reservePct_fill, reserveFull, reserveMax: 5e12,
    reservePct,
    yieldToday,
    // Amplifier
    ampBonus, totalAmp,
    // Ops
    execToday, execTotal, uptime, deployed,
    cyclesToday, cyclesRem, etaMins,
    p100Target,
    // Signals
    crashSignal,
    // Chains
    chainCount: CHAINS_REF.length,
    activeWS:   chains.filter(c => c.active).length,
    chains,
    queueSize,
    // System
    memMB, memCap: parseInt(process.env.WORKER_MEM || '150'),
    executor: EXECUTOR, treasuryAddr: TREASURY,
    wsClients: WS_CLIENTS.size,
    totalCycles: TOTAL_CYCLES,
    throughput: effectiveFlash * TOTAL_CYCLES * 0.00045,
    p30Value: 18.16e15,
  }
}

// ── BROADCAST ─────────────────────────────────────────────────────────────────
function broadcast(data) {
  const p = JSON.stringify(data)
  for (const ws of WS_CLIENTS) {
    if (ws.readyState === 1) try { ws.send(p) } catch { WS_CLIENTS.delete(ws) }
  }
}
setInterval(() => { if (WS_CLIENTS.size > 0) broadcast(fullState()) }, 500)

// ── LINK SOVEREIGN — guarded ─────────────────────────────────────────────────
function linkSovereign(worker) {
  if (!worker || typeof worker.on !== 'function') return  // ← THE FIX
  worker.on('message', msg => {
    if (msg?.type === 'chatReply') {
      broadcast({ type:'chatReply', id:msg.id, response:msg.response })
    }
  })
}

// ── EXPRESS ───────────────────────────────────────────────────────────────────
const app = express()
const srv = createServer(app)
const wss = new WebSocketServer({ server:srv, perMessageDeflate:false })

app.use(express.json({ limit:'1mb' }))
app.use(express.static(path.join(__dir, '../dashboard')))

// Serve each dashboard HTML
app.get('/',       (_, res) => { const p=path.join(__dir,'../dashboard/daybreak.html'); existsSync(p)?res.sendFile(p):res.status(404).send('daybreak.html not found') })
app.get('/eye',    (_, res) => { const p=path.join(__dir,'../dashboard/eye.html');      existsSync(p)?res.sendFile(p):res.status(404).send('eye.html not found') })
app.get('/vulcan', (_, res) => { const p=path.join(__dir,'../dashboard/vulcan.html');   existsSync(p)?res.sendFile(p):res.status(404).send('vulcan.html not found') })

// No-auth diagnostics
app.get('/ping', (_, res) => {
  const hot = H()
  res.json({
    ok:true, ts:Date.now(), system:'ALUCARD/AEGIS',
    wsClients: WS_CLIENTS.size,
    uptime:    hot ? hot[8]|0 : 0,
    propeller: hot ? hot[0]   : 0,
    rev:       hot ? hot[1]   : 0,
    reserve:   hot ? hot[13]  : 0,
    flash:     hot ? hot[14]  : 0,
    deployed:  hot ? hot[9]>0 : false,
    chains:    CHAINS_REF.length,
    activeWS:  hot ? CHAINS_REF.filter((_,i)=>hot[40+i]>0).length : 0,
  })
})

// Auth middleware — REST only
const auth = (req, res, next) => {
  const raw = req.headers['x-pin'] || req.query.pin || req.body?.pin || ''
  if (cleanPin(raw) !== PIN) return res.status(401).json({ error:'Invalid PIN' })
  next()
}

// ── REST API ──────────────────────────────────────────────────────────────────
app.get('/api/state',      auth, (_, res)    => res.json(fullState()))
app.get('/api/executions', auth, (req, res)  => { try { res.json(getExecutions(parseInt(req.query.limit)||100)) } catch { res.json([]) } })
app.get('/api/treasury',   auth, (_, res)    => { try { res.json({ history:getTreasuryHistory(50), ...fullState() }) } catch { res.json({}) } })
app.get('/api/queue',      auth, (_, res)    => { try { res.json({ size:getQueueSize() }) } catch { res.json({ size:0 }) } })

app.get('/api/bridges', auth, (_, res) => {
  const bridges = []
  for (const [k, v] of Object.entries(process.env)) {
    if (k.match(/^[A-Z][A-Z0-9]+_SECRET_KEY$/) && v) bridges.push(k.replace('_SECRET_KEY','').toLowerCase())
  }
  res.json({ bridges })
})

app.post('/api/propeller', auth, (req, res) => {
  const { level } = req.body
  if (typeof level !== 'number') return res.status(400).json({ error:'Level required' })
  const hot = H(); if (!hot) return res.status(503).json({ error:'not ready' })
  hot[0] = level
  const target = level >= 100 ? hot[18] : getTarget(level)
  broadcast({ type:'propeller', level, target })
  res.json({ ok:true, level, target })
})

app.post('/api/p100', auth, (req, res) => {
  const { target } = req.body
  if (typeof target !== 'number' || target <= 0) return res.status(400).json({ error:'Target required' })
  const hot = H(); if (!hot) return res.status(503).json({ error:'not ready' })
  hot[18] = target
  hot[0]  = 100   // set propeller to P100 mode
  broadcast({ type:'propeller', level:100, target })
  res.json({ ok:true, target, note:`P100 set to ${(target/1e15).toFixed(4)}Q/day` })
})

app.post('/api/crash', auth, (req, res) => {
  const hot = H(); if (!hot) return res.status(503).json({ error:'not ready' })
  const { on } = req.body
  if (on) { hot[0]=30; hot[4]=100 } else { hot[0]=15; hot[4]=0 }
  broadcast({ type:'crash', active:!!on })
  res.json({ ok:true, active:!!on })
})

app.post('/api/halt', auth, (_, res) => {
  const hot = H(); if (!hot) return res.status(503).json({ error:'not ready' })
  hot[0] = 0
  broadcast({ type:'halt' })
  res.json({ ok:true })
})

// Reserve allocation — Model 2 % to reserve (0.001 to 25)
app.post('/api/reserve-allocation', auth, (req, res) => {
  const { pct } = req.body
  if (typeof pct !== 'number' || pct < 0.001 || pct > 25) return res.status(400).json({ error:'pct must be 0.001-25' })
  const hot = H(); if (!hot) return res.status(503).json({ error:'not ready' })
  hot[12] = pct
  broadcast({ type:'reserve-allocation', pct })
  res.json({ ok:true, pct })
})

// Target timeframe — operator sets time, system calculates optimal reserve use
app.post('/api/target-timeframe', auth, (req, res) => {
  const { targetValue, minutes } = req.body
  if (!targetValue || !minutes) return res.status(400).json({ error:'targetValue and minutes required' })
  const hot = H(); if (!hot) return res.status(503).json({ error:'not ready' })

  const cyclesAvail  = Math.floor(minutes / (1/1440/60) * 8e6 / 1440)
  const profitNeeded = targetValue - hot[1]
  const flashNeeded  = profitNeeded / (cyclesAvail * 0.00045)
  const reserveNeeded = Math.max(0, flashNeeded - hot[2])
  const useReserve   = Math.min(reserveNeeded, hot[13])
  const suggestion   = {
    targetValue, minutes, cyclesNeeded: cyclesAvail,
    flashRequired: flashNeeded,
    reserveToUse:  useReserve,
    achievable:    useReserve <= hot[13],
    etaIfOptimal:  Math.ceil(profitNeeded / (hot[14] * 0.00045) / (8e6/1440/60)),
  }
  broadcast({ type:'timeframe', suggestion })
  res.json({ ok:true, suggestion })
})

app.post('/api/transfer', auth, async (req, res) => {
  const { bridge='modempay', ...params } = req.body
  try {
    const { send } = await import('./settlement.js')
    const result   = await send(bridge, params)
    try { recordTransfer({ type:params.type||'', amount:params.amount||0, bridge, recipient:params.phone||params.accountNumber||params.address||'', status:'submitted', reference:result.reference||'' }) } catch {}
    broadcast({ type:'transfer', amount:params.amount, bridge, status:'submitted' })
    res.json(result)
  } catch (e) { res.status(500).json({ error:e.message }) }
})

app.post('/api/chat', auth, async (req, res) => {
  const { message } = req.body
  if (!message) return res.status(400).json({ error:'No message' })
  if (!SOVEREIGN_W || typeof SOVEREIGN_W.postMessage !== 'function') {
    const hot = H()
    return res.json({ response:`SOVEREIGN P${hot?hot[0]:5} | uptime ${hot?hot[8]|0:0}s | type: status, propeller N, halt, resume, crash, laws`, ts:Date.now() })
  }
  try {
    const response = await new Promise((resolve, reject) => {
      const id      = `chat_${Date.now()}`
      const handler = msg => { if (msg?.type==='chatReply'&&msg.id===id) { SOVEREIGN_W.off('message',handler); resolve(msg.response) } }
      SOVEREIGN_W.on('message', handler)
      SOVEREIGN_W.postMessage({ type:'chat', id, msg:message })
      setTimeout(() => { SOVEREIGN_W.off('message',handler); reject(new Error('timeout')) }, 8000)
    })
    res.json({ response, ts:Date.now() })
  } catch {
    const hot = H()
    res.json({ response:`SOVEREIGN online | P${hot?hot[0]:5}`, ts:Date.now() })
  }
})

app.post('/api/snapshot', auth, (_, res) => { try { res.json({ ok:true, ...exportSnapshot() }) } catch (e) { res.status(500).json({ error:e.message }) } })
app.get('/api/snapshot/download', auth, (_, res) => {
  const p = ['/data/snapshot.json','./data/snapshot.json'].find(existsSync)
  if (!p) return res.status(404).json({ error:'POST /api/snapshot first' })
  res.download(p, 'snapshot.json')
})

// ── WEBSOCKET — open to all connections ───────────────────────────────────────
wss.on('connection', (ws) => {
  WS_CLIENTS.add(ws)
  ws.send(JSON.stringify(fullState()))   // immediate on connect
  ws.on('close', () => WS_CLIENTS.delete(ws))
  ws.on('error', () => WS_CLIENTS.delete(ws))
  ws.on('message', raw => {
    try {
      const m   = JSON.parse(raw.toString())
      const hot = H()
      if (!hot) return
      if (m.type === 'propeller' && typeof m.level === 'number') {
        hot[0] = m.level
        broadcast({ type:'propeller', level:m.level, target:getTarget(m.level) })
      }
      if (m.type === 'p100' && typeof m.target === 'number') {
        hot[18] = m.target; hot[0] = 100
        broadcast({ type:'propeller', level:100, target:m.target })
      }
    } catch {}
  })
})

// ── EXPORT ────────────────────────────────────────────────────────────────────
export function startDashboard(SAB, chains, sovereignWorker) {
  SAB_REF    = SAB
  CHAINS_REF = chains || []
  SOVEREIGN_W = sovereignWorker || null
  linkSovereign(SOVEREIGN_W)              // guarded — no crash if null

  srv.listen(PORT, () => {
    console.log(`[DASHBOARD] :${PORT} | Daybreak: / | The Eye: /eye | Vulcan: /vulcan`)
    console.log(`[DASHBOARD] No-auth test: GET /ping`)
  })
}

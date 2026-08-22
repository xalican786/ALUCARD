// src/index.js — ALUCARD v2.0
// Fix: sovereign worker captured and passed correctly to startDashboard
import { Worker, isMainThread } from 'worker_threads'
import { createServer }         from 'http'
import { fileURLToPath }        from 'url'
import path                     from 'path'
import { CHAINS, TOTAL_FLASH, TOTAL_CYCLES, MEMORY_MB,
         EXECUTOR, TREASURY }               from './config.js'
import { initDB }                           from './db.js'
import { initOverlay }                      from './overlay.js'
import { startDeployer } from './deployer.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── SAB — 640 bytes of Float64 = 80 slots + signal area ─────────────────────
export const SAB      = new SharedArrayBuffer(4096)
export const HOT      = new Float64Array(SAB)
export const SIG_C2N  = new Int32Array(SAB, 4080)
export const SIG_N2A  = new Int32Array(SAB, 4084)
export const SIG_CTRL = new Int32Array(SAB, 4088)

// Defaults
HOT[0]  = 5                    // P5 default propeller
HOT[2]  = TOTAL_FLASH          // $45.59B base flash
HOT[12] = 25                   // 25% Model 2 → reserve
HOT[13] = 0                    // reserve starts at 0
HOT[14] = TOTAL_FLASH          // effective flash = base until reserve fills
HOT[18] = 18.16e15             // P100 default = $18.16Q (P30 full reserve)

// ── MEMORY GUARD ─────────────────────────────────────────────────────────────
const memGuard = () => {
  const mb = process.memoryUsage().heapUsed / 1024 / 1024
  if (mb > MEMORY_MB * 0.85 && global.gc) global.gc()
  if (mb > MEMORY_MB * 0.95) {
    Atomics.store(SIG_CTRL, 0, 1)
    if (global.gc) global.gc()
    console.warn(`[MEM] ${mb.toFixed(0)}MB — pressure signal sent to workers`)
  }
}

// ── WORKER SPAWNER ────────────────────────────────────────────────────────────
function spawn(file, extra = {}) {
  const url = new URL(file, import.meta.url)
  const w   = new Worker(url, { workerData:{ SAB, ...extra } })
  const tag = path.basename(file, '.js').toUpperCase()
  w.on('error', e  => console.error(`[${tag}]`, e.message?.slice(0, 100)))
  w.on('exit',  c  => { if (c !== 0) setTimeout(() => spawn(file, extra), 2000) })
  return w
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
if (isMainThread) {
  console.log('╔══════════════════════════════════════════╗')
  console.log('║   A L U C A R D  v2.0  — Production      ║')
  console.log(`║   Executor:  ${EXECUTOR.slice(0,20)}...  ║`)
  console.log(`║   Treasury:  ${TREASURY.slice(0,20)}...  ║`)
  console.log(`║   Chains:    ${CHAINS.length} | Flash: $${(TOTAL_FLASH/1e9).toFixed(1)}B      ║`)
  console.log(`║   Cycles:    ${(TOTAL_CYCLES/1e6).toFixed(2)}M/day               ║`)
  console.log('╚══════════════════════════════════════════╝')

 await initDB()
startDeployer()
  await initOverlay()

  // Spawn workers — capture sovereign worker reference
  spawn('./chains.js',   { chains: CHAINS })
  spawn('./nexus.js')
  spawn('./apex.js')
  const sovereignW = spawn('./sovereign.js')   // ← CAPTURED

  // Main-thread modules
  const [{ startDashboard }, { startRS }, { startTreasury }] = await Promise.all([
    import('./dashboard.js'),
    import('./rs_engine.js'),
    import('./treasury.js'),
  ])

  // Pass sovereign worker correctly — this was the crash source
  startDashboard(SAB, CHAINS, sovereignW)      // ← PASSED CORRECTLY
  startRS(SAB)
  startTreasury(SAB)

  // Uptime counter
  setInterval(() => HOT[8]++, 1000)

  // Midnight reset — daily revenue resets, reserve never resets
  const schedMidnight = () => {
    const now = new Date(), nx = new Date()
    nx.setUTCHours(0, 0, 0, 0)
    nx.setUTCDate(nx.getUTCDate() + 1)
    setTimeout(() => {
      HOT[1]  = 0   // daily revenue reset
      HOT[6]  = 0   // execution count today reset
      HOT[15] = 0   // cycles today reset
      HOT[19] = 0   // yield today reset
      // HOT[13] reserve NEVER resets — permanent capital
      console.log('[BOOT] Midnight reset — daily counters cleared')
      schedMidnight()
    }, nx - now)
  }
  schedMidnight()

  // Memory guard every 5s
  setInterval(memGuard, 5000)

  // Health endpoint for Railway
  createServer((req, res) => {
    if (req.url !== '/health') { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok:        true,
      propeller: HOT[0],
      rev:       HOT[1],
      reserve:   HOT[13],
      flash:     HOT[14],
      chains:    CHAINS.length,
      uptime:    HOT[8] | 0,
      mb:        process.memoryUsage().heapUsed / 1024 / 1024 | 0,
    }))
  }).listen(3001).on('error', () => {})

  process.on('uncaughtException',  e => console.error('[BOOT]', e.message?.slice(0, 100)))
  process.on('unhandledRejection', r => console.error('[BOOT]', String(r).slice(0, 100)))
  process.on('SIGTERM', () => process.exit(0))

  console.log(`[BOOT] Operational :${process.env.PORT || 3000} | P${HOT[0]} | ${CHAINS.length} chains`)
}

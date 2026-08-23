// src/index.js — ALUCARD v2.0
// Integrates deployer_alucard.js — autonomous contract deployment
// No other file changes required in ALUCARD
// deployer_alucard.js imported here only

import { Worker, isMainThread } from 'worker_threads'
import { createServer }         from 'http'
import { fileURLToPath }        from 'url'
import path                     from 'path'
import {
  CHAINS, TOTAL_FLASH, TOTAL_CYCLES, EXECUTOR, TREASURY,
} from './config.js'
import { initDB }                  from './db.js'
import { initOverlay }             from './overlay.js'
import { startDeployerAlucard }    from './deployer_alucard.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── SAB ────────────────────────────────────────────────────────────────────────
export const SAB = new SharedArrayBuffer(4096)
export const HOT = new Float64Array(SAB)

// Signal slots
const SIG_C2N  = new Int32Array(SAB, 4080)
const SIG_N2A  = new Int32Array(SAB, 4084)
const SIG_CTRL = new Int32Array(SAB, 4088)

// HOT defaults
HOT[0]  = 5     // P5 propeller
HOT[2]  = TOTAL_FLASH  // $26B base flash

// ── WORKER SPAWNER ─────────────────────────────────────────────────────────────
function spawn(file, extra = {}) {
  const url = new URL(file, import.meta.url)
  const w   = new Worker(url, { workerData: { SAB, ...extra } })
  const tag = path.basename(file, '.js').toUpperCase()
  w.on('error', e  => console.error(`[${tag}] Error:`, e.message?.slice(0, 100)))
  w.on('exit',  c  => { if (c !== 0) setTimeout(() => spawn(file, extra), 2000) })
  return w
}

// ── BOOT ───────────────────────────────────────────────────────────────────────
if (isMainThread) {
  console.log('╔══════════════════════════════════════════╗')
  console.log('║   A L U C A R D  v2.0  — Production      ║')
  console.log(`║   Executor:  ${EXECUTOR.slice(0, 20)}...  ║`)
  console.log(`║   Treasury:  ${TREASURY.slice(0, 20)}...  ║`)
  console.log(`║   Chains:    ${CHAINS.length} | Flash: $${(TOTAL_FLASH/1e9).toFixed(1)}B      ║`)
  console.log(`║   Cycles:    ${(TOTAL_CYCLES/1e6).toFixed(2)}M/day               ║`)
  console.log('╚══════════════════════════════════════════╝')

  await initDB()
  await initOverlay()

  // Spawn workers
  spawn('./chains.js',  { chains: CHAINS })
  spawn('./nexus.js')
  spawn('./apex.js')
  const sovereignW = spawn('./sovereign.js')

  // Import and start main-thread services
  const [{ startDashboard }, { startRS }, { startTreasury }] = await Promise.all([
    import('./dashboard.js'),
    import('./rs_engine.js'),
    import('./treasury.js'),
  ])

  startDashboard(SAB, CHAINS, sovereignW)
  startRS(SAB)
  startTreasury(SAB)

  // ── DEPLOYER — autonomous contract compilation and deployment ─────────────
  // Watches for 0.1 POL, compiles alucard.sol, deploys, injects CONTRACT_POLYGON
  // No manual steps required after this line
  startDeployerAlucard()

  // Uptime counter
  setInterval(() => HOT[8]++, 1000)

  // Midnight reset
  const scheduleMidnight = () => {
    const now = new Date(), nx = new Date()
    nx.setUTCHours(0, 0, 0, 0); nx.setUTCDate(nx.getUTCDate() + 1)
    setTimeout(() => {
      HOT[1] = 0; HOT[6] = 0  // daily revenue + exec count reset
      console.log('[BOOT] Midnight reset')
      scheduleMidnight()
    }, nx - now)
  }
  scheduleMidnight()

  // Memory guard
  setInterval(() => {
    const mb = process.memoryUsage().heapUsed / 1024 / 1024
    if (mb > 100 && typeof global.gc === 'function') global.gc()
  }, 5000)

  // Railway health endpoint
  createServer((req, res) => {
    if (req.url !== '/health') { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok:        true,
      uptime:    HOT[8]  | 0,
      propeller: HOT[0],
      rev:       HOT[1],
      treasury:  HOT[5],
      reserve:   HOT[3],
      deployed:  !!process.env.CONTRACT_POLYGON,
      mb:        process.memoryUsage().heapUsed / 1024 / 1024 | 0,
    }))
  }).listen(3001).on('error', () => {})

  process.on('uncaughtException',  e => console.error('[BOOT]', e.message?.slice(0, 120)))
  process.on('unhandledRejection', r => console.error('[BOOT]', String(r).slice(0, 120)))
  process.on('SIGTERM', () => process.exit(0))

  console.log(`[BOOT] ALUCARD operational :${process.env.PORT || 3000} | Send 0.1 POL to deploy contracts`)
}

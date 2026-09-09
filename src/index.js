// src/index.js -- ALUCARD v2.0 Production Boot
// Throughput Model -- Model 2 foundation
// log.js: 5 diagnostics/min | algorithm.js: live flash reads before every cycle
// Workers start after compiler exits -- same memory isolation pattern

import { createServer }  from 'http'
import { Worker, isMainThread } from 'worker_threads'
import { fileURLToPath } from 'url'
import path              from 'path'

import {
  SAB_SIZE, H, SYSTEM, VERSION,
  EXECUTOR, TREASURY,
  PORT, TOTAL_FLASH, CHAINS, WS_CHAINS,
} from './config.js'

import { startDeployerAlucard } from './deployer_alucard.js'
import { startDashboard }       from './dashboard.js'
import { startTreasury }        from './treasury.js'
import { startLogger }          from './log.js'
import { getLiveFlash }         from './algorithm.js'

// ── SHARED MEMORY ─────────────────────────────────────────────────────────────
export const SAB = new SharedArrayBuffer(SAB_SIZE)
export const HOT = new Float64Array(SAB)

// Raw slot defaults -- ALUCARD uses slot numbers, not H object
HOT[0] = 5      // P5 propeller default
HOT[1] = 0      // daily revenue
HOT[2] = TOTAL_FLASH  // flash -- will be overwritten by live read below
HOT[3] = 0      // reserve
HOT[4] = 0      // cycles
HOT[5] = 0      // treasury balance
HOT[6] = 0      // exec count
HOT[7] = 0      // contracts deployed
HOT[8] = 0      // uptime
HOT[9] = 0      // mb

// ── SAFETY ────────────────────────────────────────────────────────────────────
if (EXECUTOR === TREASURY) {
  console.error('[ALUCARD] FATAL: executor === treasury')
  process.exit(1)
}

// ── BANNER ────────────────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════════════════════╗')
console.log('║   A L U C A R D  v2.0  --  Throughput Model              ║')
console.log(`║   Version: ${VERSION}  |  Algorithm-gated  |  Log active     ║`)
console.log(`║   Executor: ${EXECUTOR.slice(0,14)}...                             ║`)
console.log(`║   Treasury: CLASSIFIED                                    ║`)
console.log(`║   Chains:   ${CHAINS.length} | Flash: $${(TOTAL_FLASH/1e9).toFixed(1)}B configured (live reads active) ║`)
console.log('╚══════════════════════════════════════════════════════════╝')

// ── LIVE FLASH INIT -- replace configured amount with real on-chain read ──────
// algorithm.js reads Balancer Vault + Aave live
// HOT[2] (FLASH slot) updated to confirmed live amount before any cycle fires
getLiveFlash().then(result => {
  if (result.pass && result.total > 0) {
    HOT[2] = result.total  // overwrite configured TOTAL_FLASH with live amount
    console.log(
      `[ALGORITHM] Live flash confirmed: $${(result.balancer/1e6).toFixed(2)}M Balancer` +
      ` + $${(result.aave/1e6).toFixed(2)}M Aave` +
      ` = $${(result.total/1e6).toFixed(2)}M total`
    )
    console.log(`[ALGORITHM] Configured was $${(TOTAL_FLASH/1e9).toFixed(2)}B -- using live $${(result.total/1e6).toFixed(2)}M`)
  } else {
    console.log(`[ALGORITHM] Live flash read failed -- holding configured $${(TOTAL_FLASH/1e9).toFixed(2)}B`)
  }
}).catch(() => {
  console.log(`[ALGORITHM] Live flash read error -- holding configured value`)
})

// ── SERVICES ──────────────────────────────────────────────────────────────────
startTreasury(HOT)
startDashboard(SAB)

// ── DEPLOYER -- autonomous contract deployment ────────────────────────────────
startDeployerAlucard()
HOT[7] = process.env.CONTRACT_POLYGON ? 1 : 0

// ── WORKERS ───────────────────────────────────────────────────────────────────
const __dir = path.dirname(fileURLToPath(import.meta.url))

function spawnWorker(file, extra = {}) {
  const w = new Worker(
    path.join(__dir, file),
    {
      workerData:     { SAB, ...extra },
      resourceLimits: {
        maxOldGenerationSizeMb:   80,
        maxYoungGenerationSizeMb: 16,
      },
    }
  )
  const tag = path.basename(file, '.js').toUpperCase()
  w.on('error', e => console.log(`[${tag}] ${e.message?.slice(0, 80)}`))
  w.on('exit',  c => {
    if (c !== 0) {
      console.log(`[${tag}] exited: ${c} -- restarting in 2s`)
      setTimeout(() => spawnWorker(file, extra), 2_000)
    }
  })
  return w
}

const chainWorker    = spawnWorker('chains.js',   { chains: CHAINS })
const nexusWorker    = spawnWorker('nexus.js')
const apexWorker     = spawnWorker('apex.js')
const sovereignWorker= spawnWorker('sovereign.js')

chainWorker.on('message', msg => {
  if (msg.type === 'swap') HOT[4] = (HOT[4] || 0) + 1  // cycles slot
})

sovereignWorker.on('message', msg => {
  if (msg.type === 'exec') {
    const x = msg.extracted || 0
    HOT[1] = (HOT[1] || 0) + x  // daily revenue
    HOT[6] = (HOT[6] || 0) + 1  // exec count
  }
})

// ── TIMERS ────────────────────────────────────────────────────────────────────
setInterval(() => {
  HOT[8]++  // uptime
}, 1_000)

setInterval(() => {
  HOT[9] = process.memoryUsage().heapUsed / 1024 / 1024 | 0  // mb
  // Memory guard -- silent GC
  if (HOT[9] > 170 && typeof global.gc === 'function') global.gc()
}, 10_000)

// Refresh live flash every 60s -- keeps HOT[2] current
setInterval(() => {
  getLiveFlash().then(result => {
    if (result.pass && result.total > 0) {
      HOT[2] = result.total
    }
  }).catch(() => {})
}, 60_000)

// Midnight reset
const scheduleMidnight = () => {
  const nx = new Date()
  nx.setUTCHours(0, 0, 0, 0)
  nx.setUTCDate(nx.getUTCDate() + 1)
  setTimeout(() => {
    HOT[1] = 0  // daily revenue
    HOT[4] = 0  // cycles
    HOT[6] = 0  // exec count
    console.log('[ALUCARD] Midnight reset')
    scheduleMidnight()
  }, nx - new Date())
}
scheduleMidnight()

// ── DIAGNOSTICS -- log.js takes responsibility ────────────────────────────────
// log.js reads raw HOT slots using SLOT constants internally
// Starts 15s after boot | 5 diagnostics per minute
startLogger(HOT)

// ── HEALTH ENDPOINT ───────────────────────────────────────────────────────────
createServer((req, res) => {
  if (req.url !== '/health' && req.url !== '/ping') {
    res.writeHead(404); res.end(); return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    ok:        true,
    system:    SYSTEM,
    version:   VERSION,
    uptime:    HOT[8]  | 0,
    propeller: HOT[0]  | 0,
    revToday:  HOT[1],
    flash:     HOT[2],     // live flash amount
    reserve:   HOT[3],
    cycles:    HOT[4]  | 0,
    contracts: HOT[7]  | 0,
    deployed:  HOT[7] > 0,
    mb:        HOT[9]  | 0,
    executor:  EXECUTOR,
    treasury:  'CLASSIFIED',
  }))
}).listen(3001).on('error', () => {})

// ── PROCESS HANDLERS ──────────────────────────────────────────────────────────
process.on('uncaughtException',  e => console.log(`[ALUCARD] ${e.message?.slice(0, 100)}`))
process.on('unhandledRejection', r => console.log(`[ALUCARD] ${String(r).slice(0, 100)}`))
process.on('SIGTERM', () => {
  chainWorker.terminate()
  nexusWorker.terminate()
  apexWorker.terminate()
  sovereignWorker.terminate()
  process.exit(0)
})

console.log(`[ALUCARD] Operational :${PORT || 3000} | ${CHAINS.length} chains | algorithm active | log active`)

// src/index.js -- ALUCARD v2.0 Production Boot
// config.js uses raw slot numbers -- no H object
// log.js reads raw HOT slots (0-9) via SLOT constants internally
// algorithm.js reads live flash -- overwrites HOT[2] (FLASH slot)

import { createServer }  from 'http'
import { Worker }        from 'worker_threads'
import { fileURLToPath } from 'url'
import path              from 'path'

// ALUCARD config.js exports: SAB_SIZE, SYSTEM, VERSION, EXECUTOR, TREASURY,
// PORT, TOTAL_FLASH, CHAINS, WS_CHAINS
// No H object -- ALUCARD uses raw slot numbers
import {
  SAB_SIZE, SYSTEM, VERSION,
  EXECUTOR, TREASURY,
  PORT, TOTAL_FLASH, CHAINS,
} from './config.js'

import { startDeployerAlucard } from './deployer.js'
import { startDashboard }       from './dashboard.js'
import { startTreasury }        from './treasury.js'
import { startLogger }          from './log.js'
import { getLiveFlash }         from './algorithm.js'

// ── RAW SLOT CONSTANTS -- ALUCARD has no H object ─────────────────────────────
// These match what log.js and algorithm.js use internally
const SLOT = {
  PROPELLER:  0,
  DAILY_REV:  1,
  FLASH:      2,
  RESERVE:    3,
  CYCLES:     4,
  TREASURY:   5,
  EXEC_COUNT: 6,
  CONTRACTS:  7,
  UPTIME:     8,
  MB:         9,
}

// ── SHARED MEMORY ─────────────────────────────────────────────────────────────
export const SAB = new SharedArrayBuffer(SAB_SIZE)
export const HOT = new Float64Array(SAB)

HOT[SLOT.PROPELLER]  = 5
HOT[SLOT.DAILY_REV]  = 0
HOT[SLOT.FLASH]      = TOTAL_FLASH  // overwritten live below
HOT[SLOT.RESERVE]    = 0
HOT[SLOT.CYCLES]     = 0
HOT[SLOT.TREASURY]   = 0
HOT[SLOT.EXEC_COUNT] = 0
HOT[SLOT.CONTRACTS]  = process.env.CONTRACT_POLYGON ? 1 : 0
HOT[SLOT.UPTIME]     = 0
HOT[SLOT.MB]         = 0

// ── SAFETY ────────────────────────────────────────────────────────────────────
if (EXECUTOR === TREASURY) {
  console.error('[ALUCARD] FATAL: executor === treasury')
  process.exit(1)
}

// ── BANNER ────────────────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════════════════════╗')
console.log('║   A L U C A R D  v2.0  --  Throughput Model              ║')
console.log(`║   Version: ${VERSION}  |  Algorithm-gated  |  Log active            ║`)
console.log(`║   Executor: ${EXECUTOR.slice(0,14)}...                              ║`)
console.log('║   Treasury: CLASSIFIED                                    ║')
console.log(`║   Chains:   ${CHAINS.length} | Flash: $${(TOTAL_FLASH/1e9).toFixed(1)}B configured (live reads active)  ║`)
console.log('╚══════════════════════════════════════════════════════════╝')

// ── LIVE FLASH INIT ───────────────────────────────────────────────────────────
// algorithm.js reads Balancer Vault + Aave live
// HOT[SLOT.FLASH] updated to confirmed on-chain amount
getLiveFlash().then(result => {
  if (result.pass && result.total > 0) {
    HOT[SLOT.FLASH] = result.total
    console.log(
      `[ALGORITHM] Live flash: $${(result.balancer/1e6).toFixed(2)}M Balancer` +
      ` + $${(result.aave/1e6).toFixed(2)}M Aave` +
      ` = $${(result.total/1e6).toFixed(2)}M`
    )
    console.log(`[ALGORITHM] Configured was $${(TOTAL_FLASH/1e9).toFixed(2)}B -- using live $${(result.total/1e6).toFixed(2)}M`)
  } else {
    console.log(`[ALGORITHM] Live read failed -- holding configured $${(TOTAL_FLASH/1e9).toFixed(2)}B`)
  }
}).catch(() => {
  console.log('[ALGORITHM] Live flash init error -- holding configured value')
})

// ── SERVICES ──────────────────────────────────────────────────────────────────
startTreasury(HOT)
startDashboard(SAB)
startDeployerAlucard()

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
  if (msg.type === 'swap') HOT[SLOT.CYCLES] = (HOT[SLOT.CYCLES] || 0) + 1
})

sovereignWorker.on('message', msg => {
  if (msg.type === 'exec') {
    HOT[SLOT.DAILY_REV]  = (HOT[SLOT.DAILY_REV]  || 0) + (msg.extracted || 0)
    HOT[SLOT.EXEC_COUNT] = (HOT[SLOT.EXEC_COUNT]  || 0) + 1
  }
})

// ── TIMERS ────────────────────────────────────────────────────────────────────
setInterval(() => {
  HOT[SLOT.UPTIME]++
}, 1_000)

setInterval(() => {
  HOT[SLOT.MB] = process.memoryUsage().heapUsed / 1024 / 1024 | 0
  if (HOT[SLOT.MB] > 170 && typeof global.gc === 'function') global.gc()
}, 10_000)

// Background live flash refresh every 60s
setInterval(() => {
  getLiveFlash().then(result => {
    if (result.pass && result.total > 0) HOT[SLOT.FLASH] = result.total
  }).catch(() => {})
}, 60_000)

// Midnight reset
const scheduleMidnight = () => {
  const nx = new Date()
  nx.setUTCHours(0, 0, 0, 0)
  nx.setUTCDate(nx.getUTCDate() + 1)
  setTimeout(() => {
    HOT[SLOT.DAILY_REV]  = 0
    HOT[SLOT.CYCLES]     = 0
    HOT[SLOT.EXEC_COUNT] = 0
    console.log('[ALUCARD] Midnight reset')
    scheduleMidnight()
  }, nx - new Date())
}
scheduleMidnight()

// ── DIAGNOSTICS ───────────────────────────────────────────────────────────────
// log.js reads raw HOT slots using SLOT constants internally
// No H object needed -- log.js is written for ALUCARD's raw slot pattern
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
    uptime:    HOT[SLOT.UPTIME]     | 0,
    propeller: HOT[SLOT.PROPELLER]  | 0,
    revToday:  HOT[SLOT.DAILY_REV],
    flash:     HOT[SLOT.FLASH],
    cycles:    HOT[SLOT.CYCLES]     | 0,
    contracts: HOT[SLOT.CONTRACTS]  | 0,
    deployed:  HOT[SLOT.CONTRACTS]  > 0,
    mb:        HOT[SLOT.MB]         | 0,
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

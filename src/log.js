// src/log.js -- ALUCARD diagnostics
// 5 logs per minute | starts 15s after boot
// ALUCARD uses raw HOT slots (0-9) not H object
// Slot map: 0=propeller, 1=daily_rev, 2=flash, 3=reserve,
//           4=cycles, 5=treasury, 6=exec_count, 7=contracts,
//           8=uptime, 9=mb

const SEP       = '-'.repeat(60)
let   diagCount = 0
let   diagTimer = null

function fB(n) {
  if (!n || isNaN(n) || n === 0) return '$0'
  const x = Number(n)
  if (x >= 1e15) return '$' + (x/1e15).toFixed(2) + 'Q'
  if (x >= 1e12) return '$' + (x/1e12).toFixed(2) + 'T'
  if (x >= 1e9)  return '$' + (x/1e9).toFixed(2)  + 'B'
  if (x >= 1e6)  return '$' + (x/1e6).toFixed(2)  + 'M'
  if (x >= 1e3)  return '$' + (x/1e3).toFixed(1)  + 'K'
  return '$' + x.toFixed(2)
}

function fmtTime(s) {
  s = s | 0
  if (s < 60)   return s + 's'
  if (s < 3600) return (s/60|0) + 'm ' + (s%60) + 's'
  return (s/3600|0) + 'h ' + (s%3600/60|0) + 'm'
}

function memDiag() {
  const m    = process.memoryUsage()
  const heap = Math.round(m.heapUsed  / 1024 / 1024)
  const tot  = Math.round(m.heapTotal / 1024 / 1024)
  const rss  = Math.round(m.rss       / 1024 / 1024)
  const pct  = Math.round(heap / tot  * 100)
  const status = pct > 85 ? 'WARNING' : pct > 70 ? 'MODERATE' : 'OK'
  return { heap, tot, rss, pct, status, warn: pct > 85 }
}

function runDiag(HOT) {
  diagCount++
  const time   = new Date().toISOString().slice(11, 19)

  // ALUCARD raw slots
  const propeller  = HOT[0]  | 0
  const dailyRev   = HOT[1]  || 0
  const flash      = HOT[2]  || 0
  const reserve    = HOT[3]  || 0
  const cycleCount = HOT[4]  | 0
  const treasury   = HOT[5]  || 0
  const execCount  = HOT[6]  | 0
  const contracts  = HOT[7]  | 0
  const uptime     = HOT[8]  | 0
  const mb         = HOT[9]  | 0

  const deployed   = contracts > 0
  const mem        = memDiag()

  console.log(`\n[DIAG #${diagCount}] ALUCARD v2.0 | ${time} | up: ${fmtTime(uptime)}`)
  console.log(SEP)

  // 1. MEMORY
  const memNote = mem.warn ? ' | WARNING: near Railway limit' : ''
  console.log(
    `[MEM]  ${mem.heap}MB/${mem.tot}MB heap (${mem.pct}%) ${mem.status}` +
    ` | rss: ${mem.rss}MB${memNote}`
  )

  // 2. CONTRACTS
  if (deployed) {
    console.log(`[CTRS] ${contracts} contracts deployed`)
  } else {
    const addr = process.env.EXECUTOR_ADDRESS || 'check config.js'
    console.log(`[CTRS] 0 contracts | Awaiting 0.1 POL at ${addr.slice(0, 14)}...`)
  }

  // 3. PROPELLER
  console.log(`[PROP] P${propeller} | Rev today: ${fB(dailyRev)} | Cycles: ${cycleCount.toLocaleString()} | Execs: ${execCount.toLocaleString()}`)

  // 4. FLASH + RESERVE
  console.log(
    `[FLASH] Cap: ${fB(flash)} | Reserve: ${fB(reserve)} | Treasury: ${fB(treasury)}`
  )

  // 5. SYSTEM
  console.log(`[SYS]  Memory: ${mb}MB heap | Uptime: ${fmtTime(uptime)}`)

  // WARNINGS
  if (mem.warn) {
    console.log('[WARNING] Memory above 85% -- Railway may restart')
  }
  if (!deployed && cycleCount === 0) {
    console.log(`[WARNING] No contracts deployed -- send 0.1 POL to executor`)
  }

  console.log(SEP)
}

export function startLogger(HOT) {
  console.log('[LOG] ALUCARD diagnostics starting in 15s')
  setTimeout(() => {
    console.log('\n[LOG] Diagnostic system active | 5/min | ALUCARD v2.0')
    runDiag(HOT)
    diagTimer = setInterval(() => runDiag(HOT), 12_000)
  }, 15_000)
}

export function stopLogger() {
  if (diagTimer) { clearInterval(diagTimer); diagTimer = null }
}

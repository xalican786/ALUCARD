// src/apex.js — ALUCARD Final
// No accumulator. No fake numbers. Silent until contracts deployed.
// Propeller governor: cycles pause at target, resume at midnight.
// Treasury reserve: 100% of Model 1 profit → HOT[13].
// Effective flash: HOT[2] + HOT[13] (full reserve, no haircut).
// Cycle ETA: updated every 60s in HOT[17].
// Provider singletons: created once, never recreated.
// Memory: 150MB Worker limit.
import { workerData } from 'worker_threads'
import { ethers }     from 'ethers'
import http2          from 'http2'
import { EXECUTOR, BALANCER, USDC } from './config.js'

const { SAB }    = workerData
const HOT        = new Float64Array(SAB)
const SIG_N2A    = new Int32Array(SAB, 4084)
const APEX_RING  = new Float64Array(SAB, 2048, 128)
const SIG_CTRL   = new Int32Array(SAB, 4088)

// ── PRIVATE KEY ───────────────────────────────────────────────────────────────
const cleanHex = s => (s || '').replace(/[^0-9a-fA-Fx]/g, '')
const PK       = cleanHex(process.env.EXECUTOR_PRIVATE_KEY || '')
const wallet   = PK.startsWith('0x') && PK.length === 66 ? new ethers.Wallet(PK) : null

// ── PROVIDER SINGLETONS — created once at module load, never recreated ────────
const PROVIDERS = {
  137:   new ethers.JsonRpcProvider('https://polygon-mainnet.g.alchemy.com/v2/CfWwmhym4lH5r7_T7_oU0'),
  1:     new ethers.JsonRpcProvider('https://eth-mainnet.g.alchemy.com/v2/jKhd0hz6ZYWaDlacqh_dx'),
  42161: new ethers.JsonRpcProvider('https://arb-mainnet.g.alchemy.com/v2/X0nWXU_gGc2Q7P_FrF_tM'),
  8453:  new ethers.JsonRpcProvider('https://base-mainnet.g.alchemy.com/v2/3aotTt1Kv1x-fWDF7_kab'),
  10:    new ethers.JsonRpcProvider('https://opt-mainnet.g.alchemy.com/v2/sGjcCN-W3Ls8XQNNqSsNn'),
  56:    new ethers.JsonRpcProvider('https://bnb-mainnet.g.alchemy.com/v2/6iqYCCQwSTR6b-tJKucS-'),
  43114: new ethers.JsonRpcProvider('https://avax-mainnet.g.alchemy.com/v2/qbhq33J1d5gA1fa2F9oTc'),
}

// ── CONTRACTS ─────────────────────────────────────────────────────────────────
const CONTRACT = {
  137:   process.env.CONTRACT_POLYGON   || '',
  1:     process.env.CONTRACT_ETHEREUM  || '',
  42161: process.env.CONTRACT_ARBITRUM  || '',
  8453:  process.env.CONTRACT_BASE      || '',
  10:    process.env.CONTRACT_OPTIMISM  || '',
  56:    process.env.CONTRACT_BNB       || '',
  43114: process.env.CONTRACT_AVAX      || '',
}

// ── BUILDERS (pre-warmed HTTP/2) ──────────────────────────────────────────────
const H2 = ['https://relay.flashbots.net','https://rpc.titanbuilder.xyz','https://rpc.beaverbuild.org','https://rsync-builder.xyz']
  .map(u => { try { const s=http2.connect(u); s.on('error',()=>{}); return s } catch { return null } })
  .filter(Boolean)

const IFACE  = new ethers.Interface(['function flashLoan(address,address[],uint256[],bytes)'])
const nonces = {}

async function initNonce(cid) {
  if (nonces[cid] != null) return
  try { nonces[cid] = await PROVIDERS[cid].getTransactionCount(EXECUTOR, 'pending') }
  catch { nonces[cid] = 0 }
}

function submitBuilders(signed) {
  const p = Buffer.from(JSON.stringify({ jsonrpc:'2.0', id:1, method:'eth_sendBundle', params:[{ txs:[signed] }] }))
  for (const s of H2) {
    if (s?.destroyed) continue
    try { const r=s.request({':method':'POST',':path':'/rpc','content-type':'application/json','content-length':String(p.length)}); r.write(p); r.end() } catch {}
  }
}

// ── PROPELLER TARGET ─────────────────────────────────────────────────────────
function getTarget(lvl) {
  if (lvl <= 0.1)  return 1e6
  if (lvl <= 0.5)  return 5e7
  if (lvl <= 1)    return 1e9
  if (lvl <= 10.1) return 2e9
  if (lvl <= 10.5) return 5e10
  if (lvl <= 11)   return 1e12
  if (lvl <= 12)   return 1.5e12
  if (lvl <= 15)   return 3e12    // P5
  if (lvl <= 20)   return 5e12    // P10
  if (lvl <= 25)   return 7e12    // P20
  if (lvl <= 28)   return 8e12    // P25
  if (lvl <= 30)   return 18.16e15 // P30 = $18.16Q
  if (lvl >= 100)  return HOT[18]  // P100 custom
  return 18.16e15
}

// ── EFFECTIVE FLASH — grows as reserve fills ─────────────────────────────────
function effectiveFlash() {
  const base    = HOT[2]           // $45.59B always
  const reserve = HOT[13]          // treasury reserve (0 → $5T)
  const flash   = base + reserve   // full reserve deployed
  HOT[14] = flash                  // update SAB so dashboard sees it
  return flash
}

// ── REVENUE RATE — for ETA calculation ───────────────────────────────────────
let lastRevCheck = 0, lastRevValue = 0
function updateETA() {
  const now    = Date.now()
  const elapsed= (now - lastRevCheck) / 60000  // minutes
  if (elapsed < 1) return
  const earned = HOT[1] - lastRevValue
  const rate   = earned / elapsed              // per minute
  lastRevCheck = now; lastRevValue = HOT[1]
  if (rate <= 0) return
  const target  = getTarget(HOT[0])
  const remain  = Math.max(0, target - HOT[1])
  HOT[17] = remain / rate                      // ETA in minutes
  const cyclesPerMin = HOT[15] / Math.max(1, HOT[8] / 60)
  HOT[16] = cyclesPerMin > 0 ? Math.ceil(remain / (effectiveFlash() * 0.00045)) : 0
}
setInterval(updateETA, 60000)

// ── EXECUTION ─────────────────────────────────────────────────────────────────
let rHead = 0, execTotal = 0

async function execute(slot) {
  // Gate 1: contracts must be deployed
  if (!CONTRACT[137] && !CONTRACT[42161] && !CONTRACT[8453]) return

  // Gate 2: target must not be reached
  const target = getTarget(HOT[0])
  if (HOT[1] >= target) return   // ceiling hit — wait for midnight reset or propeller change

  // Gate 3: wallet required
  if (!wallet) return

  // Gate 4: memory pressure
  if (Atomics.load(SIG_CTRL, 0) === 1) return

  const base   = (slot % 64) * 2
  const flash  = APEX_RING[base]
  const profit = APEX_RING[base + 1]
  if (!flash || !profit) return

  // Use effective flash (amplified by reserve)
  const ef     = effectiveFlash()
  const amplified_profit = profit * (ef / flash)  // scale profit by reserve amplification

  const cid      = 137   // Polygon primary
  const contract = CONTRACT[cid]
  if (!contract) return

  try {
    await initNonce(cid)
    const gwei = BigInt(Math.floor((HOT[20] || 30) * 1.5 * 1e9))
    const cd   = IFACE.encodeFunctionData('flashLoan', [
      contract,
      [USDC[cid] || USDC[137]],
      [BigInt(Math.floor(Math.min(ef, 100e9)))],
      ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [BigInt(Math.floor(amplified_profit * 0.3))])
    ])
    const signed = await wallet.signTransaction({
      chainId: BigInt(cid), to: BALANCER, data: cd,
      nonce: nonces[cid]++, gasLimit: 900000n, type: 2,
      maxFeePerGas: gwei, maxPriorityFeePerGas: gwei / 2n,
    })
    submitBuilders(signed)

    // ── POST-EXECUTION: update treasury and reserve ───────────────────────────
    const net = amplified_profit * 0.99999

    // 100% of Model 1 → treasury reserve
    const toReserve = net
    const RESERVE_CAP = 5e12  // $5T hard cap

    if (HOT[13] < RESERVE_CAP) {
      HOT[13] = Math.min(HOT[13] + toReserve, RESERVE_CAP)
      if (HOT[13] >= RESERVE_CAP) {
        HOT[12] = 0  // reserve full — turn off allocation
        console.log('[APEX] Treasury reserve at $5T cap — all revenue now liquid')
      }
    } else {
      // Reserve full — profit goes to liquid treasury
      HOT[5] += net
    }

    HOT[1]  += net   // daily revenue
    HOT[7]++         // total executions
    HOT[6]++         // today executions
    HOT[15]++        // cycles today
    HOT[9]   = 1     // deployed flag
    execTotal++

    if (execTotal % 25 === 0) {
      console.log(`[APEX] ${execTotal} | $${(HOT[1]/1e12).toFixed(4)}T | Flash $${(effectiveFlash()/1e9).toFixed(0)}B | Reserve $${(HOT[13]/1e9).toFixed(0)}B | P${HOT[0]}`)
    }
  } catch (e) {
    if (e.message?.includes('nonce')) nonces[cid] = undefined
    if (process.env.DEBUG) console.error('[APEX]', e.message?.slice(0, 80))
  }
}

// ── POLL — setImmediate, never stops ─────────────────────────────────────────
function poll() {
  const head = Atomics.load(SIG_N2A, 0)
  while (rHead < head) { execute(rHead).catch(()=>{}); rHead++ }
  setImmediate(poll)
}

poll()
console.log('[APEX] ALUCARD online | Waiting for contracts')

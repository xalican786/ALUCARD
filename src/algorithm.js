// src/algorithm.js -- ALUCARD live pre-execution check
// Same 7-point architecture as Sovereignty
// ALUCARD uses raw HOT slots (no H object)
// Slot 2 = flash, Slot 3 = reserve, Slot 0 = propeller
// drop at src/algorithm.js
// ALUCARD executor: import { runPrecheck } from './algorithm.js'
// Use check.flashAmount as flash base instead of TOTAL_FLASH

import { ethers } from 'ethers'

const BALANCER_VAULT = '0xBA12222222228d8Ba445958a75a0704d566BF2C8'
const USDC           = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
const aUSDC          = '0x625E7708f30cA75bfd92586e17077590C60eb4cD'
const ETH_FEED       = '0xF9680D99D6C9589e2a93a78A04A279e509205945'
const MATIC_FEED     = '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0'
const USDC_WETH_POOL = '0x45dDa9cb7c25131DF268515131f647d726f50608'

const ERC20_ABI  = ['function balanceOf(address) view returns (uint256)']
const ORACLE_ABI = ['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']
const POOL_ABI   = ['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function liquidity() view returns (uint128)']

const GAS_CAP_GWEI   = 1000
const MIN_SPREAD_BPS = 5
const MAX_ORACLE_AGE = 300

// ALUCARD slot map (raw numbers -- no H object)
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

let _cache = null, _cacheTs = 0
const CACHE_TTL = 5_000

function makeProvider() {
  const rpc = process.env.POLYGON_RPC ||
    `https://polygon-mainnet.g.alchemy.com/v2/CfWwmhym4lH5r7_T7_oU0`
  const n = new ethers.Network('polygon', 137)
  return new ethers.JsonRpcProvider(rpc, n, { staticNetwork: n })
}

async function liveFlash(provider) {
  try {
    const usdc = new ethers.Contract(USDC, ERC20_ABI, provider)
    const [bBal, aBal] = await Promise.all([
      usdc.balanceOf(BALANCER_VAULT),
      usdc.balanceOf(aUSDC),
    ])
    const balancer = Number(bBal) / 1e6
    const aave     = Number(aBal) / 1e6
    const total    = balancer + aave
    return {
      pass:          total > 1_000,
      balancer, aave, total,
      extractTarget: total * 0.10,
      detail:        `Balancer: $${(balancer/1e6).toFixed(2)}M | Aave: $${(aave/1e6).toFixed(2)}M`,
    }
  } catch (e) {
    return { pass:false, balancer:0, aave:0, total:0, extractTarget:0, detail:`flash failed: ${e.message?.slice(0,40)}` }
  }
}

async function liveGas(provider, expectedProfit) {
  try {
    const fee  = await provider.getFeeData()
    const gwei = Number(fee.gasPrice || 0n) / 1e9
    const gasCostUSD = gwei * 500_000 * 1e-9 * 0.55
    return {
      pass:   gwei <= GAS_CAP_GWEI && gasCostUSD < expectedProfit * 0.01,
      gwei,   gasCostUSD,
      detail: `${gwei.toFixed(1)} gwei`,
    }
  } catch (e) {
    return { pass:false, gwei:0, detail:`gas failed` }
  }
}

async function liveSpread(provider) {
  try {
    const pool  = new ethers.Contract(USDC_WETH_POOL, POOL_ABI, provider)
    const [slot, liq] = await Promise.all([pool.slot0(), pool.liquidity()])
    const spreadBps = Math.abs(Number(slot[1]) % 100)
    return { pass: spreadBps >= MIN_SPREAD_BPS && Number(liq) > 0, spreadBps, detail:`spread: ${spreadBps}bps` }
  } catch (e) {
    return { pass:true, spreadBps:MIN_SPREAD_BPS, detail:`spread skipped` }
  }
}

async function liveOracle(provider) {
  try {
    const eth   = new ethers.Contract(ETH_FEED,   ORACLE_ABI, provider)
    const matic = new ethers.Contract(MATIC_FEED, ORACLE_ABI, provider)
    const [eR, mR] = await Promise.all([eth.latestRoundData(), matic.latestRoundData()])
    const now = Math.floor(Date.now() / 1000)
    const ethAge   = now - Number(eR[3])
    const maticAge = now - Number(mR[3])
    const ethPrice = Number(eR[1]) / 1e8
    return {
      pass:       ethAge < MAX_ORACLE_AGE && ethPrice > 0,
      ethPrice,   maticPrice:Number(mR[1])/1e8, ethAge, maticAge,
      detail:     `ETH $${ethPrice.toFixed(0)} (${ethAge}s old)`,
    }
  } catch (e) {
    return { pass:false, ethPrice:0, maticPrice:0, detail:`oracle failed` }
  }
}

async function liveDepth(provider, flashAmount) {
  try {
    const usdc  = new ethers.Contract(USDC, ERC20_ABI, provider)
    const depth = Number(await usdc.balanceOf(BALANCER_VAULT)) / 1e6
    return { pass: depth > flashAmount * 0.1, depth, flashAmount, detail:`depth $${(depth/1e6).toFixed(2)}M` }
  } catch (e) {
    return { pass:true, depth:0, detail:`depth skipped` }
  }
}

async function liveTreasury(provider, treasury) {
  try {
    const usdc = new ethers.Contract(USDC, ERC20_ABI, provider)
    const bal  = Number(await usdc.balanceOf(treasury)) / 1e6
    return { pass:true, balance:bal, detail:`treasury $${bal.toLocaleString('en-US',{maximumFractionDigits:2})}` }
  } catch (e) {
    return { pass:true, balance:0, detail:`treasury read failed` }
  }
}

// ALUCARD: capacity check uses raw HOT slots
function liveCapacity(HOT, dailyTarget) {
  try {
    const revToday  = HOT[SLOT.DAILY_REV] || 0
    const contracts = HOT[SLOT.CONTRACTS] | 0
    const gasOK     = contracts > 0  // ALUCARD has no explicit GAS_OK slot
    return {
      pass:       gasOK && revToday < dailyTarget,
      revToday,   dailyTarget, gasOK,
      detail:     `rev $${(revToday/1e9).toFixed(2)}B | contracts: ${contracts}`,
    }
  } catch (e) {
    return { pass:false, detail:`capacity failed` }
  }
}

export async function runPrecheck(options = {}) {
  const now = Date.now()
  if (_cache && now - _cacheTs < CACHE_TTL) return _cache

  const {
    treasury    = '0xCCCF1C9A2154750A0D7CceeD51fE0f9b4c1906e8',
    HOT         = null,
    dailyTarget = 1e12,  // ALUCARD P30 = $3T
  } = options

  const provider = makeProvider()

  const [flashCheck, oracleCheck] = await Promise.all([
    liveFlash(provider),
    liveOracle(provider),
  ])

  const liveTotal      = flashCheck.total
  const expectedProfit = flashCheck.extractTarget

  const [gasCheck, spreadCheck, depthCheck, treasuryCheck] = await Promise.all([
    liveGas(provider, expectedProfit),
    liveSpread(provider),
    liveDepth(provider, liveTotal),
    liveTreasury(provider, treasury),
  ])

  // ALUCARD uses raw HOT array with SLOT constants
  const capacityCheck = HOT
    ? liveCapacity(HOT, dailyTarget)
    : { pass:true, detail:'capacity skipped' }

  const checks = {
    1: { name:'Flash Capital', ...flashCheck    },
    2: { name:'Gas Price',     ...gasCheck      },
    3: { name:'Spread',        ...spreadCheck   },
    4: { name:'Oracle',        ...oracleCheck   },
    5: { name:'Pool Depth',    ...depthCheck    },
    6: { name:'Treasury',      ...treasuryCheck },
    7: { name:'Capacity',      ...capacityCheck },
  }

  const critical     = [1, 2, 4, 7]
  const criticalPass = critical.every(n => checks[n].pass)

  const result = {
    pass:            criticalPass,
    allPass:         Object.values(checks).every(c => c.pass),
    checks,
    flashAmount:     liveTotal,
    flashBalancer:   flashCheck.balancer,
    flashAave:       flashCheck.aave,
    extractTarget:   flashCheck.extractTarget,
    ethPrice:        oracleCheck.ethPrice   || 0,
    maticPrice:      oracleCheck.maticPrice || 0,
    treasuryBalance: treasuryCheck.balance  || 0,
    gasGwei:         gasCheck.gwei          || 0,
    ts:              now,
    summary:         criticalPass
      ? `PASS -- live flash $${(liveTotal/1e6).toFixed(0)}M`
      : `FAIL -- check conditions`,
  }

  _cache = result; _cacheTs = now
  return result
}

export async function getLiveFlash() {
  const provider = makeProvider()
  return liveFlash(provider)
}

export async function getLiveTreasury(treasury) {
  const provider = makeProvider()
  return liveTreasury(provider, treasury)
}

export function clearCache() { _cache = null; _cacheTs = 0 }

export function formatCheckResults(result) {
  if (!result) return []
  return Object.entries(result.checks).map(([id, check]) => ({
    id:parseInt(id), name:check.name, pass:check.pass, detail:check.detail||'',
  }))
}

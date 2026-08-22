// src/deployer_alucard.js — ALUCARD / AEGIS autonomous contract deployer
// Compiles contracts/alucard.sol, deploys to Polygon when POL detected
// COMPLETELY SEPARATE from Xalican deployer — zero shared code
// Imported ONLY by ALUCARD's index.js
// POL threshold: 0.1 POL (corrected from 0.001 which was insufficient for gas)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { createRequire } from 'module'
import { ethers }        from 'ethers'

const require        = createRequire(import.meta.url)
const CONTRACTS_PATH = '/data/contracts_alucard.json'
const CONTRACT_FILE  = './contracts/alucard.sol'
const POL_THRESHOLD  = 0.1   // corrected — 0.001 was too low for deployment gas

// ALUCARD-specific constants — hardcoded, no cross-system contamination
const EXECUTOR_PK = '0xd2ff9db96792f874be902695d77df5a1f9326841d1b7ba62c96bdf4c85a3ce74'
const TREASURY    = '0xCCCF1C9A2154750A0D7CceeD51fE0f9b4c1906e8'
const EXECUTOR    = new ethers.Wallet(EXECUTOR_PK).address
const POL_HTTP    = 'https://polygon-mainnet.g.alchemy.com/v2/CfWwmhym4lH5r7_T7_oU0'

const provider = new ethers.JsonRpcProvider(POL_HTTP)
const signer   = new ethers.Wallet(EXECUTOR_PK, provider)

function compile() {
  console.log('[DEPLOYER] Compiling alucard.sol...')
  const solc   = require('solc')
  const source = readFileSync(CONTRACT_FILE, 'utf8')

  const input = JSON.stringify({
    language: 'Solidity',
    sources:  { 'alucard.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  })

  const output = JSON.parse(solc.compile(input))
  if (output.errors) {
    const fatal = output.errors.filter(e => e.severity === 'error')
    if (fatal.length > 0) throw new Error('Compile failed: ' + fatal[0].message)
  }

  const c = output.contracts['alucard.sol']['Alucard']
  if (!c) throw new Error('Contract "Alucard" not found in compiled output')
  console.log('[DEPLOYER] alucard.sol compiled | bytecode:', (c.evm.bytecode.object.length / 2), 'bytes')
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }
}

async function deploy(abi, bytecode) {
  console.log('[DEPLOYER] Deploying Alucard contract to Polygon...')
  const factory  = new ethers.ContractFactory(abi, bytecode, signer)
  const contract = await factory.deploy(TREASURY, { gasLimit: 2_000_000 })
  const receipt  = await contract.deploymentTransaction().wait(1)
  const address  = await contract.getAddress()
  console.log('[DEPLOYER] Alucard deployed:', address)

  // Inject into running process
  process.env.CONTRACT_POLYGON = address

  // Persist
  const data = { CONTRACT_POLYGON: address, deployedAt: Date.now(), txHash: receipt.hash }
  try {
    if (!existsSync('/data')) mkdirSync('/data', { recursive: true })
    writeFileSync(CONTRACTS_PATH, JSON.stringify(data, null, 2))
  } catch {}

  console.log('[DEPLOYER] Alucard ready | CONTRACT_POLYGON:', address)
  return address
}

export function startDeployerAlucard() {
  // Check existing
  try {
    if (existsSync(CONTRACTS_PATH)) {
      const data = JSON.parse(readFileSync(CONTRACTS_PATH, 'utf8'))
      if (data.CONTRACT_POLYGON) {
        process.env.CONTRACT_POLYGON = data.CONTRACT_POLYGON
        console.log('[DEPLOYER] Existing Alucard contract loaded:', data.CONTRACT_POLYGON)
        return
      }
    }
  } catch {}

  // Pre-compile
  let compiled = null
  try {
    compiled = compile()
  } catch (e) {
    console.error('[DEPLOYER] Compilation failed:', e.message)
    return
  }

  let deploying = false
  const iv = setInterval(async () => {
    if (deploying) return
    try {
      const bal    = await provider.getBalance(EXECUTOR)
      const polBal = Number(ethers.formatEther(bal))
      if (polBal >= POL_THRESHOLD) {
        deploying = true
        clearInterval(iv)
        console.log(`[DEPLOYER] ${polBal.toFixed(4)} POL detected — deploying Alucard`)
        await deploy(compiled.abi, compiled.bytecode)
      }
    } catch { deploying = false }
  }, 500)

  console.log('[DEPLOYER] Watching for', POL_THRESHOLD, 'POL at:', EXECUTOR)
}

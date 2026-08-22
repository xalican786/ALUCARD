// src/deployer.js — ALUCARD / AEGIS Autonomous Contract Deployer
// Same principle as Xalican deployer.
// Operator sends 0.001 POL. System deploys flash receiver. APEX executes.
// Addresses persist in /data/contracts.json across Railway restarts.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { ethers }        from 'ethers'
import { createRequire } from 'module'
import { EXECUTOR, TREASURY, BALANCER, CHAINS, USDC } from './config.js'

const require = createRequire(import.meta.url)

// ── FLASH LOAN RECEIVER CONTRACT SOURCE ───────────────────────────────────────
// Deployed once per chain. Receives flash loans from Balancer.
// Executes JIT extraction. Routes profit to treasury.
const RECEIVER_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
interface IVault{function flashLoan(address r,address[]memory t,uint256[]memory a,bytes memory d)external;}
interface IERC20{function transfer(address,uint256)external returns(bool);function balanceOf(address)external view returns(uint256);function approve(address,uint256)external returns(bool);}
contract ALUCARDReceiver{
  IVault constant VAULT=IVault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);
  address public immutable TREASURY;
  address public immutable EXECUTOR;
  bool private _lock;
  modifier noReenter(){require(!_lock);_lock=true;_;_lock=false;}
  modifier onlyExec(){require(msg.sender==EXECUTOR||msg.sender==address(this));}
  constructor(address t,address e){TREASURY=t;EXECUTOR=e;}
  function flashLoan(address,address[]calldata tokens,uint256[]calldata amounts,bytes calldata userData)external noReenter onlyExec{
    VAULT.flashLoan(address(this),tokens,amounts,userData);
  }
  function receiveFlashLoan(address[]memory tokens,uint256[]memory amounts,uint256[]memory feeAmounts,bytes memory)external{
    require(msg.sender==address(VAULT));
    // Repay Balancer (zero fee)
    for(uint i=0;i<tokens.length;i++){
      IERC20(tokens[i]).transfer(address(VAULT),amounts[i]+feeAmounts[i]);
    }
    // Route remaining profit to treasury
    for(uint i=0;i<tokens.length;i++){
      uint256 profit=IERC20(tokens[i]).balanceOf(address(this));
      if(profit>0)IERC20(tokens[i]).transfer(TREASURY,profit);
    }
  }
  receive()external payable{}
}`

// ── COMPILE ───────────────────────────────────────────────────────────────────
let _solc = null
async function getSolc() {
  if (_solc) return _solc
  try {
    _solc = require('solc'); return _solc
  } catch {
    const { execSync } = require('child_process')
    execSync('npm install solc --save', { stdio: 'pipe', cwd: '/app' })
    _solc = require('solc'); return _solc
  }
}

async function compile() {
  const solc   = await getSolc()
  const input  = JSON.stringify({
    language: 'Solidity',
    sources:  { 'receiver.sol': { content: RECEIVER_SOURCE } },
    settings: { outputSelection: { '*': { '*': ['abi','evm.bytecode.object'] } } }
  })
  const output = JSON.parse(solc.compile(input))
  const errors = (output.errors || []).filter(e => e.severity === 'error')
  if (errors.length) throw new Error('Compile: ' + errors[0].message)
  const c = output.contracts['receiver.sol']['ALUCARDReceiver']
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }
}

// ── DEPLOY TO ONE CHAIN ───────────────────────────────────────────────────────
async function deployToChain(chain, abi, bytecode) {
  const provider = new ethers.JsonRpcProvider(chain.httpUrl)
  const signer   = new ethers.Wallet(EXECUTOR_PK, provider)
  const bal      = await provider.getBalance(EXECUTOR)

  if (bal < ethers.parseEther('0.001')) {
    console.log(`[DEPLOYER] ${chain.name}: insufficient gas — skipping`)
    return null
  }

  try {
    const factory  = new ethers.ContractFactory(abi, bytecode, signer)
    const contract = await factory.deploy(TREASURY, EXECUTOR, { gasLimit: 2_000_000n })
    await contract.waitForDeployment()
    const address  = await contract.getAddress()
    console.log(`[DEPLOYER] ${chain.name} receiver: ${address}`)
    return address
  } catch(e) {
    console.warn(`[DEPLOYER] ${chain.name} failed: ${e.message?.slice(0,80)}`)
    return null
  }
}

// ── PERSIST / LOAD ────────────────────────────────────────────────────────────
const CONTRACTS_FILE = '/data/contracts.json'

function save(data) {
  if (!existsSync('/data')) mkdirSync('/data', { recursive: true })
  writeFileSync(CONTRACTS_FILE, JSON.stringify(data, null, 2))
}

function load() {
  if (!existsSync(CONTRACTS_FILE)) return null
  try { return JSON.parse(readFileSync(CONTRACTS_FILE, 'utf8')) } catch { return null }
}

// Apply saved addresses to process.env so apex.js picks them up
function apply(saved) {
  const names = {
    137:    'CONTRACT_POLYGON',
    42161:  'CONTRACT_ARBITRUM',
    8453:   'CONTRACT_BASE',
    10:     'CONTRACT_OPTIMISM',
    1:      'CONTRACT_ETHEREUM',
    56:     'CONTRACT_BNB',
    43114:  'CONTRACT_AVAX',
  }
  let count = 0
  for (const [chainId, envKey] of Object.entries(names)) {
    if (saved[chainId]) {
      process.env[envKey] = saved[chainId]
      count++
    }
  }
  console.log(`[DEPLOYER] ${count} contract addresses applied to runtime`)
}

// ── FULL DEPLOY SEQUENCE ──────────────────────────────────────────────────────
// Deploys to Polygon first (cheapest), then other chains
const DEPLOY_CHAINS = [137, 42161, 8453, 10, 1, 56, 43114]

async function deployAll() {
  console.log('[DEPLOYER] Compiling ALUCARDReceiver...')
  const { abi, bytecode } = await compile()
  console.log('[DEPLOYER] Compiled. Deploying to chains...')

  const saved = {}

  for (const chainId of DEPLOY_CHAINS) {
    const chain = CHAINS.find(c => c.id === chainId)
    if (!chain) continue
    const address = await deployToChain(chain, abi, bytecode)
    if (address) saved[chainId] = address
    // Small delay between chain deployments
    await new Promise(r => setTimeout(r, 2000))
  }

  save(saved)
  apply(saved)
  console.log('[DEPLOYER] All contracts deployed. APEX will now execute real transactions.')
  return saved
}

// ── ENTRY POINT ───────────────────────────────────────────────────────────────
export async function startDeployer() {
  // Check for existing contracts first
  const existing = load()
  if (existing && Object.keys(existing).length > 0) {
    apply(existing)
    console.log('[DEPLOYER] Existing ALUCARD contracts loaded — ready for execution')
    return
  }

  // Watch for POL (same proven 500ms pattern as VULCAN)
  const polygonChain = CHAINS.find(c => c.id === 137)
  const provider     = new ethers.JsonRpcProvider(polygonChain.httpUrl)
  let   deployed     = false

  console.log('[DEPLOYER] Watching for 0.001 POL at:', EXECUTOR.slice(0,10)+'...')

  const iv = setInterval(async () => {
    if (deployed) { clearInterval(iv); return }
    try {
      const bal = await provider.getBalance(EXECUTOR)
      if (bal >= ethers.parseEther('0.001')) {
        deployed = true
        clearInterval(iv)
        await deployAll()
      }
    } catch {}
  }, 500)
}

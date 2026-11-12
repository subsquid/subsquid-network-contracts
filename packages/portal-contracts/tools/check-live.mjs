#!/usr/bin/env node
// Checks deployments/<chainId>.json against the chain. Read-only: it only makes eth_call,
// eth_getCode, eth_getStorageAt and eth_getTransactionReceipt requests.
//
//   node tools/check-live.mjs --chain 42161 [--rpc <url>] [--out <forge out dir>]
//
// For every contract in the manifest:
//   - there is code at the address;
//   - deployTx was mined in startBlock and created the contract or emitted a log from it.
// For the wiring: the factory points at this beacon, this registry and the fee router that
// is not retired, and the registry points back at the factory.
// For a chain with a released version (`version` is not null), also:
//   - each proxy and the beacon point at the implementation the manifest names;
//   - the code at each implementation, at the beacon and at each fee router equals the
//     build in --out, after zeroing the immutables on both sides.
//
// Exit code: 0 all checks passed, 1 a check failed, 2 the check could not run.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const DEFAULT_RPC = {
  42161: 'https://arb1.arbitrum.io/rpc',
  421614: 'https://sepolia-rollup.arbitrum.io/rpc',
}

// ERC-1967: bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (!['--chain', '--rpc', '--out'].includes(key) || value === undefined) {
      throw new Error('usage: check-live.mjs --chain <chainId> [--rpc <url>] [--out <forge out dir>]')
    }
    args[key.slice(2)] = value
  }
  if (!args.chain) throw new Error('--chain is required')
  return args
}

async function rpcBatch(url, calls) {
  const body = calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }))
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt))
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const replies = await res.json()
      if (!Array.isArray(replies) || replies.length !== calls.length) throw new Error('malformed batch reply')
      const byId = new Map(replies.map((r) => [r.id, r]))
      return calls.map(([method], id) => {
        const reply = byId.get(id)
        if (!reply || reply.error) throw new Error(`${method}: ${JSON.stringify(reply?.error ?? 'no reply')}`)
        return reply.result
      })
    } catch (e) {
      lastError = e
    }
  }
  throw new Error(`RPC request failed after 3 attempts: ${lastError.message}`)
}

const lower = (hex) => hex.toLowerCase()
const addressFromWord = (word) => `0x${word.slice(-40)}`.toLowerCase()

function loadArtifact(outDir, name) {
  const path = join(outDir, `${name}.sol`, `${name}.json`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`cannot read ${path}: ${e.message}. Run forge build first, or pass --out.`)
  }
}

// Compares runtime code with the build, ignoring the bytes the constructor fills in.
function sameCode(artifact, chainCode) {
  const built = artifact.deployedBytecode.object.replace(/^0x/, '').toLowerCase().split('')
  const live = chainCode.replace(/^0x/, '').toLowerCase().split('')
  if (built.length === 0 || built.length !== live.length) return false
  for (const refs of Object.values(artifact.deployedBytecode.immutableReferences ?? {})) {
    for (const { start, length } of refs) {
      for (let i = start * 2; i < (start + length) * 2; i++) {
        built[i] = '0'
        live[i] = '0'
      }
    }
  }
  return built.join('') === live.join('')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const manifest = JSON.parse(readFileSync(join(root, 'deployments', `${args.chain}.json`), 'utf8'))
  const url = args.rpc ?? DEFAULT_RPC[manifest.chainId]
  if (!url) throw new Error(`no default RPC for chain ${manifest.chainId}; pass --rpc`)
  const outDir = resolve(args.out ?? join(root, 'out'))
  const released = manifest.version !== null
  const contracts = Object.entries(manifest.contracts)

  const results = []
  const check = (ok, what, detail = '') => results.push({ ok, what, detail })

  const [chainIdHex] = await rpcBatch(url, [['eth_chainId', []]])
  if (Number(chainIdHex) !== manifest.chainId) {
    throw new Error(`the RPC serves chain ${Number(chainIdHex)}, the manifest is for ${manifest.chainId}`)
  }

  if (released) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    check(pkg.version === manifest.version, 'package.json version equals the manifest version', `${pkg.version} vs ${manifest.version}`)
  }

  // Code at every address, and the deployment receipts.
  const codes = await rpcBatch(url, contracts.map(([, c]) => ['eth_getCode', [c.address, 'latest']]))
  const receipts = await rpcBatch(url, contracts.map(([, c]) => ['eth_getTransactionReceipt', [c.deployTx]]))
  contracts.forEach(([name, c], i) => {
    check(codes[i] !== '0x', `${name}: code at ${c.address}`)
    const receipt = receipts[i]
    if (!receipt) return check(false, `${name}: deployTx found`, c.deployTx)
    check(Number(receipt.blockNumber) === c.startBlock, `${name}: deployTx mined in startBlock`, `${Number(receipt.blockNumber)} vs ${c.startBlock}`)
    const touched = [receipt.contractAddress, ...receipt.logs.map((l) => l.address)].filter(Boolean).map(lower)
    check(touched.includes(lower(c.address)), `${name}: deployTx created the contract or emitted from it`)
  })

  // Wiring between the contracts.
  const factory = manifest.contracts.PortalPoolFactory
  const registry = manifest.contracts.PortalRegistry
  const beacon = manifest.contracts.PortalPoolBeacon
  const activeRouters = contracts.filter(([, c]) => c.abi.startsWith('FeeRouterModule') && !c.retired)
  check(activeRouters.length === 1, 'exactly one fee router is not retired', activeRouters.map(([n]) => n).join(', '))
  const selector = (artifactName, signature) => {
    const id = loadArtifact(outDir, artifactName).methodIdentifiers[signature]
    if (!id) throw new Error(`${artifactName} has no ${signature}`)
    return `0x${id}`
  }
  const call = (to, data) => ['eth_call', [{ to, data }, 'latest']]
  const [fBeacon, fRegistry, fRouter, rFactory] = await rpcBatch(url, [
    call(factory.address, selector('PortalPoolFactory', 'beacon()')),
    call(factory.address, selector('PortalPoolFactory', 'portalRegistry()')),
    call(factory.address, selector('PortalPoolFactory', 'feeRouter()')),
    call(registry.address, selector('PortalRegistry', 'factory()')),
  ])
  check(addressFromWord(fBeacon) === lower(beacon.address), 'factory.beacon() is the beacon', addressFromWord(fBeacon))
  check(addressFromWord(fRegistry) === lower(registry.address), 'factory.portalRegistry() is the registry', addressFromWord(fRegistry))
  check(addressFromWord(rFactory) === lower(factory.address), 'registry.factory() is the factory', addressFromWord(rFactory))
  if (activeRouters.length === 1) {
    const [routerName, router] = activeRouters[0]
    check(addressFromWord(fRouter) === lower(router.address), `factory.feeRouter() is ${routerName}`, addressFromWord(fRouter))
  }

  // Implementation pointers and bytecode, only where a released version is deployed.
  if (released) {
    for (const [name, c] of contracts) {
      if (c.kind === 'immutable') {
        const [code] = await rpcBatch(url, [['eth_getCode', [c.address, 'latest']]])
        check(sameCode(loadArtifact(outDir, c.abi), code), `${name}: code equals the ${c.abi} build`)
        continue
      }
      const pointerCall =
        c.kind === 'beacon'
          ? call(c.address, selector('PortalPoolBeacon', 'implementation()'))
          : ['eth_getStorageAt', [c.address, IMPLEMENTATION_SLOT, 'latest']]
      const [pointer, implementationCode, ownCode] = await rpcBatch(url, [
        pointerCall,
        ['eth_getCode', [c.implementation, 'latest']],
        ['eth_getCode', [c.address, 'latest']],
      ])
      check(addressFromWord(pointer) === lower(c.implementation), `${name}: points at ${c.implementation}`, addressFromWord(pointer))
      const implementationAbi = c.kind === 'beacon' ? c.implementationAbi : c.abi
      check(sameCode(loadArtifact(outDir, implementationAbi), implementationCode), `${name}: implementation code equals the ${implementationAbi} build`)
      if (c.kind === 'beacon') check(sameCode(loadArtifact(outDir, c.abi), ownCode), `${name}: code equals the ${c.abi} build`)
    }
  }

  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.what}${!r.ok && r.detail ? `  (${r.detail})` : ''}`)
  const failed = results.filter((r) => !r.ok).length
  const scope = released ? `version ${manifest.version}` : 'no released version: implementations and bytecode not checked'
  console.log(`\n${manifest.network} (${scope}): ${results.length - failed} passed, ${failed} failed`)
  return failed === 0 ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`check-live could not run: ${e.message}`)
    process.exit(2)
  },
)

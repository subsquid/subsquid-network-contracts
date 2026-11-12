#!/usr/bin/env node
// Writes abi/<Contract>.json and layout/<Contract>.json from forge's build output.
//
//   forge build --skip test --skip script --extra-output storageLayout
//   node tools/export-artifacts.mjs
//
// or `pnpm artifacts`, which runs both. CI regenerates the files and fails when the
// committed ones differ, so an ABI or storage change always shows up in the diff of the
// pull request that makes it.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out')

// Every deployed contract. Interfaces are left out on purpose: they lack the events and
// getters the contracts inherit (roles, pausing, upgrades), so they are the wrong thing to
// index or call with.
const ABI_CONTRACTS = [
  'FeeRouterModule',
  'FeeRouterModuleV2',
  'LiquidPortalToken',
  'PortalPoolBeacon',
  'PortalPoolFactory',
  'PortalPoolImplementation',
  'PortalRegistry',
]

// The contracts that sit behind a proxy or the beacon, whose storage must stay compatible.
const LAYOUT_CONTRACTS = ['PortalPoolFactory', 'PortalPoolImplementation', 'PortalRegistry']

function artifact(name) {
  const path = join(outDir, `${name}.sol`, `${name}.json`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`cannot read ${path}: ${e.message}. Run forge build first.`)
  }
}

function paramType(p) {
  if (!p.type.startsWith('tuple')) return p.type
  return `(${(p.components ?? []).map(paramType).join(',')})${p.type.slice('tuple'.length)}`
}

// A fixed order, so the files do not depend on the order forge happens to emit.
function abiSortKey(entry) {
  return [entry.type, entry.name ?? '', (entry.inputs ?? []).map(paramType).join(',')].join('\u0000')
}

function exportAbi(name) {
  const abi = [...artifact(name).abi]
  abi.sort((a, b) => {
    const [x, y] = [abiSortKey(a), abiSortKey(b)]
    return x < y ? -1 : x > y ? 1 : 0
  })
  return abi
}

// solc names types with AST ids (`t_struct(Portal)4868_storage`) that change whenever a
// source file is edited. The layout files use the human-readable labels instead.
function exportLayout(name) {
  const layout = artifact(name).storageLayout
  if (!layout?.storage || !layout.types) {
    throw new Error(`${name} was built without its storage layout. Build with --extra-output storageLayout.`)
  }
  const { types } = layout
  const structs = {}

  const visit = (id) => {
    const t = types[id]
    if (!t) throw new Error(`${name}: unknown type ${id}`)
    if (t.members && !structs[t.label]) {
      structs[t.label] = {
        numberOfBytes: Number(t.numberOfBytes),
        members: t.members.map((m) => ({
          slot: Number(m.slot),
          offset: m.offset,
          label: m.label,
          type: types[m.type].label,
        })),
      }
      t.members.forEach((m) => visit(m.type))
    }
    if (t.key) visit(t.key)
    if (t.value) visit(t.value)
    if (t.base) visit(t.base)
  }

  const storage = layout.storage.map((v) => {
    visit(v.type)
    return {
      slot: Number(v.slot),
      offset: v.offset,
      label: v.label,
      type: types[v.type].label,
      numberOfBytes: Number(types[v.type].numberOfBytes),
      contract: v.contract.split(':').pop(),
    }
  })

  const sortedStructs = Object.fromEntries(Object.entries(structs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return { contract: name, storage, structs: sortedStructs }
}

function writeDir(dir, files) {
  const target = join(root, dir)
  mkdirSync(target, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(target, file), `${JSON.stringify(content, null, 2)}\n`)
  }
  // Drop files of contracts that are no longer exported.
  for (const file of readdirSync(target)) {
    if (file.endsWith('.json') && !(file in files)) rmSync(join(target, file))
  }
}

writeDir('abi', Object.fromEntries(ABI_CONTRACTS.map((c) => [`${c}.json`, exportAbi(c)])))
writeDir('layout', Object.fromEntries(LAYOUT_CONTRACTS.map((c) => [`${c}.json`, exportLayout(c)])))

console.log(`wrote ${ABI_CONTRACTS.length} ABIs to abi/ and ${LAYOUT_CONTRACTS.length} storage layouts to layout/`)

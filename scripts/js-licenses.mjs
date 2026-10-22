#!/usr/bin/env node
// JS licence report for the mobile-app plan (Phase 2.2).
//
// Runs `pnpm licenses list --prod --json` and checks every package against
// legal/js-license-allowlist.json. Exits 1 on any unknown or disallowed
// licence, printing `package@version: <licence>`.
//
//   node scripts/js-licenses.mjs               root package (desktop + web)
//   node scripts/js-licenses.mjs --dir mobile  mobile/ package (Phase 13)
//
// SPDX expressions: `A OR B` passes if any alternative is allowed,
// `A AND B` only if every part is. An exception matches on package name,
// optional exact version, and the licence string pnpm reports, so a change
// in a package's metadata makes the exception stop matching.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  if (argv.length === 0) return { dir: root, set: 'desktopWeb' }
  if (argv.length === 2 && argv[0] === '--dir' && argv[1] === 'mobile') {
    return { dir: join(root, 'mobile'), set: 'mobile' }
  }
  console.error('usage: node scripts/js-licenses.mjs [--dir mobile]')
  process.exit(2)
}

function listLicenses(cwd) {
  const out = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  try {
    return JSON.parse(out)
  } catch {
    throw new Error(`pnpm licenses list did not print JSON:\n${out.slice(0, 500)}`)
  }
}

// Splits on a top-level operator (outside parentheses).
function splitTopLevel(expr, op) {
  const parts = []
  let depth = 0
  let start = 0
  const token = ` ${op} `
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '(') depth++
    else if (expr[i] === ')') depth--
    else if (depth === 0 && expr.startsWith(token, i)) {
      parts.push(expr.slice(start, i))
      start = i + token.length
      i += token.length - 1
    }
  }
  parts.push(expr.slice(start))
  return parts
}

function stripOuterParens(expr) {
  let e = expr.trim()
  while (e.startsWith('(') && e.endsWith(')')) {
    let depth = 0
    let wraps = true
    for (let i = 0; i < e.length - 1; i++) {
      if (e[i] === '(') depth++
      else if (e[i] === ')') depth--
      if (depth === 0) {
        wraps = false
        break
      }
    }
    if (!wraps) break
    e = e.slice(1, -1).trim()
  }
  return e
}

function isAllowed(expr, allowed) {
  const e = stripOuterParens(expr)
  if (!e) return false
  const ors = splitTopLevel(e, 'OR')
  if (ors.length > 1) return ors.some((p) => isAllowed(p, allowed))
  const ands = splitTopLevel(e, 'AND')
  if (ands.length > 1) return ands.every((p) => isAllowed(p, allowed))
  return allowed.has(e)
}

function findException(exceptions, name, version, license) {
  return exceptions.find(
    (x) =>
      x.package === name &&
      (x.version === undefined || x.version === version) &&
      x.license === license,
  )
}

function main() {
  const { dir, set } = parseArgs(process.argv.slice(2))
  if (set === 'mobile' && !existsSync(join(dir, 'package.json'))) {
    console.log('mobile/ not present yet (Phase 13)')
    return 0
  }

  const allowlist = JSON.parse(readFileSync(join(root, 'legal/js-license-allowlist.json'), 'utf8'))
  const allowed = new Set(allowlist[set])
  const exceptions = allowlist.exceptions ?? []

  const report = listLicenses(dir)
  const lines = []
  const failures = []
  for (const [group, pkgs] of Object.entries(report)) {
    for (const pkg of pkgs) {
      const license = (pkg.license ?? group ?? '').trim() || 'Unknown'
      for (const version of pkg.versions) {
        const id = `${pkg.name}@${version}`
        const exception = findException(exceptions, pkg.name, version, license)
        if (exception) {
          lines.push(`${id}: ${license} (exception: ${exception.reason})`)
        } else if (isAllowed(license, allowed)) {
          lines.push(`${id}: ${license}`)
        } else {
          failures.push(`${id}: ${license}`)
        }
      }
    }
  }

  lines.sort()
  failures.sort()
  for (const line of lines) console.log(line)
  console.log(`\n${lines.length} packages allowed (${set} set).`)
  if (failures.length > 0) {
    console.error(`\n${failures.length} package(s) with an unknown or disallowed licence:`)
    for (const f of failures) console.error(f)
    return 1
  }
  return 0
}

process.exit(main())

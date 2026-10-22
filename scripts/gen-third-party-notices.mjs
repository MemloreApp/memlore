#!/usr/bin/env node
// Third-party notices for the desktop and web apps (mobile-app plan, Phase 2.3).
//
//   node scripts/gen-third-party-notices.mjs          write the two files below
//   node scripts/gen-third-party-notices.mjs --check  regenerate to a temp dir and
//                                                     exit 1 if either file differs
//
// Sources, merged into one deterministic list:
//   1. Rust crates: `cargo about generate --format json` run twice, once for the
//      `memlore` package and once for `memlore-wasm` (the web app ships it), with
//      src-tauri/about.toml. Never `--workspace`: mobile-only crates must not enter
//      the desktop notices.
//   2. JS packages: `pnpm licenses list --prod --json`, licence text read from each
//      package's LICENSE / COPYING / NOTICE files.
//   3. legal/non-package-notices.json: vendored native code, models, map data and
//      fonts that package metadata does not reveal (hand-maintained).
//
// Outputs (generated; listed in .prettierignore, never edit by hand):
//   src/generated/third-party-notices.json  array of components, each with its
//                                            licence texts
//   THIRD_PARTY_NOTICES.md                   the same, grouped by licence text
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const JSON_OUT = 'src/generated/third-party-notices.json'
const MD_OUT = 'THIRD_PARTY_NOTICES.md'
const CARGO_MANIFESTS = ['src-tauri/Cargo.toml', 'src-tauri/crates/memlore-wasm/Cargo.toml']
const ABOUT_CONFIG = 'src-tauri/about.toml'
const MAX_BUFFER = 256 * 1024 * 1024

// Packages whose metadata licence is wrong or missing, with the licence their
// LICENSE file states: the `actualLicense` of legal/js-license-allowlist.json
// exceptions (keyed by name@version, so the exception must pin a version). Like
// js-licenses.mjs, it applies only while pnpm still reports the exception's `license`.
function jsLicenseOverrides() {
  const { exceptions = [] } = JSON.parse(
    readFileSync(join(root, 'legal/js-license-allowlist.json'), 'utf8'),
  )
  const overrides = new Map()
  for (const x of exceptions) {
    if (!x.actualLicense) continue
    if (!x.version)
      throw new Error(`js-license-allowlist: ${x.package} actualLicense needs a version`)
    overrides.set(`${x.package}@${x.version}`, { reported: x.license, actual: x.actualLicense })
  }
  return overrides
}

// Top-level licence files (LICENSE, LICENSE.md, MIT-LICENCE.txt, LICENSE_MIT, NOTICE...).
// LICENSE.spdx is kept: the Tauri plugins ship only that file, and it carries
// their copyright line.
const LICENSE_FILE = /licen[cs]e|^copying|^notice/i
// Licence files of code vendored inside a package (e.g. victory-vendor/lib-vendor/d3-*/LICENSE).
const NESTED_LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt))?$/i
const NESTED_MAX_DEPTH = 4

// Plain code-unit comparison: deterministic regardless of locale.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// Licence texts are normalised so the output is identical on every machine.
const normalize = (text) =>
  text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+/, '')
    .replace(/\n*$/, '\n')

function run(cmd, args) {
  return execFileSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
}

function rustComponents() {
  const byId = new Map()
  for (const manifest of CARGO_MANIFESTS) {
    const out = run('cargo', [
      'about',
      'generate',
      '--locked',
      '-m',
      manifest,
      '-c',
      ABOUT_CONFIG,
      '--format',
      'json',
    ])
    const report = JSON.parse(out)
    for (const { package: pkg, license } of report.crates) {
      if (!byId.has(pkg.id)) {
        byId.set(pkg.id, {
          kind: 'rust',
          name: pkg.name,
          version: pkg.version,
          license: license.replace(/\s+/g, ' ').trim(),
          url: pkg.repository || pkg.homepage || `https://crates.io/crates/${pkg.name}`,
          texts: new Map(),
        })
      }
    }
    for (const lic of report.licenses) {
      const text = normalize(lic.text)
      for (const { crate } of lic.used_by) {
        const entry = byId.get(crate.id)
        if (!entry) throw new Error(`cargo-about licence used by unknown crate ${crate.id}`)
        entry.texts.set(`${lic.id}\0${text}`, { license: lic.id, text })
      }
    }
  }
  return [...byId.values()].map(({ texts, ...rest }) => ({ ...rest, texts: [...texts.values()] }))
}

function repositoryUrl(manifest) {
  const repo = manifest.repository
  const raw = typeof repo === 'string' ? repo : repo?.url
  if (!raw) return null
  return raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '')
}

// Licence files below the package root, skipping nested node_modules.
function nestedLicenseFiles(dir, rel = '', depth = 1, out = []) {
  if (depth > NESTED_MAX_DEPTH) return out
  for (const name of readdirSync(join(dir, rel))) {
    if (name === 'node_modules') continue
    const path = rel ? `${rel}/${name}` : name
    // lstat: symlinks are neither followed nor read.
    const st = lstatSync(join(dir, path))
    if (st.isDirectory()) nestedLicenseFiles(dir, path, depth + 1, out)
    else if (rel && st.isFile() && NESTED_LICENSE_FILE.test(name)) out.push(path)
  }
  return out
}

function jsComponents() {
  const report = JSON.parse(run('pnpm', ['licenses', 'list', '--prod', '--json']))
  const overrides = jsLicenseOverrides()
  const byId = new Map()
  for (const [group, pkgs] of Object.entries(report)) {
    for (const pkg of pkgs) {
      for (const dir of pkg.paths) {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        const id = `${pkg.name}@${manifest.version}`
        if (byId.has(id)) continue
        const reported = (pkg.license ?? group ?? '').trim() || 'Unknown'
        const override = overrides.get(id)
        const license = override?.reported === reported ? override.actual : reported
        const files = [
          ...readdirSync(dir).filter(
            (f) => LICENSE_FILE.test(f) && lstatSync(join(dir, f)).isFile(),
          ),
          ...nestedLicenseFiles(dir),
        ].sort(cmp)
        const texts = files.map((f) => ({
          license: /(^|\/)notice[^/]*$/i.test(f) ? 'NOTICE' : license,
          file: f,
          text: normalize(readFileSync(join(dir, f), 'utf8')),
        }))
        const entry = {
          kind: 'js',
          name: pkg.name,
          version: manifest.version,
          license,
          url:
            pkg.homepage || repositoryUrl(manifest) || `https://www.npmjs.com/package/${pkg.name}`,
          texts,
        }
        if (texts.length === 0) {
          entry.note =
            'The published package contains no licence file; see the project URL for the licence and copyright notice.'
        }
        byId.set(id, entry)
      }
    }
  }
  return [...byId.values()]
}

// `text` is one licence text under the item's licence; `texts` lists several
// ({ license, file?, text }), e.g. a licence plus the upstream notices file.
function otherTexts(item) {
  if (item.text && item.texts) {
    throw new Error(`legal/non-package-notices.json: "${item.name}" has both text and texts`)
  }
  if (item.text) return [{ license: item.license, text: normalize(item.text) }]
  return (item.texts ?? []).map((t) => {
    if (typeof t.license !== 'string' || typeof t.text !== 'string') {
      throw new Error(`legal/non-package-notices.json: "${item.name}" has a malformed texts entry`)
    }
    return { license: t.license, ...(t.file ? { file: t.file } : {}), text: normalize(t.text) }
  })
}

function otherComponents() {
  const items = JSON.parse(readFileSync(join(root, 'legal/non-package-notices.json'), 'utf8'))
  return items.map((item) => {
    for (const key of ['name', 'license', 'attribution', 'url', 'whereUsed']) {
      if (typeof item[key] !== 'string' || !item[key]) {
        throw new Error(`legal/non-package-notices.json: "${item.name}" lacks ${key}`)
      }
    }
    const entry = {
      kind: 'other',
      name: item.name,
      version: item.version ?? null,
      license: item.license,
      url: item.url,
      attribution: item.attribution,
      whereUsed: item.whereUsed,
      texts: otherTexts(item),
    }
    if (item.note) entry.note = item.note
    return entry
  })
}

const KIND_ORDER = { other: 0, rust: 1, js: 2 }

function sortComponents(list) {
  for (const c of list) {
    c.texts.sort(
      (a, b) => cmp(a.license, b.license) || cmp(a.file ?? '', b.file ?? '') || cmp(a.text, b.text),
    )
  }
  return list.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      cmp(a.name.toLowerCase(), b.name.toLowerCase()) ||
      cmp(a.name, b.name) ||
      cmp(a.version ?? '', b.version ?? ''),
  )
}

function fence(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  const ticks = '`'.repeat(longest + 1)
  return `${ticks}text\n${text}${ticks}\n`
}

const label = (c) => (c.version ? `${c.name} ${c.version}` : c.name)

// MPL-2.0 §3.2(a): say where the Source Code Form is available.
const user = (c) =>
  `${label(c)} (${c.kind === 'rust' ? 'Rust' : 'JS'}${/\bMPL-2\.0\b/.test(c.license) ? `, source: ${c.url}` : ''})`

function renderMarkdown(components) {
  const counts = { rust: 0, js: 0, other: 0 }
  for (const c of components) counts[c.kind]++
  const out = []
  out.push('# Third-party notices\n')
  out.push(
    'Memlore (desktop and web) includes the third-party software, data, fonts and models listed below, each under its own licence.\n',
  )
  out.push(
    'Generated by `pnpm notices:gen` (`scripts/gen-third-party-notices.mjs`) from cargo-about, `pnpm licenses list --prod` and `legal/non-package-notices.json`. Do not edit by hand.\n',
  )
  out.push(
    `Components: ${counts.other} non-package, ${counts.rust} Rust crates, ${counts.js} JavaScript packages.\n`,
  )

  out.push('## Components outside package metadata\n')
  out.push('Vendored native code, downloadable models and binaries, fonts, icons and map data.\n')
  for (const c of components.filter((x) => x.kind === 'other')) {
    out.push(`### ${label(c)}\n`)
    out.push(`- Licence: ${c.license}`)
    out.push(`- Attribution: ${c.attribution}`)
    out.push(`- Where used: ${c.whereUsed}`)
    out.push(`- URL: ${c.url}`)
    if (c.note) out.push(`- Note: ${c.note}`)
    out.push('')
    for (const t of c.texts) out.push(fence(t.text))
  }

  // Package licences, grouped by identical text so each text is printed once.
  const groups = new Map()
  const missing = []
  for (const c of components.filter((x) => x.kind !== 'other')) {
    if (c.texts.length === 0) missing.push(c)
    for (const t of c.texts) {
      const key = `${t.license}\0${t.text}`
      if (!groups.has(key)) groups.set(key, { license: t.license, text: t.text, users: [] })
      groups.get(key).users.push(user(c))
    }
  }
  const sorted = [...groups.values()]
    .map((g) => ({ ...g, users: [...new Set(g.users)].sort(cmp) }))
    .sort((a, b) => cmp(a.license, b.license) || cmp(a.users[0], b.users[0]) || cmp(a.text, b.text))

  out.push('## Package licences\n')
  out.push('Each licence text below is followed by the packages it applies to.\n')
  for (const g of sorted) {
    out.push(`### ${g.license}\n`)
    out.push(`Used by: ${g.users.join(', ')}\n`)
    out.push(fence(g.text))
  }

  if (missing.length > 0) {
    out.push('## Packages without a licence file\n')
    out.push(
      'These published packages ship no licence file. Their declared licence and project URL are listed; the licence and copyright notice are at that URL.\n',
    )
    for (const c of missing)
      out.push(`- ${label(c)} (${c.kind === 'rust' ? 'Rust' : 'JS'}): ${c.license}, ${c.url}`)
    out.push('')
  }

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n*$/, '\n')
}

function generate(outDir) {
  const components = sortComponents([...otherComponents(), ...rustComponents(), ...jsComponents()])
  const jsonPath = join(outDir, JSON_OUT)
  mkdirSync(dirname(jsonPath), { recursive: true })
  writeFileSync(jsonPath, JSON.stringify(components, null, 2) + '\n')
  writeFileSync(join(outDir, MD_OUT), renderMarkdown(components))
  return components.length
}

function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    const n = generate(root)
    console.log(`Wrote ${JSON_OUT} and ${MD_OUT} (${n} components).`)
    return 0
  }
  if (args.length === 1 && args[0] === '--check') {
    const tmp = mkdtempSync(join(tmpdir(), 'memlore-notices-'))
    try {
      generate(tmp)
      const stale = [JSON_OUT, MD_OUT].filter((rel) => {
        const current = join(root, rel)
        return !existsSync(current) || !readFileSync(current).equals(readFileSync(join(tmp, rel)))
      })
      if (stale.length > 0) {
        console.error(
          `Out of date: ${stale.join(', ')}. Run \`pnpm notices:gen\` and commit the result.`,
        )
        return 1
      }
      console.log('Third-party notices are up to date.')
      return 0
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
  console.error('usage: node scripts/gen-third-party-notices.mjs [--check]')
  return 2
}

process.exit(main())

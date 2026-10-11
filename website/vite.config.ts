import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { applyMarketingShell, twinKindFor } from './src/bootShell'
import { DOCS_PAGES, docsShellFile } from './src/docs/manifest'
import { escapeHtml, parseLegalMarkdown, renderLegalStaticHtml } from './src/legal/markdown'
import { buildLlmsTxt } from './src/llms'
import { LOCALES } from './src/i18n/locales'
import { en, type Messages } from './src/i18n/messages/en'
import { checkSync } from './src/i18n/sync'
import { renderLandingStaticHtml } from './src/prerender'
import { buildRobots, buildSitemap, renderSocialMeta } from './src/seo'

const ALIASED_TAURI = new Set([
  '@tauri-apps/api/core',
  '@tauri-apps/api/event',
  '@tauri-apps/api/window',
  '@tauri-apps/api/path',
  '@tauri-apps/plugin-opener',
  '@tauri-apps/plugin-dialog',
  '@tauri-apps/plugin-notification',
])

function tauriAliasGuard() {
  return {
    name: 'tauri-alias-guard',
    resolveId(id: string) {
      if (id.startsWith('@tauri-apps/') && !ALIASED_TAURI.has(id)) {
        throw new Error(
          `[website demo] Unaliased @tauri-apps import: "${id}". Add an explicit website demo mock.`,
        )
      }
    },
  }
}

// Google's OAuth verification reviewer fetches raw HTML and does not run JS, so a
// client-rendered page reads as blank — "insufficient content" on the policy, and
// no app description or privacy link on the homepage. Both block publishing. Bake
// the copy into the shell; React replaces it on mount. The boot splash hides that
// twin from sighted JS users until the first React commit (see bootShell.ts).
function readUtf8(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

/** Locale dictionaries keyed by code, filled by `writeLocaleShells` before any transform. */
const LOCALE_MESSAGES = new Map<string, Messages>([['', en]])

function staticArticleFor(path: string): string | undefined {
  const twin = twinKindFor(path)
  if (!twin) return
  const code: string = twin.locale.code
  const messages = LOCALE_MESSAGES.get(code)
  if (!messages) throw new Error(`prerender-static-shells: no messages for locale "${code}"`)
  if (twin.kind === 'landing') return renderLandingStaticHtml(messages, twin.locale)
  if (twin.kind === 'legal') {
    const dir = code === '' ? '' : `${code}/`
    return renderLegalStaticHtml(
      readUtf8(`./src/legal/${dir}${twin.name}.md`),
      messages.legal.lastUpdated,
    )
  }
  const markdownPath = fileURLToPath(new URL(`./src/docs/content/${twin.slug}.md`, import.meta.url))
  if (!existsSync(markdownPath)) return
  return renderLegalStaticHtml(readFileSync(markdownPath, 'utf8'))
}

function prerenderStaticShells() {
  return {
    name: 'prerender-static-shells',
    transformIndexHtml(html: string, ctx: { path: string }) {
      // Function replacement lives in applyMarketingShell so `$&` in the copy
      // stays literal. Splash is injected as a sibling; the twin stays in #root.
      return applyMarketingShell(html, ctx.path, staticArticleFor(ctx.path))
    },
  }
}

// Link-preview crawlers (Facebook, X, LinkedIn, Slack, iMessage) and Google read raw
// HTML, so the share-card tags are baked into every shell at build time.
function injectSocialMeta(): Plugin {
  return {
    name: 'inject-social-meta',
    transformIndexHtml: {
      order: 'pre',
      handler(html: string) {
        const tags = renderSocialMeta(html, (code) => LOCALE_MESSAGES.get(code)?.socialImageAlt)
        return tags ? html.replace('</head>', `    ${tags}\n  </head>`) : html
      },
    },
  }
}

function llmsTxtSource(): string {
  return buildLlmsTxt({
    about: parseLegalMarkdown(readUtf8('./src/legal/about.md')).meta.description,
    privacy: parseLegalMarkdown(readUtf8('./src/legal/privacy.md')).meta.description,
    terms: parseLegalMarkdown(readUtf8('./src/legal/terms.md')).meta.description,
  })
}

// Emitted from the bundle rather than dropped in `publicDir`, which points at the
// repo-root `public/` the Tauri app also bundles — crawler files have no business
// inside the desktop binary.
function emitSeoFiles(): Plugin {
  return {
    name: 'emit-seo-files',
    // In the hook body (pre), before Vite's htmlFallbackMiddleware. A returned
    // post-hook would already have rewritten a browser's Accept: text/html
    // request for /llms.txt into /index.html.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split('?')[0]
        if (pathname !== '/llms.txt' || (req.method !== 'GET' && req.method !== 'HEAD')) {
          next()
          return
        }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end(req.method === 'HEAD' ? undefined : llmsTxtSource())
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: buildRobots() })
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: buildSitemap() })
      this.emitFile({ type: 'asset', fileName: 'llms.txt', source: llmsTxtSource() })
    },
  }
}

// Fails the build (warns in dev) when a translation lags behind its English source.
function i18nSyncCheck(): Plugin {
  let isBuild = false
  return {
    name: 'i18n-sync-check',
    configResolved(config) {
      isBuild = config.command === 'build'
    },
    async buildStart() {
      const lines = await checkSync()
      if (lines.length === 0) return
      if (isBuild) this.error(lines.join('\n'))
      else this.warn(lines.join('\n'))
    },
  }
}

/** Locale directories that hold generated shells (ignored by git and prettier). */
const LOCALE_DIRS = ['es', 'fr', 'vi', 'zh-hans', 'zh-hant', 'ja', 'pt', 'de']
const SHELL_PAGES = ['index', 'about', 'privacy', 'terms'] as const

function localizeShell(
  html: string,
  code: string,
  htmlLang: string,
  page: string,
  title: string,
  description: string,
): string {
  const url = `https://memlore.app/${code}/${page === 'index' ? '' : page}`
  return html
    .replace(/<html lang="[^"]*"/, `<html lang="${htmlLang}"`)
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${escapeHtml(title)}</title>`)
    .replace(
      /(name="description"\s+content=")[^"]*"/,
      (_, open: string) => `${open}${escapeHtml(description)}"`,
    )
    .replace(/(<link rel="canonical" href=")[^"]*"/, (_, open: string) => `${open}${url}"`)
    .replace(/(property="og:url" content=")[^"]*"/, (_, open: string) => `${open}${url}"`)
    .replace(/((?:href|src)=")\.\//g, (_, open: string) => `${open}../`)
}

/** Writes `website/<code>/*.html` for every non-English locale; returns rollup inputs. */
async function writeLocaleShells(): Promise<Record<string, string>> {
  const inputs: Record<string, string> = {}
  const active = new Set<string>(LOCALES.map((l) => l.code))
  for (const dir of LOCALE_DIRS) {
    const path = fileURLToPath(new URL(`./${dir}/`, import.meta.url))
    if (!active.has(dir) && existsSync(path)) rmSync(path, { recursive: true })
  }
  for (const locale of LOCALES) {
    const code: string = locale.code
    if (code === '') continue
    const mod = (await import(
      new URL(`./src/i18n/messages/${code}.ts`, import.meta.url).href
    )) as Record<string, Messages>
    const messages = mod.default ?? mod[code]
    if (!messages) throw new Error(`i18n: src/i18n/messages/${code}.ts exports no messages`)
    LOCALE_MESSAGES.set(code, messages)
    mkdirSync(fileURLToPath(new URL(`./${code}/`, import.meta.url)), { recursive: true })
    for (const page of SHELL_PAGES) {
      const meta =
        page === 'index'
          ? { title: messages.meta.homeTitle, description: messages.meta.homeDescription }
          : parseLegalMarkdown(readUtf8(`./src/legal/${code}/${page}.md`)).meta
      const html = localizeShell(
        readUtf8(`./${page}.html`),
        code,
        locale.htmlLang,
        page,
        meta.title,
        meta.description,
      )
      const target = fileURLToPath(new URL(`./${code}/${page}.html`, import.meta.url))
      if (!existsSync(target) || readFileSync(target, 'utf8') !== html) {
        writeFileSync(target, html)
      }
      const key = code.replaceAll('-', '_')
      inputs[`${key}_${page === 'index' ? 'landing' : page}`] = target
    }
  }
  return inputs
}

const TAURI_MOCK_IDS = [...ALIASED_TAURI]

export default defineConfig(async () => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Isolate from the Tauri dev server (port 5173). Both configs alias/pre-bundle
  // differently; sharing node_modules/.vite causes 504 Outdated Optimize Dep on
  // whichever server did not trigger the last re-optimization.
  cacheDir: fileURLToPath(new URL('./.cache/vite', import.meta.url)),
  base: './',
  publicDir: fileURLToPath(new URL('../public', import.meta.url)),
  plugins: [
    tailwindcss(),
    react(),
    tauriAliasGuard(),
    prerenderStaticShells(),
    injectSocialMeta(),
    emitSeoFiles(),
    i18nSyncCheck(),
  ],
  optimizeDeps: {
    exclude: TAURI_MOCK_IDS,
    // These heavy deps are reached only through dynamic imports (the lazy stats
    // charts and map views). Left undiscovered at startup, Vite re-optimizes and
    // full-reloads the first time you navigate there, which aborts the in-flight
    // dynamic import with "Failed to fetch dynamically imported module". Pre-bundle
    // them up front so no mid-navigation re-optimization happens.
    include: ['recharts', 'leaflet', 'leaflet.heat', 'leaflet.markercluster'],
  },
  resolve: {
    // mockup/ is a separate Vite root — without dedupe, react-i18next can resolve a
    // second React copy and hooks throw "Cannot read properties of null
    // (reading 'useSyncExternalStore')".
    dedupe: ['react', 'react-dom', 'react-i18next'],
    alias: {
      react: fileURLToPath(new URL('../node_modules/react', import.meta.url)),
      'react-dom': fileURLToPath(new URL('../node_modules/react-dom', import.meta.url)),
      'react-i18next': fileURLToPath(new URL('../node_modules/react-i18next', import.meta.url)),
      '@tauri-apps/api/core': fileURLToPath(new URL('./demo/mocks/core.ts', import.meta.url)),
      '@tauri-apps/api/event': fileURLToPath(new URL('../mockup/mocks/event.ts', import.meta.url)),
      '@tauri-apps/api/window': fileURLToPath(
        new URL('../mockup/mocks/window.ts', import.meta.url),
      ),
      '@tauri-apps/api/path': fileURLToPath(new URL('../mockup/mocks/path.ts', import.meta.url)),
      '@tauri-apps/plugin-opener': fileURLToPath(
        new URL('./demo/mocks/plugin-opener.ts', import.meta.url),
      ),
      '@tauri-apps/plugin-dialog': fileURLToPath(
        new URL('../mockup/mocks/plugin-dialog.ts', import.meta.url),
      ),
      '@tauri-apps/plugin-notification': fileURLToPath(
        new URL('../mockup/mocks/plugin-notification.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5177,
    strictPort: true,
    host: true,
  },
  preview: {
    port: 4177,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        landing: fileURLToPath(new URL('./index.html', import.meta.url)),
        demo: fileURLToPath(new URL('./demo.html', import.meta.url)),
        privacy: fileURLToPath(new URL('./privacy.html', import.meta.url)),
        terms: fileURLToPath(new URL('./terms.html', import.meta.url)),
        changelog: fileURLToPath(new URL('./changelog.html', import.meta.url)),
        about: fileURLToPath(new URL('./about.html', import.meta.url)),
        ...Object.fromEntries(
          DOCS_PAGES.map((page) => [
            page.slug === 'overview' ? 'docsIndex' : `docs_${page.slug.replaceAll('-', '_')}`,
            fileURLToPath(new URL(`./${docsShellFile(page.slug)}`, import.meta.url)),
          ]),
        ),
        ...(await writeLocaleShells()),
      },
    },
  },
}))

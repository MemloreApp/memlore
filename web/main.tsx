import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import 'leaflet/dist/leaflet.css'
import '../src/styles/fonts'
import './styles.css'
import { i18n } from '../src/lib/i18n'
import { toast } from '../src/lib/toast'
import App from '../src/App'
import { queryClient, bridgeWindowEvents } from '../src/lib/queryClient'
import { useCapabilitiesStore } from '../src/stores/capabilitiesStore'
import { getCachedWriteFlag, onWriteFlagChange } from './src/backend/config'
import { CAPABILITIES_EVENT } from './src/backend/commands/sync'
import { listen } from './src/tauri/event'
import { STORAGE_BLOCKED_EVENT } from './src/backend/storage/idb'
import { checkBrowserCapabilities } from './src/backend/bootCheck'
import { UnsupportedBrowserScreen } from '../src/components/auth/UnsupportedBrowserScreen'

// Fail-closed: the editor is read-only until the Worker's write flag says otherwise.
const { setWrites } = useCapabilitiesStore.getState()
setWrites(getCachedWriteFlag())
onWriteFlagChange(setWrites)
// Desktop-derived capabilities (outbox v2, month index): false until a pull reports them.
const { setWebCapabilities } = useCapabilitiesStore.getState()
void listen<unknown>(CAPABILITIES_EVENT, (e) => setWebCapabilities(e.payload))
// A storage upgrade waits on another tab's connection: ask the user to close the other tabs.
void listen(STORAGE_BLOCKED_EVENT, () =>
  toast(i18n.t('storage.blocked', { ns: 'errors' }), { duration: 6000 }),
)

function QueryBridge() {
  useEffect(() => bridgeWindowEvents(queryClient), [])
  return null
}

// Mirror the scroll-reset guard from src/main.tsx
window.addEventListener(
  'scroll',
  () => {
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0)
  },
  { passive: true },
)

// Reading `indexedDB` throws SecurityError when storage is blocked in some browsers: missing.
function readGlobal<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

// Fail-closed capability probe before App mounts. `.then()`, not top-level await: the browsers
// this screen is for may not parse top-level await.
void checkBrowserCapabilities({
  indexedDB: readGlobal(() => globalThis.indexedDB),
  WebAssembly: readGlobal(() => globalThis.WebAssembly),
  crypto: readGlobal(() => globalThis.crypto),
  navigator: readGlobal(() => globalThis.navigator),
  BroadcastChannel: readGlobal(() => globalThis.BroadcastChannel),
}).then(({ supported, missing }) => {
  const root = createRoot(document.getElementById('root')!)
  if (!supported) {
    root.render(
      <StrictMode>
        <UnsupportedBrowserScreen missing={missing} />
      </StrictMode>,
    )
    return
  }
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <QueryBridge />
        <App />
      </QueryClientProvider>
    </StrictMode>,
  )
})

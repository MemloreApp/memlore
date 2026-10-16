import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'
import type { WebDeviceRemovedStatus } from '../../lib/tauri'
import { AuthPageCard } from '../common/AuthPageCard'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { Modal } from '../common/Modal'
import { OnboardNewDeviceScreen } from './OnboardNewDeviceScreen'

interface Props {
  reason: WebDeviceRemovedStatus['reason']
  unsentDrafts: number
  connectDrive: () => Promise<string>
  cancelConnect: () => Promise<void>
  completeReonboard: () => Promise<void>
  /** Resolves to whether the Drive cookie was cleared; reloads the page only when it was. */
  forget: () => Promise<boolean>
}

const REASON_KEYS = {
  'slot-missing': 'web_removed.reason_slot_missing',
  'fingerprint-changed': 'web_removed.reason_fingerprint_changed',
  'generation-changed': 'web_removed.reason_generation_changed',
} as const

// Mirror the markers WelcomeScreen matches on.
const OAUTH_CANCELLED_MARKER = 'OAUTH_CANCELLED'
const PENDING_DRIVE_SESSION_EXPIRED_MARKER = 'PENDING_DRIVE_SESSION_EXPIRED'

const rawMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Web only: shown instead of LockScreen when a desktop removed this browser
 * from the vault (or rotated its keys). The backend refuses unlock while the
 * flag is set, so the two ways forward are re-entering the 24-word phrase
 * (unsent drafts are kept) or forgetting this browser.
 *
 * Prop-driven: App owns the single `useWebDeviceRemoved()` instance, so the
 * re-probe in `completeReonboard` flips the route there.
 */
export function RemovedBrowserScreen({
  reason,
  unsentDrafts,
  connectDrive,
  cancelConnect,
  completeReonboard,
  forget,
}: Props) {
  const { t } = useTranslation('auth')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState('')
  const [forgetOpen, setForgetOpen] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  const [forgetError, setForgetError] = useState('')
  // The wipe succeeded but the Drive sign-out did not land: warn, then reload on OK.
  const [cookieWarning, setCookieWarning] = useState(false)

  // `connectDrive()` must be the first await: on web it opens the OAuth popup,
  // which the browser only allows inside the click gesture.
  const handleReonboard = async () => {
    setConnectError('')
    setConnecting(true)
    try {
      setSessionId(await connectDrive())
    } catch (err) {
      const msg = rawMessage(err)
      // Closed popup or Cancel: silently back to the intro.
      if (msg.includes(OAUTH_CANCELLED_MARKER)) return
      console.warn('Drive connect for re-onboarding failed:', err)
      setConnectError(
        msg.includes(PENDING_DRIVE_SESSION_EXPIRED_MARKER)
          ? t('welcome_first_run.existing_cloud_error_pending_session_expired')
          : t('web_removed.connect_error'),
      )
    } finally {
      setConnecting(false)
    }
  }

  const handleForget = async () => {
    setForgetError('')
    setForgetting(true)
    try {
      // When the cookie was cleared the page reloads; nothing to clean up. Otherwise
      // `forgetting` stays set so the modal cannot be dismissed before the OK.
      if (!(await forget())) setCookieWarning(true)
    } catch (err) {
      console.warn('Forget this browser failed:', err)
      setForgetError(t('web_removed.forget_error'))
      setForgetting(false)
    }
  }

  const closeForget = () => {
    if (forgetting) return
    setForgetOpen(false)
    setForgetError('')
  }

  if (sessionId) {
    return (
      <AuthPageCard className="max-w-130 p-8">
        <OnboardNewDeviceScreen
          sessionId={sessionId}
          providerKind="gdrive"
          onCompleted={() => {
            // Unmounts once the re-probe clears the flag; if it is still set,
            // fall back to the intro instead of a stuck finish step.
            void completeReonboard().then(() => setSessionId(null))
          }}
          // No Drive disconnect here: `gdrive_disconnect` is unsupported on web, and the
          // next connect (or the session TTL) drops the pending session.
          onCancel={() => setSessionId(null)}
        />
      </AuthPageCard>
    )
  }

  // `reason` is briefly null right after the live event, before the re-probe.
  const reasonKey = reason ? REASON_KEYS[reason] : 'web_removed.reason_generic'

  return (
    <>
      <AuthPageCard className="max-w-120 p-8">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="bg-danger/10 flex items-center justify-center rounded-full p-3">
            <ShieldAlert className="text-danger size-6" strokeWidth={1.75} />
          </div>
          <h1 className="font-title text-fg text-2xl font-extrabold">{t('web_removed.title')}</h1>
          <p className="text-fg-muted text-sm leading-relaxed">
            {t(reasonKey)} {t('web_removed.body')}
          </p>
        </div>

        <div className="flex flex-col gap-4">
          {unsentDrafts > 0 && (
            <Callout tone="info">{t('web_removed.drafts', { count: unsentDrafts })}</Callout>
          )}

          {connectError && <Callout tone="danger">{connectError}</Callout>}

          <div className="flex flex-col items-center gap-2">
            <Button
              className="w-fit px-6"
              variant="primary"
              loading={connecting}
              disabled={connecting}
              onClick={() => void handleReonboard()}
            >
              {connecting ? t('web_removed.connecting') : t('web_removed.reonboard')}
            </Button>
            {connecting && (
              <Button className="w-fit px-6" variant="ghost" onClick={() => void cancelConnect()}>
                {t('web_removed.connect_cancel')}
              </Button>
            )}
            <Button
              className="w-fit px-6"
              variant="outline"
              disabled={connecting}
              onClick={() => setForgetOpen(true)}
            >
              {t('web_removed.forget')}
            </Button>
          </div>
        </div>
      </AuthPageCard>

      {forgetOpen && (
        <Modal onClose={closeForget} disableEsc={forgetting} disableBackdrop={forgetting}>
          <Modal.Header>{t('web_removed.forget_title')}</Modal.Header>
          <Modal.Body>
            {cookieWarning ? (
              <Callout tone="warning">{t('web_removed.forget_cookie_warning')}</Callout>
            ) : (
              <p className="text-fg-secondary text-sm leading-relaxed">
                {unsentDrafts > 0
                  ? t('web_removed.forget_body', { count: unsentDrafts })
                  : t('web_removed.forget_body_none')}
              </p>
            )}
            {forgetError && (
              <Callout tone="danger" className="mt-3">
                {forgetError}
              </Callout>
            )}
          </Modal.Body>
          <Modal.Footer>
            {cookieWarning ? (
              <Button variant="primary" size="sm" onClick={() => window.location.reload()}>
                {t('web_removed.forget_cookie_ok')}
              </Button>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={closeForget} disabled={forgetting}>
                  {t('web_removed.forget_cancel')}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  loading={forgetting}
                  disabled={forgetting}
                  onClick={() => void handleForget()}
                >
                  {t('web_removed.forget_confirm')}
                </Button>
              </>
            )}
          </Modal.Footer>
        </Modal>
      )}
    </>
  )
}

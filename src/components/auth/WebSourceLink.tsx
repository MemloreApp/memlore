import { useTranslation } from 'react-i18next'
import { isWeb } from '../../lib/platform'

const REPO_URL = 'https://github.com/MemloreApp/memlore'

/**
 * AGPL-3.0 §13: a user interacting with the web app over a network must be
 * offered its source, before unlock too. Web build only.
 */
export function WebSourceLink() {
  const { t } = useTranslation('auth')
  if (!isWeb) return null
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="text-fg-muted hover:text-fg mt-4 block w-full text-center text-xs underline-offset-2 hover:underline"
    >
      {t('web.sourceCode')}
    </a>
  )
}

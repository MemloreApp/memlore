import { openUrl } from '@tauri-apps/plugin-opener'
import { ExternalLink, Scale } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** Catalog licence URLs are opened only when they are `https:`. */
function httpsHref(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

/** "License: <spdx>" for a downloadable model, linked to its licence page. */
export function ModelLicenseLink({ spdx, url }: { spdx: string; url: string }) {
  const { t } = useTranslation('ai')
  if (!spdx) return null
  const label = t('model_license.value', { spdx })
  const href = httpsHref(url)

  return (
    <span className="inline-flex items-center gap-1 leading-none">
      <Scale className="text-fg-muted size-3.5 shrink-0" aria-hidden="true" />
      {href == null ? (
        <span>{label}</span>
      ) : (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault()
            void openUrl(href).catch(() => {})
          }}
          className="text-accent inline-flex items-center gap-1 underline-offset-2 hover:underline"
        >
          {label}
          <ExternalLink className="size-3 opacity-60" strokeWidth={1.75} aria-hidden="true" />
        </a>
      )}
    </span>
  )
}

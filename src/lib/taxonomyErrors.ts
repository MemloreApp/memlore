/**
 * Refusal codes the web journal / tag commands throw as the whole error message
 * (`web/src/backend/commands/taxonomy.ts`). The UI shows friendly copy for them; any other error
 * keeps its own text.
 */
const CODES = ['name_taken', 'retry_after_sync', 'journal_not_empty', 'last_journal'] as const

export type TaxonomyErrorCode = (typeof CODES)[number]

/** The refusal code `err` carries, or null when it is another error. */
export function taxonomyErrorCode(err: unknown): TaxonomyErrorCode | null {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : null
  return CODES.find((code) => code === message) ?? null
}

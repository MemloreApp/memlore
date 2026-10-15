/**
 * Statistics from the month index (Phase 19.1): every `stats_*` query the Statistics view and its
 * hooks call, computed over index rows with the bucketing of the desktop SQL
 * (`src-tauri/src/db/queries.rs`, `query_*` / `select_location_density`). Same return shapes.
 *
 * DESKTOP SEMANTICS KEPT
 * - Dates are bucketed in LOCAL time (`'localtime'`): day `YYYY-MM-DD`, week `YYYY-WW` with the
 *   C `strftime('%W')` week (Monday first; the days before the year's first Monday are week `00`,
 *   not ISO weeks), month `YYYY-MM`. Hours are local `0..=23`, always all 24, zero-filled.
 * - Cutoffs are rolling, not calendar aligned: `now - secs * range` for the period commands (day
 *   86 400 s, week 7 days, anything else = month of 30 days), `now - rangeDays * 86 400` for the
 *   others. Ranges are clamped to 3 650; there is no upper bound, so future-dated entries count.
 *   `stats_emotion_trend` accepts `day | week` (anything else = day).
 * - Emotions are the three states `bad | neutral | good`; any other value counts as no emotion.
 *   The histogram is ordered by count (most first), ties by emotion name.
 * - The streak calendar rejects a year outside `1000..=9999` and lists every day of it.
 * - Location density rounds to 3 decimals (half away from zero, as SQLite `ROUND`) and adds a
 *   media EXIF point only when the entry has no location or it differs by more than 0.001.
 *
 * WHERE THE NUMBERS COME FROM: the entry facts of `indexFacts.ts` (one overlay rule for every
 * index-backed view). Rows that pass the reader's fail-closed filter; an entry the vault holds and
 * shows counts from its loaded copy (it carries web edits; media EXIF from the row's media that
 * copy still carries live); an entry the vault refuses (locked, invisible, deleted, pending web
 * trash, excluded journal) is never counted; visible loaded entries with no row read (web creates,
 * entries edited after the index was written) count from their loaded copy.
 *
 * KNOWN DIFFERENCES FROM DESKTOP
 * - Locked entries are never in the index, so they are not counted (desktop counts them).
 * - Words: desktop approximates with `spaces + 1` over `content_text`; the index has no text, only
 *   `word_count` (whitespace-separated words), and a loaded copy is counted the same way.
 * - Tags: only live tags of the taxonomy are listed (desktop joins its `tags` table).
 * - Media EXIF: the index lists uploaded media only.
 * - A degraded month (unreadable index file) contributes only its loaded entries, so totals can
 *   undercount.
 * - Months are picked by the index row's synced `entry_date`; an entry whose date a web edit moved
 *   into the window from an unread month is missed until the desktop re-indexes it, unless the
 *   vault holds it.
 * Without an index source every command answers from the loaded entries only.
 *
 * The view's year emotion heatmap is NOT here: it calls `get_emotion_by_date` (`entries.ts`), which
 * reads the same entry facts.
 */

import type {
  EmotionTrendBucket,
  EntriesOverTimePoint,
  LocationPoint,
  MoodHistogramRow,
  MoodTrendPoint,
  StreakCalendarDay,
  TagFrequencyRow,
  WritingHourRow,
  WritingVolumePoint,
} from '../../../../src/lib/tauri'
import type { Handler } from '../router'
import { nowSecs } from '../clock'
import { utcMonthsCovering } from '../sync/monthIndex'
import { entryFacts, utcMonthOf, type EntryFact } from './indexFacts'

const DAY_SECS = 86_400
/** Desktop clamp on every range argument. */
const MAX_RANGE = 3650
const MAX_U32 = 0xffff_ffff

type Emotion = 'bad' | 'neutral' | 'good'
type Bucket = 'day' | 'week' | 'month'

const pad = (n: number): string => String(n).padStart(2, '0')

/** A `u32` argument (Tauri rejects anything else), clamped to the desktop maximum. */
function rangeArg(command: string, name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw new Error(`invalid args \`${name}\` for command \`${command}\``)
  }
  return Math.min(value, MAX_RANGE)
}

/** Desktop `period_params`: day, week, anything else a 30-day month. */
function bucketOf(period: unknown): { bucket: Bucket; secs: number } {
  if (period === 'day') return { bucket: 'day', secs: DAY_SECS }
  if (period === 'week') return { bucket: 'week', secs: 7 * DAY_SECS }
  return { bucket: 'month', secs: 30 * DAY_SECS }
}

/** Local-time `strftime` key of a Unix-seconds instant. */
function periodKey(secs: number, bucket: Bucket): string {
  const d = new Date(secs * 1000)
  const year = String(d.getFullYear()).padStart(4, '0')
  if (bucket === 'month') return `${year}-${pad(d.getMonth() + 1)}`
  if (bucket === 'day') return `${year}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  // `%W`: (yday + 7 - weekday) / 7 with Monday = 0. Midnight-to-midnight rounding absorbs DST.
  const yday = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(d.getFullYear(), 0, 1).getTime()) /
      (DAY_SECS * 1000),
  )
  const mondayFirst = (d.getDay() + 6) % 7
  return `${year}-${pad(Math.floor((yday + 7 - mondayFirst) / 7))}`
}

/** Facts dated at or after `cutoff` (the months before it are not read; all when not datable). */
async function since(cutoff: number): Promise<EntryFact[]> {
  const first = utcMonthOf(cutoff)
  const { facts } = await entryFacts(first === null ? null : (m) => m >= first)
  return facts.filter((f) => f.entry_date >= cutoff)
}

/** Facts grouped by key, keys ascending. */
function grouped(
  facts: readonly EntryFact[],
  key: (f: EntryFact) => string,
): Array<[string, EntryFact[]]> {
  const groups = new Map<string, EntryFact[]>()
  for (const f of facts) {
    const k = key(f)
    const group = groups.get(k)
    if (group === undefined) groups.set(k, [f])
    else group.push(f)
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

const entriesOverTime: Handler = async ({ period, range }) => {
  const n = rangeArg('stats_entries_over_time', 'range', range)
  const { bucket, secs } = bucketOf(period)
  const facts = await since(nowSecs() - secs * n)
  return grouped(facts, (f) => periodKey(f.entry_date, bucket)).map(
    ([key, group]): EntriesOverTimePoint => ({ period_start: key, count: group.length }),
  )
}

const writingVolume: Handler = async ({ period, range }) => {
  const n = rangeArg('stats_writing_volume', 'range', range)
  const { bucket, secs } = bucketOf(period)
  const facts = await since(nowSecs() - secs * n)
  return grouped(facts, (f) => periodKey(f.entry_date, bucket)).map(
    ([key, group]): WritingVolumePoint => ({
      period_start: key,
      total_words: group.reduce((sum, f) => sum + f.word_count, 0),
      entry_count: group.length,
    }),
  )
}

/** Facts with an emotion in the last `rangeDays`. */
async function withEmotion(command: string, rangeDays: unknown): Promise<EntryFact[]> {
  const n = rangeArg(command, 'rangeDays', rangeDays)
  return (await since(nowSecs() - n * DAY_SECS)).filter((f) => f.emotion !== null)
}

const moodHistogram: Handler = async ({ rangeDays }) => {
  const facts = await withEmotion('stats_mood_histogram', rangeDays)
  return grouped(facts, (f) => f.emotion as Emotion)
    .map(([emotion, group]): MoodHistogramRow => ({ emotion, count: group.length }))
    .sort((a, b) => b.count - a.count || (a.emotion < b.emotion ? -1 : 1))
}

const moodTrend: Handler = async ({ rangeDays }) => {
  const facts = await withEmotion('stats_mood_trend', rangeDays)
  return grouped(facts, (f) => periodKey(f.entry_date, 'day')).map(
    ([day, group]): MoodTrendPoint => ({ day, sample_count: group.length }),
  )
}

const emotionTrend: Handler = async ({ period, rangeDays }) => {
  const bucket: Bucket = period === 'week' ? 'week' : 'day'
  const facts = await withEmotion('stats_emotion_trend', rangeDays)
  return grouped(facts, (f) => periodKey(f.entry_date, bucket)).map(
    ([key, group]): EmotionTrendBucket => {
      const count = (e: Emotion) => group.filter((f) => f.emotion === e).length
      return {
        period_start: key,
        bad_count: count('bad'),
        neutral_count: count('neutral'),
        good_count: count('good'),
        total_count: group.length,
      }
    },
  )
}

const writingHours: Handler = async ({ rangeDays }) => {
  const n = rangeArg('stats_writing_hours', 'rangeDays', rangeDays)
  const counts = new Array<number>(24).fill(0)
  for (const f of await since(nowSecs() - n * DAY_SECS)) {
    counts[new Date(f.entry_date * 1000).getHours()] += 1
  }
  return counts.map((count, hour): WritingHourRow => ({ hour, count }))
}

const streakCalendar: Handler = async ({ year }) => {
  if (typeof year !== 'number' || !Number.isInteger(year)) {
    throw new Error('invalid args `year` for command `stats_streak_calendar`')
  }
  if (year < 1000 || year > 9999) throw new Error(`year out of range: ${year}`)
  const from = new Date(year, 0, 1).getTime() / 1000
  const to = new Date(year + 1, 0, 1).getTime() / 1000
  const months = new Set(utcMonthsCovering(from, to))
  const { facts } = await entryFacts((m) => months.has(m))
  const counts = new Map<string, number>()
  for (const f of facts) {
    if (f.entry_date < from || f.entry_date >= to) continue
    const key = periodKey(f.entry_date, 'day')
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const days: StreakCalendarDay[] = []
  for (let month = 0; month < 12; month += 1) {
    const length = new Date(year, month + 1, 0).getDate()
    for (let day = 1; day <= length; day += 1) {
      const date = `${year}-${pad(month + 1)}-${pad(day)}`
      days.push({ date, entry_count: counts.get(date) ?? 0 })
    }
  }
  return days
}

const tagFrequency: Handler = async () => {
  const { facts, taxonomy } = await entryFacts(null)
  const names = new Map(taxonomy.tags.map((t) => [t.id, t.name]))
  const counts = new Map<string, number>()
  for (const f of facts) {
    for (const id of new Set(f.tag_ids)) {
      if (names.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([id, count]): TagFrequencyRow => ({ tag_id: id, tag_name: names.get(id) ?? '', count }))
    .sort((a, b) => b.count - a.count || (a.tag_id < b.tag_id ? -1 : 1))
}

/** SQLite `ROUND(v * 1000) / 1000`: half away from zero. */
const round3 = (v: number): number => (Math.sign(v) * Math.round(Math.abs(v) * 1000)) / 1000

const locationDensity: Handler = async () => {
  const { facts } = await entryFacts(null)
  const points = new Map<string, LocationPoint>()
  const add = (lat: number, lng: number) => {
    const p = { lat: round3(lat), lng: round3(lng) }
    const key = `${p.lat},${p.lng}`
    const held = points.get(key)
    if (held === undefined) points.set(key, { ...p, count: 1 })
    else held.count += 1
  }
  for (const f of facts) {
    const { latitude: lat, longitude: lng } = f
    if (lat !== null && lng !== null) add(lat, lng)
    for (const [mLat, mLng] of f.exif) {
      const away =
        lat === null || lng === null || Math.abs(lat - mLat) > 0.001 || Math.abs(lng - mLng) > 0.001
      if (away) add(mLat, mLng)
    }
  }
  return [...points.values()].sort((a, b) => b.count - a.count || a.lat - b.lat || a.lng - b.lng)
}

export const indexStatsHandlers: Record<string, Handler> = {
  stats_emotion_trend: emotionTrend,
  stats_entries_over_time: entriesOverTime,
  stats_location_density: locationDensity,
  stats_mood_histogram: moodHistogram,
  stats_mood_trend: moodTrend,
  stats_streak_calendar: streakCalendar,
  stats_tag_frequency: tagFrequency,
  stats_writing_hours: writingHours,
  stats_writing_volume: writingVolume,
}

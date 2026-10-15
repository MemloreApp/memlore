import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { listLocationAliases, createLocationAlias } from '../../lib/tauri'
import { geocodeResolve } from '../../lib/tauri'
import { useGeocodeSearch } from '../../hooks/useGeocodeSearch'
import { scrollIntoViewNearest } from '../../lib/scrollIntoViewNearest'
import type { LocationAlias } from '../../types/location'
import type { GeocodeSuggestion } from '../../types/geocoding'
import { InlineOrb } from './ThinkingOrb'
import {
  resolveLocationPreviewCoords,
  suggestionFromStoredLocation,
} from '../../lib/locationCoords'
import { LocationMapPreview, LocationMapPreviewPlaceholder } from '../map/LocationMapPreview'
import { TextInput } from './TextInput'
import { Button } from './Button'
import { Callout } from './Callout'
import { cn } from '../../lib/cn'
import { isWeb } from '../../lib/platform'
import { useTheme } from '../../hooks/useTheme'
import { useMapSourceSettings } from '../../hooks/useMapSourceSettings'
import { useMapSourceUsable } from '../../hooks/useMapSourceUsable'
import { createMapBasemapLayer } from '../map/LeafletMap'

interface LocationPickerProps {
  onSelect: (
    lat: number | null,
    lng: number | null,
    label: string | null,
    address: string | null,
  ) => void
  onClose: () => void
  currentLabel?: string | null
  currentAddress?: string | null
  currentLatitude?: number | null
  currentLongitude?: number | null
  toggleRef?: React.RefObject<HTMLElement | null>
}

/**
 * Entry location picker. Desktop: geocoded address search, saved aliases and a map preview. Web
 * (Q3, no geocoding and no GPS there): `WebLocationPicker`.
 */
export function LocationPicker(props: LocationPickerProps) {
  return isWeb ? <WebLocationPicker {...props} /> : <DesktopLocationPicker {...props} />
}

function DesktopLocationPicker({
  onSelect,
  onClose,
  currentLabel = null,
  currentAddress = null,
  currentLatitude = null,
  currentLongitude = null,
  toggleRef,
}: LocationPickerProps) {
  const { t } = useTranslation('editor')

  const [label, setLabel] = useState<string>(currentLabel ?? '')
  const [query, setQuery] = useState<string>(currentAddress ?? '')
  const [selectedSuggestion, setSelectedSuggestion] = useState<GeocodeSuggestion | null>(() =>
    suggestionFromStoredLocation(
      currentLabel ?? '',
      currentAddress ?? '',
      currentLatitude,
      currentLongitude,
    ),
  )
  const [highlightIndex, setHighlightIndex] = useState<number>(-1)
  // Start closed when pre-filled so suggestions don't appear on open
  const [dropdownClosedManually, setDropdownClosedManually] = useState(!!currentAddress)
  // Only enable geocode search once the user has actually typed something
  const [geocodeEnabled, setGeocodeEnabled] = useState(!currentAddress)
  const [savedAliases, setSavedAliases] = useState<LocationAlias[]>([])
  const [savedListOpen, setSavedListOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const trimmedQuery = query.trim()

  const {
    suggestions: apiSuggestions,
    isLoading,
    error,
    sessionToken,
  } = useGeocodeSearch(query, {
    enabled: geocodeEnabled,
  })

  // Filter saved aliases client-side when the user is actively typing.
  // Matches against both alias label and alias address (case-insensitive substring).
  const matchedAliasSuggestions: GeocodeSuggestion[] =
    trimmedQuery.length >= 2
      ? savedAliases
          .filter((a) => {
            const q = trimmedQuery.toLowerCase()
            return a.label.toLowerCase().includes(q) || a.address.toLowerCase().includes(q)
          })
          .map((a) => ({
            place_id: `alias:${a.id}`,
            label: a.label,
            address: a.address,
            latitude: a.latitude,
            longitude: a.longitude,
          }))
      : []

  // Alias matches appear before API suggestions in the combined list
  const suggestions = [...matchedAliasSuggestions, ...apiSuggestions]
  const showDropdown = !dropdownClosedManually && suggestions.length > 0

  // Load saved location aliases on mount
  useEffect(() => {
    listLocationAliases()
      .then(setSavedAliases)
      .catch(() => {
        // Silently ignore — aliases are a convenience feature
      })
  }, [])

  // Close on outside click, excluding the toggle button
  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      const target = e.target as Node
      if (toggleRef?.current?.contains(target)) return
      if (containerRef.current && !containerRef.current.contains(target)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [onClose, toggleRef])

  useEffect(() => {
    if (highlightIndex < 0 || !listRef.current) return
    const item = listRef.current.children[highlightIndex] as HTMLElement | undefined
    if (item) scrollIntoViewNearest(listRef.current, item)
  }, [highlightIndex])

  const pick = useCallback(
    async (sug: GeocodeSuggestion) => {
      let final = sug
      if (sug.latitude === 0 && sug.longitude === 0) {
        try {
          final = await geocodeResolve(sug.place_id, sessionToken)
        } catch {
          // Resolve failed — fall back to using label/address as free-form text
          final = { ...sug, latitude: 0, longitude: 0 }
        }
      }
      // Only auto-fill label if user hasn't typed one
      if (!label.trim()) {
        setLabel(final.label)
      }
      setQuery(final.address)
      setSelectedSuggestion(final)
      setHighlightIndex(-1)
      setDropdownClosedManually(true)
    },
    [label, sessionToken],
  )

  function pickSavedAlias(alias: LocationAlias) {
    setLabel(alias.label)
    setQuery(alias.address)
    const synthetic: GeocodeSuggestion = {
      place_id: `alias:${alias.id}`,
      label: alias.label,
      address: alias.address,
      latitude: alias.latitude,
      longitude: alias.longitude,
    }
    setSelectedSuggestion(synthetic)
    setDropdownClosedManually(true)
    setSavedListOpen(false)
  }

  function handleQueryChange(newQuery: string) {
    setQuery(newQuery)
    setGeocodeEnabled(true)
    // Reopen dropdown when user types a new query
    setDropdownClosedManually(false)
    setHighlightIndex(-1)
    // If user edits the query after selecting a suggestion, clear the selection
    if (selectedSuggestion && newQuery !== selectedSuggestion.address) {
      setSelectedSuggestion(null)
    }
  }

  function handleAddressKeyDown(e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (!showDropdown && e.key !== 'Escape') return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIndex((prev) => (prev + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIndex((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1))
    } else if (e.key === 'Enter' && highlightIndex >= 0) {
      e.preventDefault()
      const sug = suggestions[highlightIndex]
      if (sug) {
        void pick(sug)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (showDropdown) {
        setDropdownClosedManually(true)
        setHighlightIndex(-1)
      } else {
        onClose()
      }
    }
  }

  function handleSave() {
    const lbl = label.trim() || null
    const addr = selectedSuggestion ? selectedSuggestion.address : query.trim() || null
    const lat =
      selectedSuggestion &&
      (selectedSuggestion.latitude !== 0 || selectedSuggestion.longitude !== 0)
        ? selectedSuggestion.latitude
        : null
    const lng =
      selectedSuggestion &&
      (selectedSuggestion.latitude !== 0 || selectedSuggestion.longitude !== 0)
        ? selectedSuggestion.longitude
        : null

    // Auto-save as alias when label + address are present and not already saved
    if (lbl && addr) {
      const alreadySaved = savedAliases.some((a) => a.label.toLowerCase() === lbl.toLowerCase())
      if (!alreadySaved) {
        createLocationAlias(lbl, addr, lat ?? 0, lng ?? 0).catch(() => {
          // Silently ignore — alias saving is best-effort
        })
      }
    }

    onSelect(lat, lng, lbl, addr)
    onClose()
  }

  function handleClear() {
    setLabel('')
    setQuery('')
    setSelectedSuggestion(null)
    setDropdownClosedManually(true)
    onSelect(null, null, null, null)
    onClose()
  }

  const suggestionsListId = 'loc-address-suggestions'
  const optionId = (idx: number) => `loc-suggestion-${idx}`
  const activeOptionId = showDropdown && highlightIndex >= 0 ? optionId(highlightIndex) : undefined
  const previewCoords = resolveLocationPreviewCoords(selectedSuggestion)
  const previewLiveDescription = previewCoords
    ? t('location_picker.map_preview_live', {
        label: selectedSuggestion?.label ?? selectedSuggestion?.address ?? '',
      })
    : t('location_picker.map_preview_empty')

  return (
    <div
      ref={containerRef}
      className="border-border-default bg-elevated w-72 rounded-2xl border p-4 shadow-lg"
      role="dialog"
      aria-label={t('location_picker.dialog_aria')}
    >
      <div className="mb-3 flex flex-col gap-2">
        {/* Label */}
        <div className="flex flex-col gap-1">
          <label htmlFor="loc-label" className="text-fg-muted text-xs font-medium">
            {t('location_picker.label_label')}
          </label>
          <TextInput
            id="loc-label"
            value={label}
            onChange={setLabel}
            placeholder={t('location_picker.label_placeholder')}
            className="py-1.5"
          />
        </div>

        {/* Address search */}
        <div className="flex flex-col gap-1">
          <label htmlFor="loc-address" className="text-fg-muted text-xs font-medium">
            {t('location_picker.address_label')}
          </label>
          <div className="relative">
            <TextInput
              id="loc-address"
              value={query}
              onChange={handleQueryChange}
              onKeyDown={handleAddressKeyDown}
              placeholder={t('location_picker.address_placeholder')}
              className="py-1.5 pr-8"
              autoComplete="off"
              role="combobox"
              aria-autocomplete="list"
              aria-controls={suggestionsListId}
              aria-expanded={showDropdown}
              aria-activedescendant={activeOptionId}
            />
            {isLoading && (
              <span
                className="pointer-events-none absolute top-1/2 right-2.5 flex -translate-y-1/2 items-center"
                aria-hidden="true"
              >
                <InlineOrb state="solving" />
              </span>
            )}
          </div>

          {/* Suggestions dropdown */}
          {showDropdown && suggestions.length > 0 && (
            <ul
              ref={listRef}
              id={suggestionsListId}
              role="listbox"
              aria-label={t('location_picker.suggestions_aria')}
              className="border-border-default bg-elevated mt-0.5 max-h-60 overflow-y-auto rounded-xl border shadow-md"
            >
              {suggestions.map((sug, idx) => {
                const isAlias = sug.place_id.startsWith('alias:')
                const isLastAlias =
                  isAlias && idx === matchedAliasSuggestions.length - 1 && apiSuggestions.length > 0
                return (
                  <li
                    key={sug.place_id}
                    id={optionId(idx)}
                    role="option"
                    aria-selected={idx === highlightIndex}
                    onMouseEnter={() => setHighlightIndex(idx)}
                    onClick={() => void pick(sug)}
                    className={cn(
                      'cursor-pointer px-3 py-2 text-sm',
                      'transition-colors duration-(--motion-duration-fast)',
                      isLastAlias
                        ? 'border-border-default border-b-2'
                        : idx !== suggestions.length - 1
                          ? 'border-border-default border-b'
                          : '',
                      idx === highlightIndex ? 'bg-accent/10 text-fg' : 'text-fg hover:bg-accent/5',
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <p className="truncate leading-tight font-medium">{sug.label}</p>
                      {isAlias && (
                        <span className="bg-accent/15 text-accent text-2xs shrink-0 rounded px-1 py-0.5 leading-none font-medium">
                          {t('location_picker.saved_badge')}
                        </span>
                      )}
                    </div>
                    <p className="text-fg-muted truncate text-xs leading-tight">{sug.address}</p>
                  </li>
                )
              })}
            </ul>
          )}

          {/* Status row */}
          {!showDropdown && isLoading && trimmedQuery.length >= 2 && (
            <p className="text-fg-muted text-xs">{t('location_picker.searching')}</p>
          )}
          {!isLoading &&
            !showDropdown &&
            trimmedQuery.length >= 2 &&
            apiSuggestions.length === 0 &&
            matchedAliasSuggestions.length === 0 &&
            !error && <p className="text-fg-muted text-xs">{t('location_picker.no_results')}</p>}
          {error && (
            <Callout tone="info" size="sm" className="mt-1">
              {t('location_picker.error_unavailable')}
            </Callout>
          )}
        </div>

        {/* Saved locations toggle */}
        {savedAliases.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setSavedListOpen((prev) => !prev)}
              className={cn(
                'flex w-full items-center justify-between',
                'text-fg-muted hover:text-fg text-xs font-medium',
                'transition-colors duration-(--motion-duration-fast)',
              )}
            >
              <span>{t('location_picker.saved_locations')}</span>
              {savedListOpen ? (
                <ChevronUp className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </button>

            {savedListOpen && (
              <ul className="border-border-default bg-elevated mt-1.5 max-h-40 overflow-y-auto rounded-xl border shadow-md">
                {savedAliases.map((alias, idx) => (
                  <li
                    key={alias.id}
                    onClick={() => pickSavedAlias(alias)}
                    className={cn(
                      'cursor-pointer px-3 py-2 text-sm',
                      'transition-colors duration-(--motion-duration-fast)',
                      idx !== savedAliases.length - 1 ? 'border-border-default border-b' : '',
                      'text-fg hover:bg-accent/5',
                    )}
                  >
                    <p className="truncate leading-tight font-medium">{alias.label}</p>
                    {alias.address && (
                      <p className="text-fg-muted truncate text-xs leading-tight">
                        {alias.address}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="mb-3">
        {previewCoords ? (
          <LocationMapPreview
            latitude={previewCoords.latitude}
            longitude={previewCoords.longitude}
            ariaLabel={t('location_picker.map_preview_aria')}
            liveDescription={previewLiveDescription}
          />
        ) : (
          <LocationMapPreviewPlaceholder message={t('location_picker.map_preview_empty')} />
        )}
      </div>

      {/* Buttons */}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" onClick={handleSave} className="flex-1 justify-center">
          {t('location_picker.save')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleClear}
          className="flex-1 justify-center"
        >
          {t('location_picker.clear')}
        </Button>
      </div>
    </div>
  )
}

interface PinCoords {
  latitude: number
  longitude: number
}

/** Initial view of the pin map with no pin yet: the whole world. */
const WORLD_CENTER: [number, number] = [20, 0]
const WORLD_ZOOM = 1
/** Zoom of the pin map opened on an existing pin. */
const PIN_ZOOM = 13

/** Six decimals (about 10 cm): what a click on a map can mean. */
const roundCoord = (v: number): number => Math.round(v * 1e6) / 1e6

/**
 * Interactive map of the web picker: a click drops (or moves) the pin. Tiles come only from the
 * source the user consented to (MapTiler with their own key, `useWebMapTiles`); the caller renders
 * this only while that source is usable.
 */
function WebPinMap({
  pin,
  onPin,
  ariaLabel,
}: {
  pin: PinCoords | null
  onPin: (pin: PinCoords) => void
  ariaLabel: string
}) {
  const { resolvedTheme } = useTheme()
  const { source, maptilerKey } = useMapSourceSettings()
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const tileRef = useRef<L.Layer | null>(null)
  const markerRef = useRef<L.CircleMarker | null>(null)
  const onPinRef = useRef(onPin)
  onPinRef.current = onPin
  const initialPin = useRef(pin)

  useEffect(() => {
    if (!containerRef.current) return
    const start = initialPin.current
    const map = L.map(containerRef.current, {
      center: start ? [start.latitude, start.longitude] : WORLD_CENTER,
      zoom: start ? PIN_ZOOM : WORLD_ZOOM,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      zoomControl: true,
      attributionControl: true,
    })
    map.on('click', (e: L.LeafletMouseEvent) => {
      const at = e.latlng.wrap()
      onPinRef.current({ latitude: roundCoord(at.lat), longitude: roundCoord(at.lng) })
    })
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
      tileRef.current = null
      markerRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    tileRef.current?.remove()
    tileRef.current = null
    const layer = createMapBasemapLayer(source, resolvedTheme, maptilerKey)
    if (layer) tileRef.current = layer.addTo(map)
  }, [resolvedTheme, source, maptilerKey])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markerRef.current?.remove()
    markerRef.current = null
    if (!pin) return
    markerRef.current = L.circleMarker([pin.latitude, pin.longitude], {
      radius: 8,
      color: 'var(--color-accent)',
      fillColor: 'var(--color-accent)',
      fillOpacity: 0.85,
      weight: 2,
    }).addTo(map)
  }, [pin])

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="h-40 w-full cursor-crosshair rounded-xl outline-none [--map-surface:var(--color-elevated)]"
      aria-label={ariaLabel}
    />
  )
}

/**
 * Web location picker (Q3): a typed label and address, a pin dropped on the map the user consented
 * to in Locations (MapTiler tiles), and clear. No geocoding, no saved aliases, no GPS: nothing here
 * leaves the browser except the map tiles the user turned on.
 */
function WebLocationPicker({
  onSelect,
  onClose,
  currentLabel = null,
  currentAddress = null,
  currentLatitude = null,
  currentLongitude = null,
  toggleRef,
}: LocationPickerProps) {
  const { t } = useTranslation('editor')
  const [label, setLabel] = useState(currentLabel ?? '')
  const [address, setAddress] = useState(currentAddress ?? '')
  const [pin, setPin] = useState<PinCoords | null>(
    currentLatitude !== null && currentLongitude !== null
      ? { latitude: currentLatitude, longitude: currentLongitude }
      : null,
  )
  const containerRef = useRef<HTMLDivElement>(null)
  const { usable, isLoading } = useMapSourceUsable()

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      const target = e.target as Node
      if (toggleRef?.current?.contains(target)) return
      if (containerRef.current && !containerRef.current.contains(target)) onClose()
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [onClose, toggleRef])

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  function handleSave() {
    onSelect(
      pin?.latitude ?? null,
      pin?.longitude ?? null,
      label.trim() || null,
      address.trim() || null,
    )
    onClose()
  }

  function handleClear() {
    onSelect(null, null, null, null)
    onClose()
  }

  return (
    <div
      ref={containerRef}
      className="border-border-default bg-elevated w-72 rounded-2xl border p-4 shadow-lg"
      role="dialog"
      aria-label={t('location_picker.dialog_aria')}
    >
      <div className="mb-3 flex flex-col gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="loc-label" className="text-fg-muted text-xs font-medium">
            {t('location_picker.label_label')}
          </label>
          <TextInput
            id="loc-label"
            value={label}
            onChange={setLabel}
            onKeyDown={handleKeyDown}
            placeholder={t('location_picker.label_placeholder')}
            maxLength={1000}
            className="py-1.5"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="loc-address" className="text-fg-muted text-xs font-medium">
            {t('location_picker.address_label')}
          </label>
          <TextInput
            id="loc-address"
            value={address}
            onChange={setAddress}
            onKeyDown={handleKeyDown}
            placeholder={t('location_picker.address_placeholder_web')}
            maxLength={1000}
            autoComplete="off"
            className="py-1.5"
          />
        </div>
      </div>

      <div className="mb-3 flex flex-col gap-1.5">
        {isLoading ? (
          <div className="border-border-default bg-elevated h-40 w-full animate-pulse rounded-xl border motion-reduce:animate-none" />
        ) : usable ? (
          <>
            <WebPinMap pin={pin} onPin={setPin} ariaLabel={t('location_picker.pin_map_aria')} />
            <div className="flex min-h-6 items-center justify-between gap-2">
              <p className="text-fg-muted truncate text-xs" aria-live="polite">
                {pin
                  ? t('location_picker.pin_coords', {
                      latitude: pin.latitude.toFixed(4),
                      longitude: pin.longitude.toFixed(4),
                    })
                  : t('location_picker.pin_hint')}
              </p>
              {pin && (
                <Button variant="ghost" size="xs" onClick={() => setPin(null)} className="shrink-0">
                  {t('location_picker.pin_remove')}
                </Button>
              )}
            </div>
          </>
        ) : (
          <LocationMapPreviewPlaceholder message={t('location_picker.pin_needs_tiles')} />
        )}
      </div>

      <div className="flex gap-2">
        <Button variant="primary" size="sm" onClick={handleSave} className="flex-1 justify-center">
          {t('location_picker.save')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleClear}
          className="flex-1 justify-center"
        >
          {t('location_picker.clear')}
        </Button>
      </div>
    </div>
  )
}

import { forwardRef, useEffect, useRef, useState } from 'react'
import Map, { NavigationControl } from 'react-map-gl/mapbox'
import 'mapbox-gl/dist/mapbox-gl.css'
import { searchCities, isOffline } from '../lib/geocoder.ts'

/**
 * MapboxWrapper (#87)
 *
 * Encapsulates Mapbox / react-map-gl initialisation so pages don't have to
 * repeat the access-token wiring, the default view state and the standard
 * on-map controls. Everything specific to a screen — markers, sources,
 * layers, popups, controllers — is passed as `children` and rendered inside
 * the underlying `<Map>` exactly as before.
 */

const DEFAULT_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN
const DEFAULT_VIEW_STATE = { longitude: 0, latitude: 20, zoom: 2 }
const FILL_PARENT: React.CSSProperties = { width: '100%', height: '100%' }

interface MapboxWrapperProps {
  mapStyle: string
  onMapClick?: (e: unknown) => void
  initialViewState?: { longitude: number; latitude: number; zoom: number }
  accessToken?: string
  showNavigationControl?: boolean
  onIsolationChange?: (isolated: boolean) => void
  onProviderChange?: (provider: 'online' | 'offline') => void
  navigationControlPosition?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
  style?: React.CSSProperties
  children?: React.ReactNode
  [key: string]: unknown
}

const MapboxWrapper = forwardRef<unknown, MapboxWrapperProps>(function MapboxWrapper(
  {
    mapStyle,
    onMapClick,
    initialViewState,
    accessToken,
    showNavigationControl = true,
    navigationControlPosition = 'bottom-right',
    onIsolationChange,
    onProviderChange,
    style = FILL_PARENT,
    children,
    ...rest
  },
  ref,
) {
  const [provider, setProvider] = useState<'online' | 'offline'>('online')
  const providerRef = useRef(provider)
  providerRef.current = provider

  // #518: fall back to the offline geocoder when Mapbox can't serve tiles —
  // detect via navigator.onLine and notify callers so they swap the search
  // suggestions source. (`onMapError` on `<Map>` also flips the flag if the
  // tile/style request itself fails while the network looks fine.)
  useEffect(() => {
    const update = () => {
      const next = isOffline() || !(accessToken ?? DEFAULT_TOKEN) ? 'offline' : 'online'
      if (next !== providerRef.current) {
        setProvider(next)
      }
    }
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [accessToken])

  useEffect(() => {
    if (typeof onProviderChange === 'function') onProviderChange(provider)
  }, [provider, onProviderChange])

  return (
    <Map
      // @ts-expect-error ref forwarding for react-map-gl
      ref={ref}
      mapboxAccessToken={accessToken ?? DEFAULT_TOKEN}
      initialViewState={initialViewState ?? DEFAULT_VIEW_STATE}
      style={style}
      onLoad={() => onIsolationChange?.(globalThis.crossOriginIsolated === true)}
      mapStyle={mapStyle}
      onClick={onMapClick}
      onError={() => {
        if (providerRef.current !== 'offline') setProvider('offline')
      }}
      {...rest}
    >
      {showNavigationControl && (
        <NavigationControl position={navigationControlPosition} />
      )}
      {provider === 'offline' && typeof children === 'function'
        ? (children as (ctx: { provider: 'online' | 'offline'; searchCities: typeof searchCities }) => React.ReactNode)({ provider, searchCities })
        : children}
    </Map>
  )
})

export default MapboxWrapper

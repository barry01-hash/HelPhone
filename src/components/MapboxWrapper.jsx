import { forwardRef, useEffect, useRef, useState } from "react";
import Map, { NavigationControl } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { searchCities, isOffline } from "../lib/geocoder.ts";

/**
 * MapboxWrapper (#87)
 *
 * Encapsulates Mapbox / react-map-gl initialisation so pages don't have to
 * repeat the access-token wiring, the default view state and the standard
 * on-map controls. Everything specific to a screen — markers, sources,
 * layers, popups, controllers — is passed as `children` and rendered inside
 * the underlying `<Map>` exactly as before.
 *
 * The component forwards its ref to the react-map-gl `<Map>` instance, so
 * callers that need the imperative map handle (`ref.current.getMap()`) keep
 * working.
 *
 * Props:
 *  - `mapStyle`         Mapbox style URL (required).
 *  - `onMapClick`       Click handler, receives the react-map-gl event
 *                       (`e.lngLat` etc). Optional.
 *  - `initialViewState` Overrides the default world view. Optional.
 *  - `accessToken`      Overrides `VITE_MAPBOX_TOKEN`. Optional.
 *  - `showNavigationControl` Render the built-in zoom/compass control
 *                       (default `true`).
 *  - `navigationControlPosition` default `"bottom-right"`.
 *  - `style`            Container style, defaults to fill the parent.
 *  - `children`         Map overlays.
 *  - any other prop is forwarded to `<Map>`.
 */

const DEFAULT_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

const DEFAULT_VIEW_STATE = {
  // Centre of the world, fully zoomed out — the same starting point Help.jsx
  // used before this component existed.
  longitude: 0,
  latitude: 20,
  zoom: 2,
};

const FILL_PARENT = { width: "100%", height: "100%" };

const MapboxWrapper = forwardRef(function MapboxWrapper(
  {
    mapStyle,
    onMapClick,
    initialViewState,
    accessToken,
    showNavigationControl = true,
    navigationControlPosition = "bottom-right",
    style = FILL_PARENT,
    onProviderChange,
    children,
    ...rest
  },
  ref,
) {
  const internalRef = useRef(null);
  const [provider, setProvider] = useState("online");
  const providerRef = useRef(provider);
  providerRef.current = provider;

  // #518: fall back to the offline geocoder when Mapbox can't serve tiles —
  // detect via navigator.onLine and notify callers so they swap the search
  // suggestions source. (`onMapError` on `<Map>` also flips the flag if the
  // tile/style request itself fails while the network looks fine.)
  useEffect(() => {
    const update = () => {
      const next = isOffline() || !(accessToken ?? DEFAULT_TOKEN) ? "offline" : "online";
      if (next !== providerRef.current) {
        setProvider(next);
      }
    };
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [accessToken]);

  useEffect(() => {
    onProviderChange?.(provider);
  }, [provider, onProviderChange]);

  useEffect(() => {
    return () => {
      if (internalRef.current?.getMap) {
        try {
          const mapInstance = internalRef.current.getMap();
          if (mapInstance) {
            mapInstance.remove();
          }
        } catch {
          // Map already removed or disposed
        }
      }
    };
  }, []);

  // Expose the offline geocoder so page-level search UIs can query it directly
  // when the provider flips to offline.
  const offlineSearch = provider === "offline" ? searchCities : null;

  return (
    <Map
      ref={(mapInstance) => {
        internalRef.current = mapInstance;
        if (typeof ref === 'function') {
          ref(mapInstance);
        } else if (ref) {
          ref.current = mapInstance;
        }
      }}
      mapboxAccessToken={accessToken ?? DEFAULT_TOKEN}
      initialViewState={initialViewState ?? DEFAULT_VIEW_STATE}
      style={style}
      mapStyle={mapStyle}
      onClick={onMapClick}
      onError={() => {
        if (providerRef.current !== "offline") {
          setProvider("offline");
        }
      }}
      {...rest}
    >
      {showNavigationControl && (
        <NavigationControl position={navigationControlPosition} />
      )}
      {offlineSearch && typeof children === "function" ? children({ provider, searchCities: offlineSearch }) : children}
    </Map>
  );
});

export default MapboxWrapper;

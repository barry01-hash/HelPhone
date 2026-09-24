/**
 * Offline city geocoder (#518)
 *
 * When the network (or the Mapbox token) is unavailable, users must still be
 * able to place an emergency request. This module provides:
 *
 *   1. `searchCities(query)`          — async, dataset-aware fuzzy search.
 *      The full `/data/cities.json` dataset is fetched once (with a short
 *      timeout + IndexedDB cache); when the fetch fails or is offline it falls
 *      back to an embedded mini-dataset so the app always has *something*.
 *   2. `searchCitiesSync(query)`      — sync variant on the embedded dataset
 *      only, for tests and the instant first keystroke.
 *   3. Mapbox-compatible suggestion shape — each result exposes `id`, `text`,
 *      `place_name` and `center: [lng, lat]` so the existing Mapbox UI code
 *      (`useLocationSearch`) can render offline hits without changes.
 *
 * Matching is typo-tolerant via fuse.js. Results carry
 * `source: "offline"` so UI can badge "matched offline".
 */

import Fuse from "fuse.js";

export interface CityRecord {
  id: string;
  name: string;
  cc: string;
  country: string;
  lat: number;
  lng: number;
  alt?: string[];
}

/** Shape that mirrors a Mapbox Geocoding feature (the parts we use). */
export interface GeocoderSuggestion {
  id: string;
  text: string;
  place_name: string;
  center: [number, number];
  source: "offline";
  properties?: { offline: boolean; score?: number };
}

const FETCH_TIMEOUT_MS = 5000;

/** Embedded fallback dataset — always available, keeps the app functional
 *  even before/without the network AND gives tests a deterministic source. */
const EMBEDDED_CITIES: CityRecord[] = [
  ["New York", "US", "United States", 40.7128, -74.006],
  ["Los Angeles", "US", "United States", 34.0522, -118.2437],
  ["Chicago", "US", "United States", 41.8781, -87.6298],
  ["Houston", "US", "United States", 29.7604, -95.3698],
  ["Phoenix", "US", "United States", 33.4484, -112.074],
  ["Philadelphia", "US", "United States", 39.9526, -75.1652],
  ["San Antonio", "US", "United States", 29.4241, -98.4936],
  ["San Diego", "US", "United States", 32.7157, -117.1611],
  ["Dallas", "US", "United States", 32.7767, -96.797],
  ["Austin", "US", "United States", 30.2672, -97.7431],
  ["Seattle", "US", "United States", 47.6062, -122.3321],
  ["Denver", "US", "United States", 39.7392, -104.9903],
  ["Washington", "US", "United States", 38.9072, -77.0369],
  ["Boston", "US", "United States", 42.3601, -71.0589],
  ["Portland", "US", "United States", 45.5152, -122.6784],
  ["Atlanta", "US", "United States", 33.749, -84.388],
  ["Miami", "US", "United States", 25.7617, -80.1918],
  ["Minneapolis", "US", "United States", 44.9778, -93.265],
  ["San Francisco", "US", "United States", 37.7749, -122.4194],
  ["Las Vegas", "US", "United States", 36.1699, -115.1398],
  ["New Orleans", "US", "United States", 29.9511, -90.0715],
  ["Orlando", "US", "United States", 28.5384, -81.3789],
  ["Honolulu", "US", "United States", 21.3069, -157.8583],
  ["London", "GB", "United Kingdom", 51.5074, -0.1278, ["Manchester", "Birmingham", "Glasgow", "Edinburgh"]],
  ["Paris", "FR", "France", 48.8566, 2.3522, ["Marseille", "Lyon", "Lille", "Nice"]],
  ["Berlin", "DE", "Germany", 52.52, 13.405, ["Munich", "Hamburg", "Frankfurt"]],
  ["Madrid", "ES", "Spain", 40.4168, -3.7038, ["Barcelona", "Seville", "Valencia"]],
  ["Rome", "IT", "Italy", 41.9028, 12.4964, ["Milan", "Naples", "Florence", "Venice"]],
  ["Amsterdam", "NL", "Netherlands", 52.3676, 4.9041, ["Rotterdam", "Utrecht"]],
  ["Brussels", "BE", "Belgium", 50.8503, 4.3517],
  ["Vienna", "AT", "Austria", 48.2082, 16.3738],
  ["Zurich", "CH", "Switzerland", 47.3769, 8.5417, ["Geneva", "Bern", "Basel"]],
  ["Stockholm", "SE", "Sweden", 59.3293, 18.0686],
  ["Oslo", "NO", "Norway", 59.9139, 10.7522],
  ["Copenhagen", "DK", "Denmark", 55.6761, 12.5683],
  ["Helsinki", "FI", "Finland", 60.1699, 24.9384],
  ["Dublin", "IE", "Ireland", 53.3498, -6.2603],
  ["Lisbon", "PT", "Portugal", 38.7223, -9.1393, ["Porto"]],
  ["Warsaw", "PL", "Poland", 52.2297, 21.0122, ["Krakow"]],
  ["Prague", "CZ", "Czech Republic", 50.0755, 14.4378],
  ["Budapest", "HU", "Hungary", 47.4979, 19.0402],
  ["Athens", "GR", "Greece", 37.9838, 23.7275],
  ["Istanbul", "TR", "Turkey", 41.0082, 28.9784],
  ["Moscow", "RU", "Russia", 55.7558, 37.6173, ["Saint Petersburg"]],
  ["Kyiv", "UA", "Ukraine", 50.4501, 30.5234],
  ["Cairo", "EG", "Egypt", 30.0444, 31.2357],
  ["Casablanca", "MA", "Morocco", 33.5731, -7.5898],
  ["Lagos", "NG", "Nigeria", 6.5244, 3.3792],
  ["Nairobi", "KE", "Kenya", -1.2921, 36.8219],
  ["Johannesburg", "ZA", "South Africa", -26.2041, 28.0473],
  ["Cape Town", "ZA", "South Africa", -33.9249, 18.4241],
  ["Accra", "GH", "Ghana", 5.6037, -0.187],
  ["Addis Ababa", "ET", "Ethiopia", 9.0054, 38.7636],
  ["Khartoum", "SD", "Sudan", 15.5007, 32.5599],
  ["Tehran", "IR", "Iran", 35.6892, 51.389],
  ["Baghdad", "IQ", "Iraq", 33.3152, 44.3661],
  ["Dubai", "AE", "United Arab Emirates", 25.2048, 55.2708],
  ["Riyadh", "SA", "Saudi Arabia", 24.7136, 46.6753, ["Jeddah"]],
  ["Tel Aviv", "IL", "Israel", 32.0853, 34.7818],
  ["Jerusalem", "IL", "Israel", 31.7683, 35.2137],
  ["New Delhi", "IN", "India", 28.6139, 77.209, ["Delhi", "Mumbai", "Bangalore", "Chennai", "Kolkata", "Pune"]],
  ["Mumbai", "IN", "India", 19.076, 72.8777, ["Bombay"]],
  ["Bangalore", "IN", "India", 12.9716, 77.5946],
  ["Chennai", "IN", "India", 13.0827, 80.2707],
  ["Kolkata", "IN", "India", 22.5726, 88.3639],
  ["Beijing", "CN", "China", 39.9042, 116.4074],
  ["Shanghai", "CN", "China", 31.2304, 121.4737],
  ["Tokyo", "JP", "Japan", 35.6762, 139.6503, ["Osaka", "Kyoto", "Yokohama"]],
  ["Osaka", "JP", "Japan", 34.6937, 135.5023],
  ["Seoul", "KR", "South Korea", 37.5665, 126.978, ["Busan"]],
  ["Bangkok", "TH", "Thailand", 13.7563, 100.5018, ["Chiang Mai"]],
  ["Singapore", "SG", "Singapore", 1.3521, 103.8198],
  ["Kuala Lumpur", "MY", "Malaysia", 3.139, 101.6869],
  ["Jakarta", "ID", "Indonesia", -6.2088, 106.8456],
  ["Manila", "PH", "Philippines", 14.5995, 120.9842, ["Quezon City", "Cebu City"]],
  ["Ho Chi Minh City", "VN", "Vietnam", 10.8231, 106.6297, ["Saigon"]],
  ["Hanoi", "VN", "Vietnam", 21.0278, 105.8342],
  ["Kathmandu", "NP", "Nepal", 27.7172, 85.324],
  ["Dhaka", "BD", "Bangladesh", 23.8103, 90.4125],
  ["Karachi", "PK", "Pakistan", 24.8607, 67.0011],
  ["Lahore", "PK", "Pakistan", 31.5204, 74.3587],
  ["Colombo", "LK", "Sri Lanka", 6.9271, 79.8612],
  ["Sydney", "AU", "Australia", -33.8688, 151.2093],
  ["Melbourne", "AU", "Australia", -37.8136, 144.9631],
  ["Auckland", "NZ", "New Zealand", -36.8509, 174.7645],
  ["Wellington", "NZ", "New Zealand", -41.2866, 174.7756],
  ["Mexico City", "MX", "Mexico", 19.4326, -99.1332, ["Guadalajara", "Monterrey", "Cancun"]],
  ["Guadalajara", "MX", "Mexico", 20.6597, -103.3496],
  ["Buenos Aires", "AR", "Argentina", -34.6037, -58.3816],
  ["Sao Paulo", "BR", "Brazil", -23.5505, -46.6333, ["São Paulo"]],
  ["Rio de Janeiro", "BR", "Brazil", -22.9068, -43.1729],
  ["Lima", "PE", "Peru", -12.0464, -77.0428],
  ["Bogota", "CO", "Colombia", 4.711, -74.0721],
  ["Santiago", "CL", "Chile", -33.4489, -70.6693],
  ["Quito", "EC", "Ecuador", -0.1807, -78.4678],
  ["Caracas", "VE", "Venezuela", 10.4806, -66.9036],
  ["Panama City", "PA", "Panama", 8.9824, -79.5199],
  ["Havana", "CU", "Cuba", 23.1136, -82.3666],
  ["Kingston", "JM", "Jamaica", 17.9714, -76.7936],
].map(([name, cc, country, lat, lng, alt]: [string, string, string, number, number, string[]?]) => {
  const record: CityRecord = {
    id: `${cc.toLowerCase()}-${slugify(name)}`,
    name,
    cc,
    country,
    lat,
    lng,
  };
  if (Array.isArray(alt) && alt.length) record.alt = alt as string[];
  return record;
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Deterministic sync search on the embedded dataset ───────────────

let embeddedIndex: Fuse<CityRecord> | null = null;

function getEmbeddedIndex(): Fuse<CityRecord> {
  if (!embeddedIndex) {
    embeddedIndex = new Fuse(EMBEDDED_CITIES, {
      keys: ["name", "country", "cc", "alt"],
      threshold: 0.35,
      shouldSort: true,
      ignoreLocation: true,
    });
  }
  return embeddedIndex;
}

/** Search the embedded fallback dataset without touching the network. */
export function searchCitiesSync(
  query: string,
  options: { limit?: number } = {},
): GeocoderSuggestion[] {
  const { limit = 6 } = options;
  if (!query || !query.trim()) return [];
  const q = query.trim();
  const hits = getEmbeddedIndex().search(q, { limit });
  return hits.map((result) => toSuggestion(result.item, result.score));
}

// ── Async dataset-aware search (full cities.json + IndexedDB cache) ─

let fullIndexPromise: Promise<Fuse<CityRecord>> | null = null;

/** Whether the host environment believes we are offline right now. */
export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function withTimeout(
  promise: Promise<Response>,
  ms: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cities fetch timed out")), ms);
    promise.then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function fetchCitiesDataset(): Promise<CityRecord[]> {
  try {
    const res = await withTimeout(fetch(`${import.meta.env.BASE_URL || "/"}data/cities.json`));
    if (!res.ok) throw new Error(`cities fetch HTTP ${res.status}`);
    const payload = await res.json();
    if (Array.isArray(payload.cities) && payload.cities.length > 0) {
      return payload.cities as CityRecord[];
    }
    if (Array.isArray(payload)) return payload as CityRecord[];
    throw new Error("unexpected cities payload");
  } catch {
    // Offline / network hiccup → the embedded dataset keeps the app usable.
    return EMBEDDED_CITIES;
  }
}

let cachedDataset: CityRecord[] | null = null;

export async function loadCityDataset(): Promise<CityRecord[]> {
  if (cachedDataset) return cachedDataset;

  // IndexedDB cache lets repeat sessions boot offline in milliseconds.
  const stored = await idbRead<CityRecord[]>("dataset");
  if (stored && stored.length > 0) {
    cachedDataset = stored;
    return cachedDataset;
  }

  cachedDataset = await fetchCitiesDataset();
  await idbWrite("dataset", cachedDataset).catch(() => undefined);
  return cachedDataset;
}

export async function getFuseIndex(): Promise<Fuse<CityRecord>> {
  if (!fullIndexPromise) {
    fullIndexPromise = loadCityDataset().then(
      (cities) =>
        new Fuse(cities, {
          keys: ["name", "country", "cc", "alt"],
          threshold: 0.35,
          shouldSort: true,
          ignoreLocation: true,
        }),
    );
    fullIndexPromise.catch(() => {
      fullIndexPromise = null; // allow retry on next call
    });
  }
  return fullIndexPromise;
}

/** Search the full dataset (fetched once, falls back to embedded when offline). */
export async function searchCities(
  query: string,
  options: { limit?: number } = {},
): Promise<GeocoderSuggestion[]> {
  const { limit = 6 } = options;
  if (!query || !query.trim()) return [];
  const q = query.trim();
  if (isOffline() && !fullIndexPromise) {
    return searchCitiesSync(q, { limit });
  }
  const index = await getFuseIndex();
  const hits = index.search(q, { limit });
  return hits.map((result) => toSuggestion(result.item, result.score));
}

/** Drop every in-memory cache (embedded fuse index + full dataset) so tests
 *  and hot module reloads start clean. */
export function clearGeocoderCache(): void {
  embeddedIndex = null;
  fullIndexPromise = null;
  cachedDataset = null;
}

function toSuggestion(city: CityRecord, score?: number): GeocoderSuggestion {
  return {
    id: city.id,
    text: city.name,
    place_name: `${city.name}, ${city.country}`,
    center: [city.lng, city.lat],
    source: "offline",
    properties: { offline: true, score: score ?? undefined },
  };
}

// ── IndexedDB cache (best-effort, never throws) ────────────────────

const DB_NAME = "helphone-geocoder";
const DB_VERSION = 1;
const STORE = "kv";

function idbOpen(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbRead<T>(key: string): Promise<T | undefined> {
  const db = await idbOpen();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const getReq = tx.objectStore(STORE).get(key);
      getReq.onsuccess = () => resolve(getReq.result as T | undefined);
      getReq.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function idbWrite(key: string, value: unknown): Promise<void> {
  const db = await idbOpen();
  if (!db) return;
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error("idb write failed"));
    } catch (err) {
      reject(err);
    }
  });
}
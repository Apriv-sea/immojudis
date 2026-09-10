const DEFAULT_MAPBOX_STYLE = "mapbox/streets-v12";
const DEFAULT_STATIC_IMAGE_SIZE = { width: 640, height: 360 };
const MAPBOX_STATIC_STREETS_STYLE = "mapbox/streets-v12";
const MAPBOX_STATIC_SATELLITE_STYLE = "mapbox/satellite-v9";

export const MAPBOX_ATTRIBUTION = "© Mapbox © OpenStreetMap";
export const MAPBOX_COPYRIGHT_URL = "https://www.mapbox.com/about/maps/";

export function getMapboxAccessToken() {
  return (process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN ?? "").trim();
}

export function getMapboxStylePath() {
  return normalizeMapboxStyle(
    (
      process.env.NEXT_PUBLIC_MAPBOX_STYLE ??
      process.env.NEXT_PUBLIC_MAPBOX_STYLE_ID ??
      DEFAULT_MAPBOX_STYLE
    ).trim(),
  );
}

export function getMapboxStyleUrl() {
  return `mapbox://styles/${getMapboxStylePath()}`;
}

export function mapboxStaticImageUrl({
  lat,
  lng,
  zoom = 15,
  bearing,
  pitch,
  width = DEFAULT_STATIC_IMAGE_SIZE.width,
  height = DEFAULT_STATIC_IMAGE_SIZE.height,
  marker = true,
  style,
}: {
  lat: number;
  lng: number;
  zoom?: number;
  bearing?: number;
  pitch?: number;
  width?: number;
  height?: number;
  marker?: boolean;
  style?: string;
}) {
  const token = getMapboxAccessToken();
  if (!token) return "";

  const stylePath = style ? normalizeMapboxStyle(style) : getMapboxStylePath();
  const safeZoom = Math.max(0, Math.min(22, zoom));
  const safeWidth = Math.max(1, Math.min(1280, Math.round(width)));
  const safeHeight = Math.max(1, Math.min(1280, Math.round(height)));
  const camera = [formatCoordinate(lng), formatCoordinate(lat), formatCoordinate(safeZoom)];
  if (bearing != null || pitch != null) {
    camera.push(formatCoordinate(clamp(bearing ?? 0, 0, 360)));
    camera.push(formatCoordinate(clamp(pitch ?? 0, 0, 85)));
  }
  const center = camera.join(",");
  const overlay = marker ? `pin-s+0f766e(${formatCoordinate(lng)},${formatCoordinate(lat)})/` : "";

  return `https://api.mapbox.com/styles/v1/${stylePath}/static/${overlay}${center}/${safeWidth}x${safeHeight}@2x?access_token=${encodeURIComponent(
    token,
  )}`;
}

export function mapboxMapUrl(lat: number, lng: number) {
  return mapboxStaticImageUrl({
    lat,
    lng,
    zoom: 15,
    width: 1280,
    height: 720,
  });
}

export function mapboxNeighborhood3dUrl(lat: number, lng: number) {
  return mapboxStaticImageUrl({
    lat,
    lng,
    zoom: 18,
    bearing: 20,
    pitch: 72,
    width: 1280,
    height: 720,
    style: MAPBOX_STATIC_STREETS_STYLE,
  });
}

/** @deprecated Kept for stored report compatibility. */
export const mapboxStreetLevelUrl = mapboxNeighborhood3dUrl;

export function mapboxAerial3dUrl(lat: number, lng: number) {
  return mapboxStaticImageUrl({
    lat,
    lng,
    zoom: 17.2,
    bearing: 36,
    pitch: 68,
    width: 1280,
    height: 720,
    style: MAPBOX_STATIC_SATELLITE_STYLE,
  });
}

export function mapboxSatelliteImageUrl({
  lat,
  lng,
  zoom = 17,
  width = DEFAULT_STATIC_IMAGE_SIZE.width,
  height = DEFAULT_STATIC_IMAGE_SIZE.height,
  marker = true,
}: {
  lat: number;
  lng: number;
  zoom?: number;
  width?: number;
  height?: number;
  marker?: boolean;
}) {
  return mapboxStaticImageUrl({
    lat,
    lng,
    zoom,
    width,
    height,
    marker,
    style: MAPBOX_STATIC_SATELLITE_STYLE,
  });
}

export function normalizeMapboxStyle(style: string) {
  const withoutProtocol = style
    .replace(/^mapbox:\/\/styles\//, "")
    .replace(/^https:\/\/api\.mapbox\.com\/styles\/v1\//, "")
    .replace(/\/static\/.*$/, "")
    .replace(/\/tiles\/.*$/, "")
    .replace(/^\//, "")
    .replace(/\/draft$/, "");

  const parts = withoutProtocol.split("/").filter(Boolean);
  if (parts.length < 2) return DEFAULT_MAPBOX_STYLE;
  return `${parts[0]}/${parts[1]}`;
}

function formatCoordinate(value: number) {
  return Number(value.toFixed(6));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

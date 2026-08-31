function normalizeApiBaseUrl(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return "";

  const parsed = new URL(trimmed);
  const localDevelopmentOrigin = import.meta.env.DEV &&
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !localDevelopmentOrigin) {
    throw new Error("VITE_API_BASE_URL must use HTTPS outside local development.");
  }
  if (
    parsed.username || parsed.password || parsed.pathname !== "/" ||
    parsed.search || parsed.hash
  ) {
    throw new Error("VITE_API_BASE_URL must be an origin without a path, credentials, query, or hash.");
  }
  return parsed.origin;
}

const apiBaseUrl = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);

export function apiUrl(path: string) {
  if (!path.startsWith("/")) throw new Error("API paths must start with a slash.");
  return `${apiBaseUrl}${path}`;
}

export function apiFetch(path: string, init?: RequestInit) {
  return fetch(apiUrl(path), init);
}

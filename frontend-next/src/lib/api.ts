const LOCAL_API_FALLBACK = "http://localhost:8000/api";

function normalizeHttpUrl(rawUrl: string): string {
    let url = rawUrl.trim().replace(/\/+$/, "");

    // Accept values like "my-backend.up.railway.app" by prefixing https.
    if (!/^https?:\/\//i.test(url)) {
        url = `https://${url}`;
    }

    return url;
}

function ensureApiSuffix(url: string): string {
    return /\/api$/i.test(url) ? url : `${url}/api`;
}

export function getApiBaseUrl(): string {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL;
    if (apiUrl?.trim()) {
        return ensureApiSuffix(normalizeHttpUrl(apiUrl));
    }

    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
    if (backendUrl?.trim()) {
        return ensureApiSuffix(normalizeHttpUrl(backendUrl));
    }

    return LOCAL_API_FALLBACK;
}

// export function getBackendBaseUrl(): string {
//     const apiBase = getApiBaseUrl();
//     return apiBase.replace(/\/api$/i, "");
// }
export function getBackendBaseUrl() {
  return "http://172.16.16.166:8001";  // your laptop's IP
}
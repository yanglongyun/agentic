const pathname = typeof window === "undefined" ? "" : window.location.pathname;
const match = pathname.match(/^\/remote\/([a-f0-9-]{36})(?:\/|$)/);
export const remoteRoot = match ? `/remote/${match[1]}` : "";
export function apiPath(path: string) {
  return remoteRoot + path;
}
export function imagePath(path: string, sessionId: string) {
  if (remoteRoot && path.startsWith("/api/images/")) {
    return `${remoteRoot}/api/sessions/${sessionId}/images/${path.slice("/api/images/".length)}`;
  }
  return path;
}

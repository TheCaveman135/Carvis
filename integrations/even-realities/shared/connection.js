/** Shared by Carvis, both companion builds, and the package builder. */
export function parseCarvisUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("Enter your full Carvis address, including http:// or https://.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Use an HTTP or HTTPS Carvis address.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Carvis URL must not contain credentials, query parameters, or a fragment.");
  }
  return url;
}

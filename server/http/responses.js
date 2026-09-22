import { timingSafeEqual } from "node:crypto";

export function fail(message, status = 400) {
  return Object.assign(Error(message), { status });
}
export async function body(req, limit = 128000) {
  if (!String(req.headers["content-type"] || "").startsWith("application/json"))
    throw fail("Send JSON content.", 415);
  let count = 0;
  const parts = [];
  for await (const part of req) {
    count += part.length;
    if (count > limit) throw fail("Request is too large.", 413);
    parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error();
    return value;
  } catch {
    throw fail("Invalid JSON request.");
  }
}
export function sameSecret(a, b) {
  const aa = Buffer.from(a || ""),
    bb = Buffer.from(b || "");
  return !!aa.length && aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(value));
  return true;
}
export function publicModel(m) {
  return {
    provider: m.provider,
    baseUrl: m.baseUrl,
    model: m.model,
    hasApiKey: !!m.apiKey,
  };
}

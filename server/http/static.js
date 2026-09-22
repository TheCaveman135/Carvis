import { readFile, stat } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { fail } from "./responses.js";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export async function serveStatic(req, res, path, root) {
  if (req.method !== "GET" && req.method !== "HEAD")
    throw fail("Method not allowed.", 405);
  const file = path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
  const target = resolve(root, "web", file);
  if (!target.startsWith(join(root, "web") + "/"))
    throw fail("Not found.", 404);
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) throw fail("Not found.", 404);
  // Revalidate from the file metadata on every request. No in-memory copy can
  // become stale during development, and unchanged assets need no file read.
  const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}-${info.ctimeMs.toString(16)}"`;
  const matches = String(req.headers["if-none-match"] || "")
    .split(",")
    .some(
      (value) =>
        value.trim() === "*" ||
        value.trim().replace(/^W\//, "") === etag.slice(2),
    );
  const headers = {
    "Content-Type":
      CONTENT_TYPES[extname(target)] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    ETag: etag,
  };
  if (matches) {
    res.writeHead(304, headers);
    return res.end();
  }
  const content = req.method === "HEAD" ? undefined : await readFile(target);
  res.writeHead(200, headers);
  res.end(content);
}

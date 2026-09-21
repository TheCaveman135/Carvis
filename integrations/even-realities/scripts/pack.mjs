import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

// Even Hub requires the actual server origin in the package network whitelist.
// This generated manifest is local-only; the public source never contains it.
const address = process.env.CARVIS_PUBLIC_URL;
if (!address)
  throw new Error(
    "Set CARVIS_PUBLIC_URL to your public HTTPS Carvis address before packing.",
  );
const url = new URL(address);
if (
  url.protocol !== "https:" ||
  url.username ||
  url.password ||
  url.search ||
  url.hash
)
  throw new Error(
    "CARVIS_PUBLIC_URL must be an HTTPS address without credentials or query parameters.",
  );
const manifest = JSON.parse(await readFile("app.json", "utf8"));
manifest.permissions.find(
  (permission) => permission.name === "network",
).whitelist = [url.origin];
await writeFile("app.local.json", `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o600,
});
const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "--no-install",
    "evenhub",
    "pack",
    "app.local.json",
    "dist",
    "-o",
    "carvis.ehpk",
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);

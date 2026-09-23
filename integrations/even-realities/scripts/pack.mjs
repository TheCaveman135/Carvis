import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parseCarvisUrl } from "../shared/connection.js";

// Even Hub requires the actual server origin in the package network whitelist.
// This generated manifest is local-only; the public source never contains it.
const basic = process.argv.includes("--basic");
const address = process.env.CARVIS_PUBLIC_URL;
if (!address)
  throw new Error(
    "Set CARVIS_PUBLIC_URL to your HTTP or HTTPS Carvis address before packing.",
  );
const addresses = [address, ...(process.env.CARVIS_ADDITIONAL_URLS || "").split(",").filter(value => value.trim())];
const origins = [...new Set(addresses.map(value => parseCarvisUrl(value).origin))];
const manifest = JSON.parse(await readFile("app.json", "utf8"));
manifest.permissions.find(
  (permission) => permission.name === "network",
).whitelist = origins;
if (basic) { manifest.package_id = "app.carvis.basic"; manifest.name = "Carvis Basic"; manifest.entrypoint = "basic.html"; }
const manifestPath = basic ? "app.basic.local.json" : "app.local.json";
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o600,
});
const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "--no-install",
    "evenhub",
    "pack",
    manifestPath,
    basic ? "dist-basic" : "dist",
    "-o",
    basic ? "carvis-basic.ehpk" : "carvis.ehpk",
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);

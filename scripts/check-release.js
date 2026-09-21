import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
const root = process.cwd();
const ignored = new Set([
  ".git",
  "node_modules",
  ".carvis",
  "dist",
  "coverage",
  "output",
  "test-results",
  "playwright-report",
  ".playwright-cli",
]);
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    ignored.has(e.name)
      ? []
      : e.isDirectory()
        ? walk(join(dir, e.name))
        : [relative(root, join(dir, e.name))],
  );
}
let files;
try {
  files = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .split("\0")
    .filter(Boolean);
  if (!files.length) files = walk(root);
} catch {
  files = walk(root);
}
const errors = [];
const forbidden =
  /(^|\/)(?:\.env(?:\..*)?|config\.json|conversation\.json|patterns\.json|\.carvis|logs|backups|node_modules)(?:\/|$)|\.(?:ehpk|sqlite|db|enc|log)$/;
const secretPatterns = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/,
  /\bgh[pousr]_[A-Za-z0-9]{25,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{25,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
];
for (const file of files) {
  if (file !== ".env.example" && forbidden.test(file)) {
    errors.push(`${file}: private/runtime file`);
    continue;
  }
  const path = join(root, file);
  if (statSync(path).size > 3_000_000) {
    errors.push(`${file}: unexpected large release file`);
    continue;
  }
  if (
    file !== ".env.example" &&
    !/\.(js|mjs|cjs|ts|json|md|html|css|yml|yaml|sh|txt)$/.test(file)
  )
    continue;
  const content = readFileSync(path, "utf8");
  for (const pattern of secretPatterns)
    if (pattern.test(content)) errors.push(`${file}: possible credential`);
  if (/\/Users\/[^/\s]+\//.test(content))
    errors.push(`${file}: developer-specific absolute path`);
}
const manifest = JSON.parse(
  readFileSync("integrations/even-realities/app.json", "utf8"),
);
if (
  manifest.permissions?.some((p) =>
    p.whitelist?.some((url) => !url.includes("example")),
  )
)
  errors.push(
    "Companion manifest must not contain a configured personal server.",
  );
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Release hygiene passed: ${files.length} files checked. No private runtime files or common credential patterns found.`,
  );

// Runs after each app's `next build` (its `postbuild` script).
//
// `output: "standalone"` (next.config.ts) builds a self-contained server at
// .next/standalone/apps/<app>/server.js, but leaves out public/ and
// .next/static, which `next start` would normally serve. Hostinger starts
// that server.js directly and only lets you pick a package.json script as the
// build command, so the copy has to happen inside the build itself.
import { cpSync, existsSync } from "node:fs";
import path from "node:path";

const appDir = process.cwd();
const repoRoot = path.resolve(import.meta.dirname, "..");
const target = path.join(appDir, ".next", "standalone", path.relative(repoRoot, appDir));

if (!existsSync(target)) {
  console.warn(`[standalone-assets] ${target} not found, skipping`);
  process.exit(0);
}

for (const dir of ["public", path.join(".next", "static")]) {
  const from = path.join(appDir, dir);
  if (existsSync(from)) cpSync(from, path.join(target, dir), { recursive: true });
}
console.log(`[standalone-assets] copied public/ and .next/static into ${path.relative(appDir, target)}`);

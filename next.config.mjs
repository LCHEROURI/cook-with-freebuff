import { fileURLToPath } from 'url';
import path from 'path';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build-time commit SHA: inlined into the client bundle + available server-side
// so a deployed build can prove exactly which commit it serves on Firebase App
// Hosting without relying on a host-specific API. Resolution order:
//   1. COMMIT_SHA (Firebase App Hosting, GitHub-connected backends)
//   2. commit-sha.txt (written by scripts/write-commit.mjs before the CI
//      `firebase deploy` — the source ZIP excludes .git, so git can't help)
//   3. git rev-parse HEAD (local dev)
function resolveCommitSha() {
  if (process.env.COMMIT_SHA) return process.env.COMMIT_SHA;
  try {
    const stamped = readFileSync(path.join(__dirname, 'commit-sha.txt'), 'utf8').trim();
    if (stamped) return stamped;
  } catch { /* not stamped */ }
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const commitSha = resolveCommitSha();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: __dirname,
  env: {
    // Inlined at build time — never a runtime secret.
    NEXT_PUBLIC_APP_COMMIT_SHA: commitSha,
    NEXT_PUBLIC_APP_BUILT_AT: new Date().toISOString(),
  },
};

export default nextConfig;

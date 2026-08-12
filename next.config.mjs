import { fileURLToPath } from 'url';
import path from 'path';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build-time commit SHA: inlined into the client bundle + available server-side
// so a deployed build can prove exactly which commit it serves — on Vercel,
// Firebase App Hosting, or any other host — without relying on a host-specific
// API. `VERCEL_GIT_COMMIT_SHA` is honored when the Vercel system sets it;
// otherwise the SHA is read from git at build time (the App Hosting path).
function resolveCommitSha() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  if (process.env.COMMIT_SHA) return process.env.COMMIT_SHA;
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

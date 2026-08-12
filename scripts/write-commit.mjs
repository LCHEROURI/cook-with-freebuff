#!/usr/bin/env node
// ============================================================================
// scripts/write-commit.mjs — stamp the current git commit into `.commit-sha`
// before `firebase deploy --only apphosting`.
//
// Firebase App Hosting builds from a source ZIP that EXCLUDES `.git`, so the
// build's `git rev-parse HEAD` returns nothing. This predeploy step writes the
// SHA to a tiny file that IS included in the upload, and next.config.mjs reads
// it as a fallback — so /api/build-info can report the real commit on App
// Hosting exactly like it does on Vercel.
// ============================================================================

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sha = process.env.COMMIT_SHA || (() => {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
})();

if (!sha) {
  console.error('✗ could not resolve the current commit (git rev-parse HEAD failed and COMMIT_SHA is unset)');
  process.exit(1);
}

writeFileSync(resolve(import.meta.dirname, '..', 'commit-sha.txt'), sha);
console.log(`✓ wrote commit-sha.txt = ${sha}`);

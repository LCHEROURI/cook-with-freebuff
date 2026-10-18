import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  Config,
  JdkHelper,
  KeyTool,
  AndroidSdkTools,
  GradleWrapper,
  JarSigner,
  ConsoleLog,
} from '@bubblewrap/core';

const targetDirectory = resolve(process.cwd(), 'twa');
const configPath = join(homedir(), '.bubblewrap', 'config.json');
const config = await Config.loadConfig(configPath);
if (!config) {
  console.error('✗ FAIL: Could not load bubblewrap config from ~/.bubblewrap/config.json');
  process.exit(1);
}

const jdkHelper = new JdkHelper(process, config);
const keytool = new KeyTool(jdkHelper);
const keystorePath = join(targetDirectory, 'android.keystore');
const alias = 'cookwithme';

// Signing passwords must be provided via environment variables (fail closed)
const envPass = process.env.BUBBLEWRAP_KEYSTORE_PASSWORD;
const envKeyPass = process.env.BUBBLEWRAP_KEY_PASSWORD || envPass;

if (!envPass) {
  console.error(
    '✗ FAIL: BUBBLEWRAP_KEYSTORE_PASSWORD environment variable is required to access or sign with the release keystore.\n' +
    'Usage: BUBBLEWRAP_KEYSTORE_PASSWORD="<password>" npm run build:twa'
  );
  process.exit(1);
}

// Refuse to silently replace a missing release keystore unless explicit --init-keystore flag is provided
const allowInit = process.argv.includes('--init-keystore');
if (!existsSync(keystorePath)) {
  if (!allowInit) {
    console.error(
      `✗ FAIL: Release keystore not found at ${keystorePath}.\n` +
      'To prevent unintentional certificate replacement and Google Play rejection, existing release keystores must be restored.\n' +
      'For first-time key generation only, pass the explicit --init-keystore flag:\n' +
      '  BUBBLEWRAP_KEYSTORE_PASSWORD="..." node scripts/build-twa-bundle.mjs --init-keystore'
    );
    process.exit(1);
  }
  console.log('Creating initial signing key at', keystorePath);
  await keytool.createSigningKey({
    fullName: 'Cook With Me',
    organizationalUnit: 'Mobile',
    organization: 'Cook With Me',
    country: 'US',
    password: envPass,
    keypassword: envKeyPass,
    alias,
    path: keystorePath,
  });
  console.log('✓ Release keystore initialized');
} else {
  console.log('✓ Release keystore found at', keystorePath);
}

// Extract SHA-256 fingerprint from keystore
const rawList = await keytool.list({
  path: keystorePath,
  alias,
  password: envPass,
  keypassword: envKeyPass,
});

const sha256Match = rawList.match(/SHA256:\s*([A-F0-9:]+)/i);
if (!sha256Match) {
  console.error('✗ FAIL: Could not extract SHA256 fingerprint from keytool output');
  process.exit(1);
}
const uploadFingerprint = sha256Match[1].trim().toUpperCase();
console.log('✓ Extracted SHA-256 upload certificate fingerprint:');
console.log(`  ${uploadFingerprint}`);

// Digital Asset Links: preserve Google Play Console app-signing key and include local upload key
const assetlinksPath = resolve(process.cwd(), 'public/.well-known/assetlinks.json');
let existingFingerprints = [];
if (existsSync(assetlinksPath)) {
  try {
    const existing = JSON.parse(readFileSync(assetlinksPath, 'utf8'));
    const entry = existing.find((e) => e.target?.package_name === 'com.freebuff.cookwithme');
    if (entry?.target?.sha256_cert_fingerprints) {
      existingFingerprints = entry.target.sha256_cert_fingerprints;
    }
  } catch (err) {
    console.warn('Could not parse existing assetlinks.json:', err);
  }
}

// Default Google Play Console App Signing Certificate (separate from upload key)
const playAppSigningKey = 'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C';
const combinedFingerprints = Array.from(
  new Set([
    ...existingFingerprints,
    playAppSigningKey,
    uploadFingerprint,
  ])
);

const assetlinks = [
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'com.freebuff.cookwithme',
      sha256_cert_fingerprints: combinedFingerprints,
    },
  },
];
writeFileSync(assetlinksPath, JSON.stringify(assetlinks, null, 2) + '\n');
console.log('✓ Updated public/.well-known/assetlinks.json (preserved Play signing & upload fingerprints)');

// Update app/.well-known/assetlinks.json/route.ts default fallback fingerprints
const routePath = resolve(process.cwd(), 'app/.well-known/assetlinks.json/route.ts');
if (existsSync(routePath)) {
  let routeContent = readFileSync(routePath, 'utf8');
  const formattedFingerprints = combinedFingerprints
    .map((fp) => `      '${fp}',`)
    .join('\n');
  const targetRegex = /fingerprints\s*=\s*\[\s*\/\/[^\n]*\n([\s\S]*?)\];/;
  if (targetRegex.test(routeContent)) {
    routeContent = routeContent.replace(
      targetRegex,
      `fingerprints = [\n      // Play Console app-signing key and upload key\n${formattedFingerprints}\n    ];`
    );
    writeFileSync(routePath, routeContent);
    console.log('✓ Updated app/.well-known/assetlinks.json/route.ts default fingerprints');
  }
}

// Build the release bundle using Gradle
console.log('\nBuilding Android App Bundle (AAB)...');
const androidSdkTools = await AndroidSdkTools.create(process, config, jdkHelper, new ConsoleLog('sdk-tools'));
const gradle = new GradleWrapper(process, androidSdkTools, targetDirectory);
console.log('Running gradle bundleRelease...');
await gradle.bundleRelease();
console.log('✓ gradle bundleRelease completed');

// Sign the App Bundle using JarSigner
const jarSigner = new JarSigner(jdkHelper);
const unsignedBundle = join(targetDirectory, 'app/build/outputs/bundle/release/app-release.aab');
const signedBundle = join(targetDirectory, 'app-release-bundle.aab');

console.log('Signing App Bundle with JarSigner...');
await jarSigner.sign(
  { path: keystorePath, alias },
  `"${envPass}"`,
  `"${envKeyPass}"`,
  unsignedBundle,
  signedBundle
);

if (existsSync(signedBundle)) {
  const stat = (await import('node:fs')).statSync(signedBundle);
  console.log(`✓ Successfully generated signed App Bundle: ${signedBundle} (${Math.round(stat.size / 1024)} KB)`);
} else {
  console.error('✗ FAIL: Signed bundle was not created');
  process.exit(1);
}

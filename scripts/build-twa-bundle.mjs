import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const core = require('/Users/laredjchehrouri/.npm/_npx/881cef4662d2c421/node_modules/@bubblewrap/core');
const { Config, JdkHelper, KeyTool, AndroidSdkTools, GradleWrapper, JarSigner, ConsoleLog } = core;

const targetDirectory = resolve(process.cwd(), 'twa');
const configPath = join(homedir(), '.bubblewrap', 'config.json');
const config = await Config.loadConfig(configPath);
if (!config) {
  console.error('✗ FAIL: Could not load bubblewrap config');
  process.exit(1);
}

const jdkHelper = new JdkHelper(process, config);
const keytool = new KeyTool(jdkHelper);
const keystorePath = join(targetDirectory, 'android.keystore');
const alias = 'cookwithme';

// Deterministic or env-based password for signing
const envPass = process.env.BUBBLEWRAP_KEYSTORE_PASSWORD || 'cookwithme-twa-key-2026';
const envKeyPass = process.env.BUBBLEWRAP_KEY_PASSWORD || envPass;

if (!existsSync(keystorePath)) {
  console.log('Creating signing key at', keystorePath);
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
  console.log('✓ Release keystore created');
} else {
  console.log('✓ Keystore already exists at', keystorePath);
}

// Extract SHA-256 fingerprint
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
const fingerprint = sha256Match[1].trim().toUpperCase();
console.log('✓ Extracted SHA-256 certificate fingerprint:');
console.log(`  ${fingerprint}`);

// Update public/.well-known/assetlinks.json
const assetlinksPath = resolve(process.cwd(), 'public/.well-known/assetlinks.json');
const assetlinks = [
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'com.freebuff.cookwithme',
      sha256_cert_fingerprints: [fingerprint],
    },
  },
];
writeFileSync(assetlinksPath, JSON.stringify(assetlinks, null, 2) + '\n');
console.log('✓ Updated public/.well-known/assetlinks.json');

// Update app/.well-known/assetlinks.json/route.ts fallback fingerprint
const routePath = resolve(process.cwd(), 'app/.well-known/assetlinks.json/route.ts');
if (existsSync(routePath)) {
  let routeContent = readFileSync(routePath, 'utf8');
  routeContent = routeContent.replace(
    /'[0-9A-Fa-f:]{95}'/,
    `'${fingerprint}'`
  );
  writeFileSync(routePath, routeContent);
  console.log('✓ Updated app/.well-known/assetlinks.json/route.ts default fingerprint');
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

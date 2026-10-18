import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { TwaManifest, TwaGenerator, Config, JdkHelper, KeyTool, ConsoleLog } from '@bubblewrap/core';

const targetDirectory = resolve(process.cwd(), 'twa');
mkdirSync(targetDirectory, { recursive: true });

// Load bubblewrap config
const configPath = join(homedir(), '.bubblewrap', 'config.json');
const config = await Config.loadConfig(configPath);
if (!config) {
  console.error('✗ FAIL: Could not load bubblewrap config from ~/.bubblewrap/config.json');
  process.exit(1);
}
console.log('✓ Loaded bubblewrap config:', config);

const twaManifestJson = {
  packageId: 'com.freebuff.cookwithme',
  host: 'cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app',
  name: 'Cook With Me — Kitchen Agent',
  launcherName: 'Cook With Me',
  display: 'standalone',
  themeColor: '#6B9FD4',
  navigationColor: '#FCF8EC',
  backgroundColor: '#FCF8EC',
  enableNotifications: true,
  startUrl: '/cook',
  iconUrl: 'https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app/icon-512.png',
  maskableIconUrl: 'https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app/icon-maskable-512.png',
  splashScreenFadeOutDuration: 300,
  signingKey: {
    path: './android.keystore',
    alias: 'cookwithme',
  },
  appVersionCode: 1,
  appVersion: '1.0.0',
  shortcuts: [],
  generatorApp: 'bubblewrap-cli',
  webManifestUrl: 'https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app/manifest.json',
  fallbackType: 'customtabs',
  features: {
    playBilling: {
      enabled: true,
    },
  },
  alphaDependencies: {
    enabled: false,
  },
  enableSiteSettingsShortcut: true,
  isChromeOSOnly: false,
  isMetaQuest: false,
  minSdkVersion: 24,
};

const twaManifest = new TwaManifest(twaManifestJson);
const validationError = twaManifest.validate();
if (validationError) {
  console.error('✗ FAIL: TwaManifest validation failed:', validationError);
  process.exit(1);
}
console.log('✓ TwaManifest is valid');

await twaManifest.saveToFile(join(targetDirectory, 'twa-manifest.json'));
console.log('✓ Saved twa/twa-manifest.json');

const log = new ConsoleLog('twa-generator');
const twaGenerator = new TwaGenerator();
console.log('Generating TWA project in twa/...');
await twaGenerator.createTwaProject(targetDirectory, twaManifest, log, (current, total) => {
  if (current === total || current % 5 === 0) {
    console.log(`  Generation progress: ${Math.round((current / total) * 100)}%`);
  }
});
console.log('✓ TWA project created successfully');

// Generate checksum file
const crypto = await import('node:crypto');
const manifestContents = readFileSync(join(targetDirectory, 'twa-manifest.json'));
const checksum = crypto.createHash('sha1').update(manifestContents).digest('hex');
writeFileSync(join(targetDirectory, 'manifest-checksum.txt'), checksum);
console.log('✓ Saved twa/manifest-checksum.txt');

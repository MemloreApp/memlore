import type { ExpoConfig } from 'expo/config';

// The single app config (the template's app.json is folded in here).
// Store compliance: docs/mobile/adr-0001-mobile-architecture.md, section 7.

// Spike 17.1 (iCloud folder access, `app/(dev)/spike-icloud.tsx`) only in a
// build made with MEMLORE_SPIKE_ICLOUD=1, on both `expo prebuild` and
// `expo run:ios`: the iCloud entitlements and the background-processing task.
// Without it the default and Release builds keep no iCloud signing requirement
// and no extra background mode for App Review.
const spikeICloud = process.env.MEMLORE_SPIKE_ICLOUD === '1';
const spikeICloudIos = spikeICloud
  ? {
      entitlements: {
        'com.apple.developer.icloud-container-identifiers': ['iCloud.app.memlore'],
        'com.apple.developer.ubiquity-container-identifiers': ['iCloud.app.memlore'],
        'com.apple.developer.icloud-services': ['CloudDocuments'],
      },
      infoPlist: {
        UIBackgroundModes: ['processing'],
        BGTaskSchedulerPermittedIdentifiers: ['app.memlore.mobile.spike-icloud'],
      },
    }
  : {};

// Spike 17.2 (Google OAuth, `app/(dev)/spike-oauth.tsx`). The iOS OAuth client
// ID comes from MEMLORE_GOOGLE_IOS_CLIENT_ID in `mobile/.env.local` (gitignored)
// and is never written in a tracked file. Its reversed form is the redirect URL
// scheme. `ios.scheme` merges into the same CFBundleURLTypes entry as `scheme`;
// setting `ios.infoPlist.CFBundleURLTypes` instead would make Expo drop
// `memlore` and `app.memlore.mobile`. Without the variable: no scheme, no extra.
const googleIosClientMatch = /^([a-z0-9-]+)\.apps\.googleusercontent\.com$/i.exec(
  process.env.MEMLORE_GOOGLE_IOS_CLIENT_ID ?? '',
);
const googleIosClientId = googleIosClientMatch?.[0];
const googleIosScheme = googleIosClientMatch
  ? `com.googleusercontent.apps.${googleIosClientMatch[1]}`
  : undefined;

const config: ExpoConfig = {
  name: 'Memlore',
  slug: 'memlore',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme: 'memlore',
  userInterfaceStyle: 'automatic',
  ios: {
    icon: './assets/expo.icon',
    bundleIdentifier: 'app.memlore.mobile',
    // iPad layout is a roadmap item.
    supportsTablet: false,
    // ITSAppUsesNonExemptEncryption=YES: the vault uses AES-256-GCM and Argon2id.
    config: { usesNonExemptEncryption: true },
    // Each reason is backed by evidence in the ADR's "Privacy manifest evidence".
    // No purpose strings yet: each feature plan adds its own.
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyCollectedDataTypes: [],
      NSPrivacyAccessedAPITypes: [
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
          NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
          NSPrivacyAccessedAPITypeReasons: ['C617.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
          NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
          NSPrivacyAccessedAPITypeReasons: ['E174.1'],
        },
      ],
    },
    ...spikeICloudIos,
    ...(googleIosScheme ? { scheme: [googleIosScheme] } : {}),
  },
  android: {
    package: 'app.memlore.mobile',
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    output: 'server',
    favicon: './assets/images/favicon.png',
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      {
        backgroundColor: '#208AEF',
        image: './assets/images/splash-icon.png',
        imageWidth: 76,
      },
    ],
    [
      'expo-build-properties',
      {
        // At or above the SDK 58 floor (ExpoModulesCore requires 16.4); matches
        // IPHONEOS_DEPLOYMENT_TARGET in scripts/mobile-core-ios.sh.
        ios: { deploymentTarget: '17.0' },
        android: { targetSdkVersion: 36, minSdkVersion: 26 },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  ...(googleIosClientId ? { extra: { googleIosClientId } } : {}),
};

export default config;

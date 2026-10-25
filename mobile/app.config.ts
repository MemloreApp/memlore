import type { ExpoConfig } from 'expo/config';

// The single app config (the template's app.json is folded in here).
// Store compliance: docs/mobile/adr-0001-mobile-architecture.md, section 7.
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
};

export default config;

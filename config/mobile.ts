import type { MobileConfig } from '@stacksjs/types/mobile'

const envVars = typeof Bun !== 'undefined' ? Bun.env : process.env
const mobileContent = envVars.MOBILE_E2E === '1'
  ? { webAssets: 'dist' }
  : {
      url: envVars.MOBILE_URL ?? 'https://wildloop.org',
      fallbackWebAssets: 'dist',
    }

export default {
  ios: {
    appName: 'WildLoop',
    bundleId: envVars.IOS_BUNDLE_ID ?? 'org.wildloop.app',
    version: envVars.IOS_APP_VERSION ?? '1.0.0',
    buildNumber: envVars.IOS_BUILD_NUMBER ?? '1',
    deploymentTarget: '16.0',
    watchDeploymentTarget: '9.0',
    teamId: envVars.APPLE_TEAM_ID,
    ...mobileContent,
    trustedOrigins: ['https://wildloop.org'],
    associatedDomains: ['applinks:wildloop.org'],
    appIcon: 'public/images/app/wildloop-app-icon.png',
    backgroundColor: '#003c2f',
    darkMode: true,
    urlSchemes: ['wildloop'],
    orientations: ['portrait'],
    deviceFamilies: ['iphone'],
    privacy: {
      tracking: false,
      collectedDataTypes: [
        {
          type: 'NSPrivacyCollectedDataTypePreciseLocation',
          linked: true,
          tracking: false,
          purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
        {
          type: 'NSPrivacyCollectedDataTypeFitness',
          linked: true,
          tracking: false,
          purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
      ],
      accessedApiTypes: [{
        type: 'NSPrivacyAccessedAPICategoryUserDefaults',
        reasons: ['CA92.1'],
      }],
    },
    capabilities: {
      backgroundLocation: true,
      deepLinks: true,
      fileDownload: true,
      filePicker: true,
      geolocation: true,
      haptics: true,
      healthKit: true,
      keepAwake: true,
      liveActivities: true,
      // Craft currently emits an incomplete WatchKit target graph. Keep the
      // iPhone app installable until craft-native/craft#195 is resolved.
      watchApp: false,
      localDatabase: true,
      orientationLock: true,
      pushNotifications: true,
      secureStorage: true,
      share: true,
    },
  },
  android: {
    appName: 'WildLoop',
    packageName: envVars.ANDROID_PACKAGE_NAME ?? 'org.wildloop.app',
    version: envVars.ANDROID_APP_VERSION ?? envVars.IOS_APP_VERSION ?? '1.0.0',
    versionCode: Number(envVars.ANDROID_VERSION_CODE ?? '1'),
    minSdk: 26,
    targetSdk: 35,
    ...mobileContent,
    trustedOrigins: ['https://wildloop.org'],
    urlSchemes: ['wildloop'],
    appIcon: 'public/images/app/wildloop-app-icon.png',
    googleServicesFile: envVars.ANDROID_GOOGLE_SERVICES_FILE,
    backgroundColor: '#003c2f',
    darkMode: true,
    capabilities: {
      backgroundLocation: true,
      deepLinks: true,
      geolocation: true,
      haptics: true,
      healthConnect: true,
      keepAwake: true,
      // Craft hard-fails Android generation when push is enabled without a
      // google-services.json (packages/android/src/index.ts:371). That file is
      // written by the workflow only when the ANDROID_GOOGLE_SERVICES_JSON
      // secret exists, and it is not configured, so generation died on a
      // credential that is optional for everything else. Gate the capability
      // on the credential actually being present: add the secret and push
      // re-enables itself with no code change.
      pushNotifications: Boolean(envVars.ANDROID_GOOGLE_SERVICES_FILE),
      secureStorage: true,
      share: true,
    },
  },
} satisfies MobileConfig

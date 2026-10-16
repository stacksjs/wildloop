import type { MobileConfig } from '@stacksjs/types/mobile'

const envVars = typeof Bun !== 'undefined' ? Bun.env : process.env
// A free (personal) Apple team cannot sign Associated Domains or Push
// Notifications; Xcode refuses the whole profile. A sideload with one
// (`preview:iphone --personal-team`) leaves both out.
const personalTeam = envVars.IOS_PERSONAL_TEAM === '1'
const mobileContent = envVars.MOBILE_E2E === '1'
  ? { webAssets: 'dist' }
  : {
      url: envVars.MOBILE_URL ?? 'https://wildloop.org',
      fallbackWebAssets: 'dist',
    }

export default {
  ios: {
    appName: 'Wildloop',
    bundleId: envVars.IOS_BUNDLE_ID ?? 'org.wildloop.app',
    version: envVars.IOS_APP_VERSION ?? '1.0.0',
    buildNumber: envVars.IOS_BUILD_NUMBER ?? '1',
    deploymentTarget: '16.0',
    watchDeploymentTarget: '9.0',
    teamId: envVars.APPLE_TEAM_ID,
    ...mobileContent,
    trustedOrigins: ['https://wildloop.org'],
    associatedDomains: personalTeam ? [] : ['applinks:wildloop.org'],
    appIcon: 'public/images/app/wildloop-app-icon.png',
    backgroundColor: '#003c2f',
    darkMode: true,
    urlSchemes: ['wildloop'],

    /**
     * The paths the app renders as native views instead of loading in the web
     * view, one screen per entry (stacksjs/stx#1992).
     *
     * This is the promotion mechanism: a path listed here is drawn from
     * `resources/native/<name>.stx` as real UIViews, and everything not listed
     * stays the website in one warm web view, sharing the same navigation
     * stack. A half-migrated app is the end state rather than a transition, and
     * any line here is reversible by deleting it.
     *
     * The three promoted paths are the ones whose screens need nothing that is
     * missing: no map (craft-native/craft#340), no route thumbnail
     * (craft-native/craft#338), no upload (craft-native/craft#341).
     *
     * `/activity/new` and `/activity/saved` have no web page behind them — the
     * web app logs a manual activity in a modal on the feed. They are listed
     * because the native manual-entry flow pushes `ActivitySaved` by name, and
     * only screens named here are compiled into the bundle. Nothing links to
     * those paths on the web.
     */
    nativeScreens: {
      '/achievements': 'Achievements',
      '/athletes': 'Athletes',
      '/battles': 'Battles',
      '/challenges': 'Challenges',
      '/clubs': 'Clubs',
      '/conquests': 'Conquests',
      '/events': 'Events',
      '/records': 'Records',
      '/search': 'Search',
      '/stats': 'Stats',
      '/territories': 'Territories',
      '/territory/:id': 'TerritoryDetail',
      '/trails': 'Trails',
      '/notifications': 'Notifications',
      '/leaderboard': 'Leaderboard',
      '/activity/new': 'ManualActivity',
      '/activity/saved': 'ActivitySaved',
    },
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
        // What else an account holds, and what AnalyticsHQ counts. Kept in
        // step with the App Store privacy answers: App Review compares the
        // two, and a manifest that lists less than the labels is a rejection.
        // Heart rate comes in with imported activity files; page views are
        // counted without an account attached, so they are not linked.
        {
          type: 'NSPrivacyCollectedDataTypeHealth',
          linked: true,
          tracking: false,
          purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
        {
          type: 'NSPrivacyCollectedDataTypeName',
          linked: true,
          tracking: false,
          purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
        {
          type: 'NSPrivacyCollectedDataTypeEmailAddress',
          linked: true,
          tracking: false,
          purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
        {
          type: 'NSPrivacyCollectedDataTypeUserID',
          linked: true,
          tracking: false,
          purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
        {
          type: 'NSPrivacyCollectedDataTypePhotosorVideos',
          linked: true,
          tracking: false,
          purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
        {
          type: 'NSPrivacyCollectedDataTypeOtherUserContent',
          linked: true,
          tracking: false,
          purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
        {
          type: 'NSPrivacyCollectedDataTypeProductInteraction',
          linked: false,
          tracking: false,
          purposes: ['NSPrivacyCollectedDataTypePurposeAnalytics'],
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
      // craft-native/craft#195 shipped in 0.0.92, but embedding the Watch app
      // makes every iPhone simulator build require the watchOS simulator
      // runtime, which this machine and CI do not install yet.
      watchApp: false,
      localDatabase: true,
      // The evening-before reminder for a planned trip, scheduled on the
      // device so it rings with no signal (useTripPlans).
      localNotifications: true,
      orientationLock: true,
      pushNotifications: !personalTeam,
      secureStorage: true,
      share: true,
    },
  },
  android: {
    appName: 'Wildloop',
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
      localNotifications: true,
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

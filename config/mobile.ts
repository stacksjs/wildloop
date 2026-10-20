import type { MobileConfig } from '@stacksjs/types/mobile'
import { APP_SHORTCUTS, appShortcutDeepLink } from '../resources/functions/app-shortcuts'
import spotlight from './spotlight'

const envVars = typeof Bun !== 'undefined' ? Bun.env : process.env
// A free (personal) Apple team cannot sign Associated Domains or Push
// Notifications; Xcode refuses the whole profile. A sideload with one
// (`preview:iphone --personal-team`) leaves both out.
const personalTeam = envVars.IOS_PERSONAL_TEAM === '1'
const mobileContent = {
  renderer: 'native' as const,
  nativeApp: 'resources/mobile-app.ts',
  url: envVars.MOBILE_URL ?? 'https://wildloop.org/feed',
  appearance: 'system' as const,
  backgroundColor: '#f2f4ef',
  backgroundColorDark: '#101c16',
  tabs: [
    { id: '/feed', title: 'Feed', symbol: 'house' },
    { id: '/record', title: 'Record', symbol: 'record.circle' },
    { id: '/menu', title: 'Menu', symbol: 'square.grid.2x2' },
  ],
}
const nativeScreens = {
  '/': 'Feed', '/feed': 'Feed', '/menu': 'Menu', '/profile': 'Profile',
  '/settings': 'Settings', '/login': 'Login', '/register': 'Register', '/forgot-password': 'ForgotPassword', '/reset-password': 'ResetPassword', '/password/reset/:token': 'ResetPassword',
  '/activity/:id': 'ActivityDetail', '/record': 'Record', '/plans': 'Plans', '/routes': 'Routes',
  '/achievements': 'Achievements', '/athlete/:id': 'AthleteDetail', '/athletes': 'Athletes',
  '/battles': 'Battles', '/challenges': 'Challenges', '/club/:id': 'ClubDetail', '/clubs': 'Clubs',
  '/conquests': 'Conquests', '/effort/:id': 'EffortDetail', '/event/:id': 'EventDetail', '/events': 'Events',
  '/records': 'Records', '/search': 'Search', '/stats': 'Stats', '/territories': 'Territories',
  '/territory/:id': 'TerritoryDetail', '/trails': 'Trails', '/trail/:id': 'TrailDetail', '/trail/:id/map': 'TrailMap',
  '/notifications': 'Notifications', '/leaderboard': 'Leaderboard',
  '/activity/new': 'ManualActivity', '/activity/saved': 'ActivitySaved',
}

export default {
  spotlight,
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
    urlSchemes: ['wildloop'],
    appShortcuts: APP_SHORTCUTS.map(shortcut => ({ id:shortcut.id,title:shortcut.title,subtitle:shortcut.subtitle,symbol:shortcut.symbol,url:appShortcutDeepLink(shortcut),phrases:[shortcut.phrase.replace('Wildloop','{app}')] })),

    // Every app destination uses the same Craft screen registry on both platforms.
    // Legal pages and external services open in the platform browser.
    nativeScreens,
    // The screens' JavaScript runs on a thread of its own, not the main
    // thread, so a sign-in - which every open screen answers by checking the
    // account again and reloading - never holds UIKit. On main, one CI run
    // froze the app for 16 seconds after the Log in tap.
    nativeScriptThread: 'background' as const,
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
    mapsApiKey: envVars.ANDROID_MAPS_API_KEY,
    nativeScreens,
    capabilities: {
      backgroundLocation: true,
      deepLinks: true,
      geolocation: true,
      haptics: true,
      healthConnect: true,
      localDatabase: true,
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

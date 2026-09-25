export interface CommandConfig {
  /** The command file name (without .ts extension) */
  file: string
  /** Whether the command is enabled */
  enabled?: boolean
  /** Command aliases */
  aliases?: string[]
}

export type CommandRegistry = Record<string, string | CommandConfig>

/**
 * The application's command registry.
 *
 * Commands listed here will be auto-loaded by the CLI.
 * You can use a simple string (file name) or a config object for more control.
 *
 * @example
 * // Simple registration
 * 'inspire': 'Inspire',
 *
 * // With config
 * 'send-emails': {
 *   file: 'SendEmails',
 *   enabled: true,
 *   aliases: ['emails', 'mail'],
 * },
 */
export default {
  // `ingest:trails` is registered as a command-level alias inside the command
  // file itself. The registry's own `aliases` key is not used: the loader in
  // @stacksjs/buddy 0.70.207 applies it with `cli.alias()`, which does not
  // exist, so any registry alias makes the whole command fail to load. Fixed
  // upstream in 0.70.279 (`applyAliases`); move them here after that upgrade.
  'trails:ingest': {
    file: 'IngestTrails',
    enabled: true,
  },
  'trails:repair-distances': {
    file: 'RepairTrailDistances',
    enabled: true,
  },
  'trails:requeue': {
    file: 'RequeueTrailShards',
    enabled: true,
  },
  'territory:ranks': {
    file: 'ComputeTerritoryRanks',
    enabled: true,
  },
  'territory:decay': {
    file: 'DecayTerritories',
    enabled: true,
  },
  'counters:recompute': {
    file: 'RecomputeCounters',
    enabled: true,
  },
  'geo:import': {
    file: 'ImportGazetteer',
    enabled: true,
  },
  'plans:remind': {
    file: 'RemindTripPlans',
    enabled: true,
  },
  // Physical-iPhone build and preview. Buddy supplies build:android,
  // build:ios, and build:mobile itself; these two drive repo-local scripts
  // that have no upstream equivalent.
  'build:iphone': {
    file: 'Mobile',
    enabled: true,
  },
} satisfies CommandRegistry

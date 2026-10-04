/**
 * **Device search (iOS Spotlight, Siri suggestions)**
 *
 * What of the app's own content a device may index, so somebody searching
 * their home screen finds a trail, a club or an event rather than only
 * finding the app.
 *
 * Each kind is donated as an `NSUserActivity` through Craft's `siri` bridge,
 * and iOS hands a tapped activity back only for an activity type the build
 * declares in `Info.plist` — a list fixed at build time. A type per record id
 * would be unbounded and undeclarable, so each kind gets a fixed number of
 * slots, and each slot holds whichever record is currently in it. The oldest
 * donation makes room for the next.
 *
 * That is the whole reason `slots` is a number here rather than "index
 * everything": it is a budget. Every slot is one line in the generated
 * `Info.plist` (see scripts/generate-ios-shortcuts.ts), and raising it is the
 * only way to widen the index.
 *
 * Adding a kind takes an entry below and nothing else: the plist declarations,
 * the storage, the eviction and the route a tapped entry opens are all derived
 * from this. See resources/functions/spotlight.ts for the engine and
 * resources/composables/useSpotlightIndex.ts for the calls a page makes.
 */

/**
 * The shape the engine reads.
 *
 * Declared here rather than imported, so the file that gets edited is the file
 * that gets checked — the engine imports this config, and importing its types
 * back would be a cycle. The engine validates these values again at runtime
 * (`readSpotlightKinds`), which is what catches a kind this build cannot
 * carry; the types below are what catches a typo while it is being written.
 */
interface SpotlightSettings {
  /** Index content on the device at all. */
  enabled: boolean
  kinds: Record<string, {
    /**
     * How many of this kind the device holds at once: 1 to 64.
     *
     * A budget, not a guess. Every slot is one line in the generated
     * Info.plist and one possible donation at launch.
     */
    slots: number
    /** Where a tapped entry opens. Starts with "/" and carries ":id". */
    route: string
    /** Names an entry whose record arrived without a name of its own. */
    noun: string
  }>
}

export default {
  /**
   * Index content on the device at all.
   *
   * False donates nothing, declares no activity types, and leaves every call
   * a no-op — the switch to throw if a device index ever has to be withdrawn
   * without unpicking the call sites.
   */
  enabled: true,

  /**
   * The kinds, keyed by the name their slots are donated under: `trail` gives
   * `trail-slot-0` and so on. The name is part of a stored identifier and of
   * what iOS has already indexed, so renaming one orphans whatever it donated
   * until the slots are donated over.
   */
  kinds: {
    /**
     * Trails: everything the athlete saved, plus whatever they have opened.
     *
     * The largest budget because it is the largest set — a heavy user's saved
     * list runs to dozens — and because a trail is the thing somebody searches
     * for by name.
     */
    trail: {
      slots: 24,
      /** Where a tapped entry opens. `:id` is the record's id. */
      route: '/trail/:id',
      /** Names an entry whose record arrived without a name of its own. */
      noun: 'Trail',
    },

    /** Clubs: the ones the athlete belongs to, plus any they have opened. */
    club: {
      slots: 8,
      route: '/club/:id',
      noun: 'Club',
    },

    /** Events: the ones the athlete entered, plus any they have opened. */
    event: {
      slots: 8,
      route: '/event/:id',
      noun: 'Event',
    },
  },
} satisfies SpotlightSettings

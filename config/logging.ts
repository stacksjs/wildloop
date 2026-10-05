import type { LoggingConfig } from '@stacksjs/types'
import { bughqTransport } from '@bughq/stacks'
import { install as streamLogsToLogHQ } from '@loghq/stacks'
import { storagePath } from '@stacksjs/path'

/**
 * Whether errors from this process should become issues somebody is emailed about.
 *
 * Not under `bun test`. The `environment` passed to each reporter below labels
 * an event; it does not withhold one, so a test that deliberately throws still
 * filed an issue and mailed the owner. `tests/unit/google-callback.test.ts` injects a
 * UNIQUE violation on `user_identities` to prove the Google callback refuses a
 * sign-in it cannot record — working as intended, and indistinguishable in the
 * inbox from the same constraint failing in production.
 *
 * A suite that pages people is a suite people learn to ignore, and the issue
 * it buries is the real one.
 */
const REPORTS_ISSUES = process.env.APP_ENV !== 'test' && process.env.NODE_ENV !== 'test'

/**
 * Stream this app's log.* calls to loghq.
 *
 * `@loghq/stacks` offers two forms and only one of them attaches here.
 * `loghqTransport()` is the declarative form: it builds a transport and waits
 * for a framework that reads `transports` out of this file — and the installed
 * one does not read it, so the entry sat in the array below shipping nothing
 * for as long as it has been there. `install()` finds the logger's registry
 * itself; it reports seam `transport` via `registerTransport`, `live: true`,
 * and a `log.error` lands at the ingest host (tests/unit/log-reporting.test.ts
 * pins both halves of that against a local sink).
 *
 * Attachment is asynchronous, so anything logged in the first few ticks of a
 * process is not streamed. Awaiting it here would make importing a config file
 * block on the network.
 */
if (REPORTS_ISSUES) {
  streamLogsToLogHQ({
    key: 'loghq_208c4a438f864ead9868ca74a8b1fd46e2093257d820441a90802c5bee49106b',
    environment: process.env.APP_ENV,
    release: process.env.APP_VERSION,
  })
}

/**
 * **Logging Configuration**
 *
 * This configuration defines all of your logging options. Because Stacks is fully-typed, you
 * may hover any of the options below and the definitions will be provided. In case you
 * have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  /**
   * **Log File Path**
   *
   * The path to the log file. This will be used to write logs to a file. If you do not want to
   * write logs to a file, you may set this to `null`.
   *
   * @default 'storage/logs/stacks.log'
   */
  logsPath: storagePath('logs/stacks.log'),

  /**
   * **Deployments Path**
   *
   * The path to the deployments folder. This will be used to write deployment logs to a file.
   * If you do not want to write deployment logs to a file, you may set this to `null`.
   *
   * @default 'storage/logs/deployments.log'
   */
  deploymentsPath: storagePath('logs/deployments.log'),

  // bughq turns log.error and reported request/job failures into issues, and
  // lower-severity lines into breadcrumbs (30 per trace, attached to the next
  // issue). Keys are public per-project ingest keys, safe to keep inline.
  //
  // This array is documentation, not wiring: `@stacksjs/logging` never reads
  // it. `bughqTransport()` registers itself with the logger from inside, so
  // CALLING it is what attaches it — which is why the gate above guards the
  // call rather than the array (tests/unit/logging-transports.test.ts).
  //
  // Never add a top-level `level` here: it breaks the transports array. Set
  // severity per transport instead (bughq `eventLevel`).
  transports: REPORTS_ISSUES
    ? [
        bughqTransport({
          key: 'bughq_de5b1dcd73d04d9b978431db956d50224ebe8a72f5644eb18438777293377171',
          environment: process.env.APP_ENV,
        }),
      ]
    : [],
} satisfies LoggingConfig

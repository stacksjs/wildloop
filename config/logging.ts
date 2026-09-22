import type { LoggingConfig } from '@stacksjs/types'
import { bughqTransport } from '@bughq/stacks'
import { loghqTransport } from '@loghq/stacks'
import { storagePath } from '@stacksjs/path'

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

  // Both HQ apps attach as log transports and receive the raw record before
  // formatting (an Error stays an Error, an object stays an object). loghq
  // streams every log.* call at info+; bughq turns log.error and reported
  // request/job failures into issues, lower-severity lines into breadcrumbs
  // (30 per trace, attached to the next issue). Keys are public per-project
  // ingest keys, safe to keep inline.
  //
  // Never add a top-level `level` here: it breaks the transports array. Set
  // severity per transport instead (loghq `minLevel`, bughq `eventLevel`).
  transports: [
    loghqTransport({
      key: 'loghq_208c4a438f864ead9868ca74a8b1fd46e2093257d820441a90802c5bee49106b',
      environment: process.env.APP_ENV,
      release: process.env.APP_VERSION,
    }),
    bughqTransport({
      key: 'bughq_de5b1dcd73d04d9b978431db956d50224ebe8a72f5644eb18438777293377171',
      environment: process.env.APP_ENV,
    }),
  ],
} satisfies LoggingConfig

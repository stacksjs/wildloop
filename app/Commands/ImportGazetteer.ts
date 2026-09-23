import type { CLI } from '@stacksjs/types'
import type { GeoNamesDataset } from 'ts-maps/gazetteer'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { intro, log, outro } from '@stacksjs/cli'
import { ExitCode } from '@stacksjs/types'
import { buildGazetteerFile, downloadGeoNames } from 'ts-maps/gazetteer'
import { gazetteerPath } from '../Support/gazetteer'

const DATASETS: GeoNamesDataset[] = ['cities500', 'cities1000', 'cities5000', 'cities15000']

/**
 * `buddy geo:import` — build the place-search database from GeoNames.
 *
 * Every town of 1,000+ people worldwide (~170k places, ~60 MB), so a trip can
 * be planned from any of them. The file lives beside the app database and is
 * written beside itself then renamed in, so the running server keeps
 * answering from the old copy until the new one is complete.
 *
 * The deploy runs this with `--if-missing`: once per server, and never fatal.
 * If GeoNames is unreachable the release still goes out — place search says
 * it is not ready — and the next deploy tries again.
 */
export default function (cli: CLI) {
  cli
    .command('geo:import', 'Build the place-search gazetteer from GeoNames')
    .option('--if-missing', 'Only build when no gazetteer exists yet; never fail', { default: false })
    .option('--dataset <dataset>', 'cities500 | cities1000 | cities5000 | cities15000', { default: 'cities1000' })
    .action(async (options: { ifMissing: boolean, dataset: string }) => {
      const perf = await intro('buddy geo:import')
      const path = gazetteerPath()

      if (options.ifMissing && existsSync(path)) {
        log.info(`Gazetteer already at ${path}`)
        await outro('Nothing to do', { startTime: perf, useSeconds: true })
        process.exit(ExitCode.Success)
      }

      const dataset = options.dataset as GeoNamesDataset
      if (!DATASETS.includes(dataset)) {
        log.error(`Unknown dataset ${options.dataset}. Use one of: ${DATASETS.join(', ')}`)
        process.exit(ExitCode.FatalError)
      }

      try {
        log.info(`Downloading GeoNames ${dataset}…`)
        const sources = await downloadGeoNames({ dataset })
        mkdirSync(dirname(path), { recursive: true })
        const { places } = buildGazetteerFile(path, sources)
        log.success(`${places.toLocaleString()} places → ${path}`)
        await outro('Gazetteer ready', { startTime: perf, useSeconds: true })
        process.exit(ExitCode.Success)
      }
      catch (error) {
        log.error(`Gazetteer build failed: ${(error as Error).message}`)
        // A deploy must not fail over place search.
        process.exit(options.ifMissing ? ExitCode.Success : ExitCode.FatalError)
      }
    })
}

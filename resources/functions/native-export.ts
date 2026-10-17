import type { NativeCraft } from '@stacksjs/stx/native'
import type { RoutePair } from './trail-geometry'
import { trailGpx } from './trail-map'

/** Files remain on the device until the person chooses a share destination. */
export async function exportNativeGpx(host: Pick<NativeCraft, 'files' | 'share'>, name: string, parts: RoutePair[][]): Promise<void> {
  if (!parts.some(part => part.length > 1)) throw new Error('There is no recorded route to export.')
  if (!host.files || !host.share) throw new Error('File sharing is unavailable in this app build.')
  const filename = `${name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'wildloop-route'}.gpx`
  const file = await host.files.write(filename, trailGpx(name, parts), { type: 'application/gpx+xml' })
  await host.share({ title: name, files: [file.path] })
}

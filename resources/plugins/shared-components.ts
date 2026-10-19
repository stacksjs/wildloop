import { dirname, join } from 'node:path'

/*
 * The `@stacksjs/components` families this app renders, by directory.
 *
 * Not the whole package: registering it searches its directories before the
 * Stacks defaults, and its Image, Avatar, Badge, Card and Video then replace
 * the ones this app's pages are written against (see `componentPackages` in
 * config/stx.ts). Each family named here renders the same source on the web
 * and in the native screens.
 */
const FAMILIES = ['dialog', 'segmented-control']

const ui = join(dirname(Bun.resolveSync('@stacksjs/components/stx-plugin', import.meta.dir)), 'src/ui')

export default {
  name: 'wildloop-shared-components',
  components: FAMILIES.map(family => join(ui, family)),
}

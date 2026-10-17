import { dirname, join } from 'node:path'

/** Register the Stacks dialog family without replacing application image components. */
export default {
  name: 'wildloop-native-dialogs',
  components: [join(dirname(Bun.resolveSync('@stacksjs/components/stx-plugin', import.meta.dir)), 'src/ui/dialog')],
}

import { expect, it } from 'bun:test'
import { Glob, Transpiler } from 'bun'

it('keeps application function names unique so the server registry can load', async () => {
  const names = new Map<string, string>()
  const scan = new Transpiler({ loader: 'ts' })
  for await (const path of new Glob('resources/functions/**/*.ts').scan()) {
    for (const name of scan.scan(await Bun.file(path).text()).exports) {
      if (name === 'default')
        continue
      expect(names.get(name), `${name} is exported by both ${names.get(name)} and ${path}`).toBeUndefined()
      names.set(name, path)
    }
  }
})

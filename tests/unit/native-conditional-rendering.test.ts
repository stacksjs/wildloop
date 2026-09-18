import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * A component's `:if` is bound once inside Craft's WebView and then never
 * re-runs. It reads correctly on the first pass and is deaf to the signal
 * afterwards — no error, no warning — while the identical markup works in
 * Safari on the same device and in every browser. The same `:if` in a page or
 * layout scope is fine; only components are affected.
 *
 * That cost an evening: the sign-in gate's buttons dispatched their event, the
 * gate received it and set its own state, and nothing appeared on screen.
 *
 * So anything that has to change visibility *inside a component* toggles a
 * class instead, because class bindings do re-run there. These assertions
 * exist to stop `:if` creeping back into the two components the app shows.
 */
function code(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
    .join('\n')
}

describe('conditional rendering inside components the native app mounts', () => {
  const gate = code('../../resources/components/AuthGate.stx')
  const banner = code('../../resources/components/NativeNetworkBanner.stx')

  it('opens the sign-in gate with a class, not by inserting the dialog', () => {
    expect(gate).not.toContain(':if=')
    expect(gate).toContain('x-class="gateIsOpen() ? \'flex\' : \'hidden\'"')
  })

  it('keeps the gate cloaked until it has been hydrated', () => {
    // The dialog is in the DOM from the first byte now, so without x-cloak it
    // would flash over the page before the class binding ever runs.
    expect(gate).toContain('x-cloak')
  })

  it('reveals the register-only field and the error line by class too', () => {
    // Both sat inside the dialog and were `:if` as well: signing up had no
    // name field, and a rejected password reported nothing at all.
    expect(gate).toContain('gateRegistering() ? \'block\' : \'hidden\'')
    expect(gate).toContain('formError() ? \'block\' : \'hidden\'')
  })

  it('leaves the offline banner mounted and hides it while connected', () => {
    // It starts connected, so `:if` dropped it on the first pass and the app
    // could never say it had lost signal — on a ridge, the one thing it is for.
    expect(banner).not.toContain(':if=')
    expect(banner).toContain('connected() ? \'native-network-banner--quiet\' : \'\'')
    expect(banner).toContain('.native-network-banner--quiet { display: none; }')
  })
})

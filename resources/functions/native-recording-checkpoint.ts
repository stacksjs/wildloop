import type { NativeStorage } from '@stacksjs/stx/native'
import type { NativeRecording } from './native-recording'

const KEY = 'wildloop-native-recording-v1'
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const conflict = () => new Error('The saved recording changed on this device. Pull down to recover it before trying again. Your track has been retained.')

/** Serialize exact native CAS writes; a stale screen never replaces another track. */
export function createNativeRecordingCheckpoint(storage: Pick<NativeStorage, 'get' | 'setIfAbsent' | 'compareAndSet'>) {
  let saved: NativeRecording | null = null
  let writes = Promise.resolve()
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const pending = writes.then(work)
    writes = pending.then(() => {}, () => {})
    return pending
  }
  function sameRecording(value: NativeRecording): void {
    if (!saved || saved.id !== value.id || saved.userId !== value.userId) throw conflict()
  }
  return {
    read: () => serialize(async () => {
      saved = copy(await storage.get<NativeRecording>(KEY))
      return copy(saved)
    }),
    register: (value: NativeRecording) => {
      const snapshot = copy(value)
      return serialize(async () => {
        // CAS null updates an existing tombstone; setIfAbsent creates a key.
        // Neither operation may replace an existing account's checkpoint.
        if (!await storage.setIfAbsent(KEY, snapshot) && !await storage.compareAndSet(KEY, null, snapshot)) throw conflict()
        saved = snapshot
      })
    },
    save: (value: NativeRecording) => {
      const snapshot = copy(value)
      return serialize(async () => {
        sameRecording(snapshot)
        if (!await storage.compareAndSet(KEY, saved, snapshot)) throw conflict()
        saved = snapshot
      })
    },
    clear: (value: NativeRecording) => serialize(async () => {
      sameRecording(value)
      if (!await storage.compareAndSet(KEY, saved, null)) throw conflict()
      saved = null
    }),
  }
}

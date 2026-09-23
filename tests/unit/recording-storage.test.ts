import { describe, expect, it } from 'bun:test'
import { enqueueRun } from '../../resources/assets/scripts/run-upload-queue'
import { saveRecordingCheckpoint } from '../../resources/assets/scripts/recording-checkpoint'

describe('durable recording storage', () => {
  it('refuses to promise an offline save when device storage is unavailable', async () => {
    expect(typeof indexedDB).toBe('undefined')
    await expect(enqueueRun({
      user_id: 1,
      activity_type: 'Hike',
      distance: 1,
      duration: '20:00',
      upload_id: 'storage-unavailable-test',
    })).rejects.toThrow('storage')
  })

  it('refuses to promise recovery when checkpoint storage is unavailable', async () => {
    await expect(saveRecordingCheckpoint({
      userId: 1,
      activityType: 'Hike',
      visibility: 'private',
      runMode: 'free',
      targetTerritoryId: null,
      startedAtMs: 1000,
      elapsed: 10,
      distance: 0.01,
      elevation: 0,
      paused: false,
      samples: [],
    })).rejects.toThrow('storage')
  })
})

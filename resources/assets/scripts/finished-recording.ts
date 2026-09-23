import { persistRunAndProcess, type ActivityPayload, type RunResult } from './game-api'
import { clearRecordingCheckpoint, saveRecordingCheckpoint, type RecordingCheckpoint } from './recording-checkpoint'

/** Keep the final track until either the API or a committed offline queue owns it. */
export async function saveFinishedRecording(
  checkpoint: Omit<RecordingCheckpoint, 'id' | 'savedAt'>,
  payload: ActivityPayload,
): Promise<RunResult> {
  if (!payload.upload_id || payload.user_id !== checkpoint.userId)
    throw new Error('The recording must be saved by the account that started it.')

  // Device storage can fail while the network works. Still try the server;
  // callers retain the same payload in memory if neither destination accepts it.
  await saveRecordingCheckpoint({ ...checkpoint, pendingUpload: payload }).catch(() => undefined)
  const result = await persistRunAndProcess(payload)
  if (!result.activityId && !result.queued)
    throw new Error(result.error || 'Activity could not be saved. Keep this page open and retry.')
  // Failure to remove a redundant checkpoint is safe: its stable upload id
  // makes recovery/replay idempotent. Never remove the only remaining copy.
  await clearRecordingCheckpoint().catch(() => undefined)
  return result
}

import { backfillWindow, createGarminClient } from './garminConnect'

/** Both the browser cookie flow and native handoff redeem the same PKCE grant. */
export async function connectGarminAccount(config: Parameters<typeof createGarminClient>[0], userId: number, code: string, verifier: string): Promise<void> {
  const client=createGarminClient(config)
  const tokens=await client.exchangeCode(code,verifier)
  const garminUserId=await client.getUserId(tokens.accessToken)
  const {db}=await import('@stacksjs/database')
  await db.deleteFrom('garmin_connections').where('user_id','=',userId).execute()
  await db.deleteFrom('garmin_connections').where('garmin_user_id','=',garminUserId).execute()
  await db.insertInto('garmin_connections').values({user_id:userId,garmin_user_id:garminUserId,access_token:tokens.accessToken,refresh_token:tokens.refreshToken ?? null,expires_at:tokens.expiresAt ?? null,scope:tokens.scope ?? config.scope}).execute()
  try {
    const {start,end}=backfillWindow()
    await client.requestBackfill(tokens.accessToken,start,end)
  }
  catch { console.error('[garmin] backfill request failed; new activities will still import') }
}

import { describe, expect, it } from 'bun:test'
import { nativeGarminAttempt, nativeGarminRedirect } from '../../app/Support/garminOAuth'
import { sealOAuthState, OAUTH_STATE_TTL_MS } from '../../app/Support/garminConnect'
import { nativeOAuthCallback } from '../../resources/functions/native-oauth'

describe('native Garmin PKCE handoff',()=>{
  const secret='native-garmin-test-key'
  const state={userId:7,state:'native-random-nonce',verifier:'test-pkce-verifier',issuedAt:1700000000000}
  const handoff=sealOAuthState(state,secret)
  it('accepts only the authenticated owner and matching attempt',()=>{
    expect(nativeGarminAttempt(handoff,state.state,7,secret,state.issuedAt+100)).toEqual(state)
    expect(nativeGarminAttempt(handoff,state.state,8,secret,state.issuedAt+100)).toBeNull()
    expect(nativeGarminAttempt(handoff,'native-different',7,secret,state.issuedAt+100)).toBeNull()
    expect(nativeGarminAttempt(handoff,state.state,7,'wrong-key',state.issuedAt+100)).toBeNull()
  })
  it('rejects expired, future and tampered handoffs',()=>{
    expect(nativeGarminAttempt(handoff,state.state,7,secret,state.issuedAt+OAUTH_STATE_TTL_MS+1)).toBeNull()
    expect(nativeGarminAttempt(handoff,state.state,7,secret,state.issuedAt-1)).toBeNull()
    expect(nativeGarminAttempt(handoff+'tampered',state.state,7,secret,state.issuedAt+100)).toBeNull()
  })
  it('relays only a code and state to the fixed app callback',()=>{
    const response=nativeGarminRedirect('code/with=values',state.state,null)
    const url=response.headers.get('Location')!
    expect(nativeOAuthCallback(url)).toEqual({code:'code/with=values',state:state.state,error:''})
    expect(url).not.toContain(state.verifier)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(nativeOAuthCallback('https://attacker.example/settings?code=code')).toBeNull()
    expect(nativeOAuthCallback('wildloop://settings?state=a&state=b&code=x')).toBeNull()
    expect(nativeOAuthCallback('wildloop://settings?code=%GG')).toBeNull()
  })
})

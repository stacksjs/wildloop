import { beforeAll, describe, expect, it } from 'bun:test'
import { nativeNodeProps, answer, answerNativeCsrf, compileNativeBundle, requests, start, waitForRequest, waitForText } from '../fixtures/nativeScreen'

describe('native account forms',()=>{
  beforeAll(compileNativeBundle,30000)

  /*
   * There is nowhere to go from here but in. An auth screen used to keep the
   * app's tab bar underneath it, so a viewer asked to sign in could tap Feed,
   * Record or Menu and leave with the question unanswered — and Record would
   * send them straight back.
   *
   * `tabBarHidden` is read by the host (`CraftNativeScreen.swift`) and
   * restored when the screen goes away, but it is missing from
   * `NativeNavigationOptions`, so nothing but this test would notice it being
   * dropped.
   */
  it.each(['Login', 'Register', 'ForgotPassword', 'ResetPassword'])('hides the tab bar on %s', async (name) => {
    const screen = await start(name)
    const options = screen.sent
      .filter((message: any) => message.type === 'NAVIGATION_SET_OPTIONS')
      .map((message: any) => message.payload)
    expect(options.length).toBeGreaterThan(0)
    expect(options.some((option: any) => option?.tabBarHidden === true)).toBe(true)
  })
  it('stores a successful login in keychain and returns to the native trail',async()=>{
    const screen=await start('Login',{next:'/trail/7'})
    await screen.event('login-email','onChangeText',{text:'  native@example.test '})
    await screen.event('login-password','onChangeText',{text:'Native-QA-password'})
    await screen.event('login-submit','onPress')
    answer(screen,await waitForRequest(screen,0,r=>r.payload.module==='SecureStorage'),null)
    await answerNativeCsrf(screen)
    const post=await waitForRequest(screen,0,r=>r.payload.module==='Network' && r.payload.args[0].method==='POST')
    expect(nativeNodeProps(screen,'login-submit').title).toBe('Signing in…')
    expect(post.payload.args[0].headers).toMatchObject({'x-csrf-token':'a'.repeat(64),cookie:`X-CSRF-Token=${'a'.repeat(64)}`})
    expect(JSON.parse(post.payload.args[0].body)).toMatchObject({email:'native@example.test',password:'Native-QA-password'})
    answer(screen,post,{status:200,headers:{'content-type':'application/json'},body:JSON.stringify({token:'native-login-token',user:{id:7,name:'Native tester'}})})
    const bearer=await waitForRequest(screen,requests(screen).indexOf(post)+1,r=>r.payload.module==='SecureStorage' && r.payload.method==='set')
    expect(bearer.payload.args).toEqual(['auth_token','native-login-token'])
    answer(screen,bearer,true)
    const owner=await waitForRequest(screen,requests(screen).indexOf(bearer)+1,r=>r.payload.module==='SecureStorage')
    expect(JSON.parse(owner.payload.args[1])).toEqual({token:'native-login-token',user:{id:7}})
    answer(screen,owner,true)
    for(let attempt=0;attempt<20 && !screen.sent.some(message=>message.type==='NAVIGATE_OPEN');attempt++)await Bun.sleep(1)
    expect(screen.scope.__snapshots.get('wildloop-session')).toEqual({user:{id:7,name:'Native tester'},version:1})
    expect(screen.sent.some(message=>message.type==='NAVIGATE_OPEN' && message.payload.path==='/trail/7')).toBe(true)
  })
  it('shows a refused login without persisting or navigating',async()=>{
    const screen=await start('Login')
    await screen.event('login-email','onChangeText',{text:'native@example.test'})
    await screen.event('login-password','onChangeText',{text:'incorrect'})
    await screen.event('login-submit','onPress')
    answer(screen,await waitForRequest(screen,0,r=>r.payload.module==='SecureStorage'),null)
    await answerNativeCsrf(screen)
    answer(screen,await waitForRequest(screen,0,r=>r.payload.module==='Network' && r.payload.args[0].method==='POST'),{status:401,headers:{'content-type':'application/json'},body:JSON.stringify({error:'Incorrect email or password'})})
    await waitForText(screen,'Incorrect email or password')
    expect(requests(screen).some(r=>r.payload.module==='SecureStorage' && r.payload.method==='set')).toBe(false)
    expect(screen.sent.some(message=>message.type==='NAVIGATE_OPEN')).toBe(false)
  })
  it('requires native registration consent before sending an account request',async()=>{
    const screen=await start('Register')
    for(const [id,text] of [['register-name','Native tester'],['register-email','native@example.test'],['register-password','Native-QA-password'],['register-confirmation','Native-QA-password']])await screen.event(id,'onChangeText',{text})
    await screen.event('register-submit','onPress')
    await waitForText(screen,'Accept the terms to create your account.')
    expect(requests(screen)).toHaveLength(0)
  })
})

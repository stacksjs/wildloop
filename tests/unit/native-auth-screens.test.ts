import { beforeAll, describe, expect, it } from 'bun:test'
import { nativeUi } from '../../resources/functions/native-ui'
import { nativeNodeProps, nativeNodeText, answer, answerNativeCsrf, compileNativeBundle, requests, start, waitForRequest, waitForText } from '../fixtures/nativeScreen'

describe('native account forms',()=>{
  beforeAll(compileNativeBundle,30000)

  /*
   * There is nowhere to go from here but in. An auth screen used to keep the
   * app's tab bar underneath it, so a viewer asked to sign in could tap Feed,
   * Record or Menu and leave with the question unanswered — and Record would
   * send them straight back. Hiding the bar left two more ways out: the
   * navigation bar's back chevron, and the edge swipe that still popped the
   * screen with that chevron gone (measured on a device — hiding the bar does
   * not disable the gesture).
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
    // No tab bar, no navigation bar and no edge swipe: the three ways off an
    // auth screen that are not answering it.
    expect(options.some((option: any) => option?.tabBarHidden === true)).toBe(true)
    expect(options.some((option: any) => option?.hidden === true)).toBe(true)
    expect(options.some((option: any) => option?.swipeBack === false)).toBe(true)
  })
  /*
   * The four auth screens are walked one after another — Login offers
   * Register, Register offers Login, both offer ForgotPassword — with none of
   * the app's chrome around them to hold the eye. A heading that changed size
   * or alignment between them read as a different app each tap, which is why
   * they share `authTitle` rather than each setting their own. `ui.title`
   * stays 17px left for the eleven screens that sit inside the app's chrome.
   */
  it('gives every auth screen the same centred heading', async () => {
    expect(nativeUi.authTitle).toContain('text-center')
    expect(nativeUi.authTitle).not.toBe(nativeUi.title)
    for (const name of ['Login', 'Register', 'ForgotPassword', 'ResetPassword']) {
      const source = await Bun.file(`${import.meta.dir}/../../resources/native/${name}.stx`).text()
      expect(source).toContain('ui.authTitle')
      expect(source).not.toContain(':class="ui.title"')
    }
  })
  /*
   * `accessibilityLabel` was already on every one of these fields, so
   * VoiceOver always read them correctly — it was the sighted reader who got
   * nothing. ResetPassword showed three identical rounded boxes with no way
   * to tell email from new password from confirmation, and the only cue that
   * two of them were secure was that typing in them was masked.
   */
  it.each([
    ['ForgotPassword', { 'forgot-email-label': 'Email' }],
    ['ResetPassword', {
      'reset-email-label': 'Email',
      'reset-password-label': 'New password',
      'reset-confirmation-label': 'Confirm new password',
    }],
  ])('labels every field on %s where a reader can see it', async (name, labels) => {
    const screen = await start(name as string, { token: 'preview' })
    for (const [testID, label] of Object.entries(labels))
      expect(nativeNodeText(screen, testID)).toBe(label)
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

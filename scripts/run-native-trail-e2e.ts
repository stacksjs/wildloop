import { mkdir, appendFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { generateXcodeProject, resolveXcodegen } from '@stacksjs/actions/build/ios-toolchain'
import { prepareIosSimulatorDriver, serializeSimulatorSteps } from '@stacksjs/mobile/testing'
import mobile from '../config/mobile'
import { nativeTrailJourneys } from '../tests/native/trail-journey'
import { QA_PORTS } from '../tests/browser/qa-ports'
import { QA_SOCIAL_ACCOUNT } from '../tests/browser/qa-social-account'
import { IOS_SIMULATOR_SIGNING, validateGeneratedNativeApp, validateIosAppBundle } from './run-mobile-e2e'

/** The caller supplies its own simulator; this runner never selects somebody else's. */
export async function runNativeTrailE2e(): Promise<void> {
  const device=process.env.NATIVE_QA_DEVICE
  if(process.platform!=='darwin' || !device)throw new Error('Native trail QA requires macOS and NATIVE_QA_DEVICE naming an owned simulator.')
  const root=resolve('storage/framework/runtime/e2e/native-trail')
  await mkdir(root,{recursive:true})
  const origin=`http://127.0.0.1:${QA_PORTS.app}`
  for(const port of [QA_PORTS.app,QA_PORTS.api]) {
    const occupied=await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(1000)}).then(()=>true).catch(()=>false)
    if(occupied)throw new Error(`QA port ${port} is already in use. Select a separate QA_PORT_BASE.`)
  }
  const command=async(args:string[],log:string,env:Record<string,string>={})=>{
    console.log(`Native trail QA: ${log}`)
    const child=Bun.spawn(args,{env:{...process.env,...env},stdout:Bun.file(join(root,log)),stderr:'pipe'})
    const stderr=await new Response(child.stderr).text()
    const status=await child.exited
    if(stderr)await appendFile(join(root,log),`\n${stderr}`)
    if(status)throw new Error(`${args[0]} exited ${status}; see ${join(root,log)}`)
  }
  const qa=Bun.spawn(['bun','scripts/start-recording-qa.ts'],{stdout:Bun.file(join(root,'qa-server.log')),stderr:'inherit'})
  let control:ReturnType<typeof Bun.serve>|undefined
  let nativeRun:ReturnType<typeof Bun.spawn>|undefined
  let activeJourney='maps'
  let activeScript=''
  const failures:string[]=[]
  try {
    const deadline=Date.now()+180000
    while(true){
      const ready=await fetch(`${origin}/api/health`,{signal:AbortSignal.timeout(1000)}).then(r=>r.ok).catch(()=>false)
      if(ready)break
      if(qa.exitCode!==null || Date.now()>deadline)throw new Error('Isolated native QA server did not become ready.')
      await Bun.sleep(250)
    }
    const listed=await (await fetch(`${origin}/api/trails?q=Craggy&country=all&limit=10`)).json() as any
    let trail:any
    for(const candidate of listed.trails ?? []) {
      const detail=await (await fetch(`${origin}/api/trails/${candidate.id}`)).json() as any
      if(detail.trail?.hasGeometry){trail=detail.trail;break}
    }
    if(!trail)throw new Error('Native trail QA requires its seeded recorded route.')
    const review=`Native QA ${crypto.randomUUID().slice(0,8)}: clear signposts and a beautiful ridge.`
    const journeys=nativeTrailJourneys({trailId:trail.id,trailName:trail.name,email:QA_SOCIAL_ACCOUNT.email,password:QA_SOCIAL_ACCOUNT.sessionSecret,review,edit:' Updated after a return visit.'})
    const controlPort=QA_PORTS.app+15
    const driver=prepareIosSimulatorDriver({...mobile.ios,simulator:{output:join(root,'driver'),projectName:'WildloopTrailDriver',bundleIdPrefix:'org.wildloop.trailqa',controlUrl:`http://127.0.0.1:${controlPort}`}})
    control=Bun.serve({hostname:'127.0.0.1',port:controlPort,idleTimeout:120,async fetch(request){
      const url=new URL(request.url)
      if(url.pathname==='/script')return new Response(activeScript)
      if(url.pathname==='/note' && request.method==='POST'){
        const line=await request.text()
        if(line.startsWith('FAIL ')) {
          if(!failures.includes(activeJourney))failures.push(activeJourney)
          await command(['xcrun','simctl','io',device,'screenshot',join(root,`${activeJourney}-native-failure.png`)],`${activeJourney}-failure-screenshot.log`).catch(cause=>console.warn(String(cause)))
        }
        await appendFile(join(root,`driver-${activeJourney}.log`),`${line}\n`)
        return new Response('ok')
      }
      if(url.pathname==='/save' && request.method==='POST'){
        const name=url.searchParams.get('name') ?? ''
        if(!/^[a-z0-9-]+\.(png|txt)$/.test(name))return new Response('Invalid name',{status:422})
        await writeFile(join(root,`${activeJourney}-${name}`),new Uint8Array(await request.arrayBuffer()))
        return new Response('ok')
      }
      return new Response('Not found',{status:404})
    }})
    await command(['bun','run','build:ios'],'app-generation.log',{MOBILE_URL:`${origin}/feed`})
    validateGeneratedNativeApp('storage/framework/mobile/ios')
    const generated=await Bun.file('storage/framework/mobile/ios/craft.config.json').json()
    await writeFile(join(root,'native-app-origin.log'),JSON.stringify({url:generated.devServerURL,renderer:generated.renderer}))
    if(generated.devServerURL!==`${origin}/feed`)throw new Error('The native QA app must target its isolated server.')
    await command(['xcodebuild','-project','storage/framework/mobile/ios/Wildloop.xcodeproj','-scheme','Wildloop','-configuration','Debug','-destination',`id=${device}`,'-derivedDataPath',join(root,'app-build'),'-jobs','2',...IOS_SIMULATOR_SIGNING,'build'],'app-build.log')
    const app=join(root,'app-build/Build/Products/Debug-iphonesimulator/Wildloop.app')
    validateIosAppBundle(app)
    await command(['codesign','--verify','--strict',app],'app-signature.log')
    await command(['codesign','--display','--entitlements',':-',app],'app-entitlements.log')
    // Xcode embeds simulator entitlements in __TEXT,__entitlements rather than
    // the code-signature slot returned by codesign --display. Inspect the
    // linked simulator entitlement input, and retain both forms as evidence.
    const simulated=join(root,'app-build/Build/Intermediates.noindex/Wildloop.build/Debug-iphonesimulator/Wildloop.build/Wildloop.app-Simulated.xcent')
    await command(['plutil','-extract','application-identifier','raw','-o','-',simulated],'app-simulator-identifier.log')
    const identifier=(await Bun.file(join(root,'app-simulator-identifier.log')).text()).trim()
    if(identifier!==mobile.ios.bundleId && !identifier.endsWith(`.${mobile.ios.bundleId}`))throw new Error('The simulator entitlement does not identify the application under test.')
    await command(['xcrun','simctl','install',device,app],'app-install.log')
    const tool=await resolveXcodegen(process.cwd())
    generateXcodeProject(tool,driver.output)
    await writeFile(join(root,'driver-generation.log'),JSON.stringify({package:tool.pkg,version:tool.version})+'\n')
    for(const journey of journeys) {
      activeJourney=journey.name
      activeScript=serializeSimulatorSteps(journey.steps)
      nativeRun=Bun.spawn(['xcodebuild','-project',join(driver.output,`${driver.projectName}.xcodeproj`),'-scheme',driver.projectName,'-destination',`id=${device}`,'-derivedDataPath',join(root,'driver-build'),'-resultBundlePath',join(root,`results-${activeJourney}.xcresult`),'-parallel-testing-enabled','NO','-maximum-concurrent-test-simulator-destinations','1','-collect-test-diagnostics','never','-jobs','2','CODE_SIGNING_ALLOWED=NO','test'],{stdout:Bun.file(join(root,`driver-${activeJourney}-build-test.log`)),stderr:'inherit'})
      const status=await nativeRun.exited
      const notes=await Bun.file(join(root,`driver-${activeJourney}.log`)).text().catch(()=>'')
      if(status || failures.includes(activeJourney) || !notes.includes(journey.completion)) {
        if(!failures.includes(activeJourney))failures.push(activeJourney)
        // Direct XCTest tap failures can stop before the driver's FAIL note.
        await command(['xcrun','simctl','io',device,'screenshot',join(root,`${activeJourney}-native-failure.png`)],`${activeJourney}-failure-screenshot.log`).catch(cause=>console.warn(String(cause)))
        await command(['xcrun','simctl','spawn',device,'log','show','--last','5m','--style','compact','--predicate','process == "Wildloop"'],`${activeJourney}-app-runtime.log`).catch(cause=>console.warn(String(cause)))
      }
    }
    if(failures.length)throw new Error(`Native trail QA failed: ${failures.join(', ')}. Inspect the separate XCTest results, driver logs and screenshots.`)
    console.log('Native trail map, sticky save and review create/edit/delete journey passed.')
  }
  finally {
    if(nativeRun && nativeRun.exitCode===null)nativeRun.kill()
    control?.stop(true)
    qa.kill('SIGTERM')
    await qa.exited
  }
}

if(import.meta.main)await runNativeTrailE2e()

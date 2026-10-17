import process from 'node:process'
import mobile from '../config/mobile'

const platform=process.argv[2]
if(platform!=='ios' && platform!=='android')throw new Error('Usage: bun scripts/build-mobile.ts ios|android')
if(platform==='android' && !mobile.android.mapsApiKey?.trim())throw new Error('Set ANDROID_MAPS_API_KEY to a Google Maps SDK for Android key before building Wildloop. Native trail maps require this configured SDK credential.')
const build=Bun.spawn(['./buddy',`build:${platform}`,...process.argv.slice(3)],{stdout:'inherit',stderr:'inherit',stdin:'inherit'})
process.exitCode=await build.exited

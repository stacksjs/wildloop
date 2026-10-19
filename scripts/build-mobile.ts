import process from 'node:process'

const platform=process.argv[2]
if(platform!=='ios' && platform!=='android')throw new Error('Usage: bun scripts/build-mobile.ts ios|android')
const build=Bun.spawn(['./buddy',`build:${platform}`,...process.argv.slice(3)],{stdout:'inherit',stderr:'inherit',stdin:'inherit'})
process.exitCode=await build.exited

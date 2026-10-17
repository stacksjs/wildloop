import { Auth } from '@stacksjs/auth'
import garminConfig from '../../../config/garmin'
import { isConfigured } from '../../Support/garminConnect'
import { connectGarminAccount } from '../../Support/garminConnection'
import { nativeGarminAttempt } from '../../Support/garminOAuth'

export default new Action({
  name:'Garmin Native Session',
  description:'Finish a native Garmin authorization for the signed-in account',
  method:'POST',
  async handle(request) {
    const user=await Auth.user().catch(()=>null)
    if(!user)return response.json({success:false,error:'Sign in to continue.'},401)
    if(!isConfigured(garminConfig))return response.json({success:false,error:'Garmin syncing is not available yet.'},503)
    const code=request.get('code')
    const attempt=nativeGarminAttempt(request.get('handoff'),request.get('state'),Number(user.id),process.env.APP_KEY ?? '')
    if(!attempt || typeof code!=='string' || !code || code.length>4096)return response.json({success:false,error:'This connection attempt is invalid or expired. Start again.'},422)
    try {
      await connectGarminAccount(garminConfig,Number(user.id),code,attempt.verifier)
      return response.json({success:true})
    }
    catch { return response.json({success:false,error:'Garmin could not be connected. Start a new connection attempt.'},502) }
  },
})

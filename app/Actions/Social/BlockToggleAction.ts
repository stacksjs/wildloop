import { Auth } from '@stacksjs/auth'

import UserBlock from '../../Models/UserBlock'
import { wantsIt } from '../../Support/toggleIntent'

export default new Action({
  name: 'Block Toggle',
  description: 'Block or unblock another athlete and sever social connections',
  method: 'POST',
  async handle(request) {
    const blockerId = (await Auth.user().catch(() => null))?.id
    const blockedId = positiveInt(request.get('id'))
    if (!blockerId)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    if (!blockedId || blockedId === blockerId)
      return response.json({ success: false, error: 'Choose another athlete to block' }, 422)
    if (!await User.find(blockedId))
      return response.json({ success: false, error: 'Athlete not found' }, 404)

    const existing = await UserBlock.where('blocker_id', '=', blockerId).where('blocked_id', '=', blockedId).first()
    if (!wantsIt(request.method, Boolean(existing))) {
      if (existing)
        await UserBlock.delete(existing.id)
      return response.json({ success: true, blocked: false })
    }

    if (!existing)
      await UserBlock.forceCreate({ blocker_id: blockerId, blocked_id: blockedId })
    const connections = [
      ...((await Follow.where('follower_id', '=', blockerId).where('following_id', '=', blockedId).get()) ?? []),
      ...((await Follow.where('follower_id', '=', blockedId).where('following_id', '=', blockerId).get()) ?? []),
    ]
    for (const connection of connections)
      await Follow.delete(connection.id)
    return response.json({ success: true, blocked: true })
  },
})

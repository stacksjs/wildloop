import integrations from '../../../config/integrations'
import garmin from '../../../config/garmin'
import { integrationProviderStatuses } from '../../Support/integrationAdapters'

export default new Action({
  name: 'Integration Status',
  description: 'Provider capabilities without exposing credentials',
  method: 'GET',
  async handle() {
    return response.json({
      success: true,
      providers: integrationProviderStatuses({
        garminConfigured: !!(garmin.clientId && garmin.clientSecret && garmin.webhookSecret),
        appleHealthNativeBridge: integrations.appleHealth.nativeBridgeEnabled,
        healthConnectNativeBridge: integrations.healthConnect.nativeBridgeEnabled,
      }),
    })
  },
})

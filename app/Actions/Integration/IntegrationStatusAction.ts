import integrations from '../../../config/integrations'
import garmin from '../../../config/garmin'
import { integrationProviderStatuses } from '../../Support/integrationAdapters'
import { isConfigured as garminIsConfigured } from '../Garmin/garmin'

export default new Action({
  name: 'Integration Status',
  description: 'Provider capabilities without exposing credentials',
  method: 'GET',
  async handle() {
    return response.json({
      success: true,
      providers: integrationProviderStatuses({
        // The same test the Garmin card uses, so the two can never disagree.
        garminConfigured: garminIsConfigured(garmin),
        appleHealthNativeBridge: integrations.appleHealth.nativeBridgeEnabled,
        healthConnectNativeBridge: integrations.healthConnect.nativeBridgeEnabled,
      }),
    })
  },
})

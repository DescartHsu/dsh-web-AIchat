import { createPersistenceService, registerPersistenceRoutes, registerAutomaticPersistence } from './persistence-service.js'
import { registerUpdateRoutes } from './update-service.js'
export const inject = ['webServer', 'connection']
export function apply(ctx) {
  const service = createPersistenceService()
  registerPersistenceRoutes(ctx, service)
  registerUpdateRoutes(ctx)
  registerAutomaticPersistence(ctx, service)
}

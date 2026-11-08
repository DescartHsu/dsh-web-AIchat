import { createPersistenceService, registerPersistenceRoutes, registerAutomaticPersistence } from './persistence-service.js'
export const inject = ['webServer', 'connection']
export function apply(ctx) {
  const service = createPersistenceService()
  registerPersistenceRoutes(ctx, service)
  registerAutomaticPersistence(ctx, service)
}

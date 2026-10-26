import { registerPersistenceRoutes } from './persistence-service.js'
export const inject = ['webServer', 'connection']
export function apply(ctx) { registerPersistenceRoutes(ctx) }

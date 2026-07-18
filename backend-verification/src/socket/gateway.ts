/**
 * src/socket/gateway.ts
 *
 * Barrel re-export for the VerificationGateway.
 * The actual implementation lives in src/verification/verification.gateway.ts
 * to keep it co-located with the services it orchestrates.
 *
 * Import from here when wiring the gateway into AppModule or other modules:
 *   import { VerificationGateway } from './socket/gateway';
 */
export { VerificationGateway } from '../verification/verification.gateway';

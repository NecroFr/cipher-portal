import { Module } from '@nestjs/common';
import { WebAuthnController } from './webauthn.controller';
import { WebAuthnService } from './webauthn.service';
import { UsersModule } from '../users/users.module';

/**
 * AuthModule
 *
 * Bundles all WebAuthn (passkey) registration and authentication logic.
 * Imports UsersModule so WebAuthnController can call UsersService.recordLoginSuccess
 * after a successful passkey verify (writes the LoginEvent for risk history).
 */
@Module({
  imports: [UsersModule],
  controllers: [WebAuthnController],
  providers: [WebAuthnService],
  exports: [WebAuthnService],
})
export class AuthModule {}

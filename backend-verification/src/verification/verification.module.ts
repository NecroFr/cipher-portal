import { Module } from '@nestjs/common';
import { VerificationController } from './verification.controller';
import { VerificationGateway } from './verification.gateway';
import { NotificationService } from './notification.service';
import { QrService } from './qr.service';

/**
 * VerificationModule
 *
 * Owns:
 *  - VerificationGateway     (Socket.IO — rooms, push events)
 *  - NotificationService     (2-of-5 word game + session cache)
 *  - QrService               (QR challenge generator + validator)
 *  - VerificationController  (REST endpoints)
 *
 * All three providers use forwardRef() internally to break the circular
 * dependency between the Gateway and the two services.
 */
@Module({
  controllers: [VerificationController],
  providers: [
    VerificationGateway,
    NotificationService,
    QrService,
  ],
  exports: [
    VerificationGateway,
    NotificationService,
    QrService,
  ],
})
export class VerificationModule {}

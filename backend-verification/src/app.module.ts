import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { VerificationModule } from './verification/verification.module';

/**
 * AppModule — Root module for the Trusted Device & Verification Service
 *
 * Responsibilities:
 *  - Serve the static `public/` directory (simulator.html at /simulator.html)
 *  - Register VerificationModule (Gateway, NotificationService, QrService, Controller)
 */
@Module({
  imports: [
    // ── Static file serving ─────────────────────────────────────────────────
    // Serves everything under /public at the root URL.
    // simulator.html is accessible at http://localhost:3002/simulator.html
    ServeStaticModule.forRoot({
      rootPath    : join(__dirname, '..', 'public'),
      serveRoot   : '/',          // mount at web root
      exclude     : ['/api/(.*)'], // never intercept API routes
    }),

    // ── Feature modules ──────────────────────────────────────────────────────
    VerificationModule,
  ],
})
export class AppModule {}

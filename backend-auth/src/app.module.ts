import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { RiskModule } from './risk/risk.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    // Load .env globally — no need to import ConfigModule per feature module
    ConfigModule.forRoot({ isGlobal: true }),
    // Global Prisma — PrismaService available everywhere without re-importing
    PrismaModule,
    // Feature modules
    RiskModule,
    UsersModule,
    // WebAuthn / passkey authentication routes
    AuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

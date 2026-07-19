import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { CryptoKeysService } from '../auth/crypto-keys.service';
import { RecoveryService } from '../auth/recovery.service';
import { SafeScoreService } from '../risk/safe-score.service';

@Module({
  controllers: [UsersController],
  providers: [
    UsersService,
    CryptoKeysService,
    RecoveryService,
    SafeScoreService,
  ],
  exports: [UsersService],
})
export class UsersModule {}

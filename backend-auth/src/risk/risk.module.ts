import { Module } from '@nestjs/common';
import { SafeScoreService } from './safe-score.service';

@Module({
  providers: [SafeScoreService],
  exports: [SafeScoreService],
})
export class RiskModule {}

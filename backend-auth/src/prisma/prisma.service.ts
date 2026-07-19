import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaClient } = require('../../../generated/prisma');
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private _client: any;

  constructor(private readonly config: ConfigService) {
    const connectionString = this.config.getOrThrow<string>('DATABASE_URL');
    const adapter = new PrismaPg({ connectionString });
    this._client = new PrismaClient({ adapter });
  }

  get user() { return this._client.user; }
  get credential() { return this._client.credential; }
  get loginEvent() { return this._client.loginEvent; }

  async onModuleInit() {
    await this._client.$connect();
    this.logger.log('Prisma connected to PostgreSQL');
  }

  async onModuleDestroy() {
    await this._client?.$disconnect();
    this.logger.log('Prisma disconnected from PostgreSQL');
  }
}

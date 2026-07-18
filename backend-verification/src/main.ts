import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';

// Load .env before anything else
dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error', 'debug'],
  });

  // ── CORS ──────────────────────────────────────────────────────────────────
  // Allow the login frontend (Person 1 — port 5173) and auth server (Person 2 — port 3001)
  app.enableCors({
    origin: [
      process.env.FRONTEND_URL ?? 'http://localhost:5173',
      process.env.AUTH_SERVER_URL ?? 'http://localhost:3001',
      'http://localhost:3002', // self (simulator page)
    ],
    methods     : 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials : true,
  });

  // ── Port ──────────────────────────────────────────────────────────────────
  const port = parseInt(process.env.PORT ?? '3002', 10);
  await app.listen(port);

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║       Trusted Device & Verification Service               ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  HTTP  →  http://localhost:${port}                           ║`);
  console.log(`║  WS    →  ws://localhost:${port}                             ║`);
  console.log(`║  SIM   →  http://localhost:${port}/simulator.html            ║`);
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log('║  Endpoints:                                               ║');
  console.log('║   POST  /api/verification/initiate                        ║');
  console.log('║   POST  /api/notification/verify                          ║');
  console.log('║   GET   /api/qr/verify?session=...&token=...              ║');
  console.log('║   GET   /api/qr/status?session=...                        ║');
  console.log('║   GET   /api/session/status?session=...                   ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');
}

bootstrap();

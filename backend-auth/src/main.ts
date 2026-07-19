import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable CORS for the frontend dev server
  app.enableCors({
    origin: process.env.RP_ORIGIN ?? 'http://localhost:5173',
    credentials: true,
  });

  // Auto-validate & transform all incoming request bodies against DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,       // strip unknown properties
      forbidNonWhitelisted: false,
      transform: true,       // auto-transform payloads to DTO class instances
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`🚀 CIPHER-QUORUM auth server running on port ${port}`);
}

bootstrap();


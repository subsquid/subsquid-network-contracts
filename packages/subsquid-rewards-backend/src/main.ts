import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { initializeLogger, nestJsLogger } from './common/logger';
import { contextMiddleware } from './common/context.middleware';

async function bootstrap() {
  initializeLogger('subsquid-rewards-backend');

  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  app.useLogger(nestJsLogger);
  app.use(contextMiddleware);

  await app.listen(process.env.PORT ?? 3001);
}

bootstrap();

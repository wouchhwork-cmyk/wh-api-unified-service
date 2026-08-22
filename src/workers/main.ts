import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkersModule } from './workers.module';

/**
 * The worker entrypoint. Same image as the API, different CMD.
 *
 * createApplicationContext, not create(): this process listens on no port. It
 * exists to claim ledger rows and run scheduled sweeps.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkersModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // Graceful shutdown: the pollers stop claiming and finish the batch in flight,
  // so SIGTERM does not abandon leases that then have to lapse.
  app.enableShutdownHooks();

  const logger = app.get(Logger);
  logger.log('workers ready');
}

void bootstrap();

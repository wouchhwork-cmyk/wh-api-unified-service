import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { loadConfiguration } from './configuration';

/**
 * Global so no feature module has to import it to read config.
 *
 * No `envFilePath` here: the environment is populated before the process starts
 * — by VS Code's `envFile`, by docker-compose's `env_file`, or by the deployment
 * platform. That keeps ONE loading rule for all three environments, rather than
 * a file in dev and something else in prod (backend-design.md §4.1).
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Validation lives in loadConfiguration(); by the time this returns, the
      // configuration is known-good or the process has already thrown.
      load: [() => ({ config: loadConfiguration() })],
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}

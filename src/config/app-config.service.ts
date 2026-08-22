import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AppConfig,
  AuthConfig,
  Configuration,
  CryptoConfig,
  DatabaseConfig,
  MetaConfig,
  OtpConfig,
  PlatformAdminConfig,
  VerificationKindConfig,
  WorkerConfig,
} from './config.types';
import type { VerificationKind } from '@/shared/enums';

/**
 * A typed façade over ConfigService, so call sites get `config.meta.appId`
 * rather than a stringly-typed `get('meta.appId')` that no compiler checks.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<{ config: Configuration }, true>) {}

  private get all(): Configuration {
    return this.config.get('config', { infer: true });
  }

  get app(): AppConfig {
    return this.all.app;
  }
  get database(): DatabaseConfig {
    return this.all.database;
  }
  get auth(): AuthConfig {
    return this.all.auth;
  }
  get crypto(): CryptoConfig {
    return this.all.crypto;
  }
  get worker(): WorkerConfig {
    return this.all.worker;
  }
  get meta(): MetaConfig {
    return this.all.meta;
  }
  get otp(): OtpConfig {
    return this.all.otp;
  }
  get platformAdmin(): PlatformAdminConfig {
    return this.all.platformAdmin;
  }

  verification(kind: VerificationKind): VerificationKindConfig {
    return this.all.verification[kind];
  }
}

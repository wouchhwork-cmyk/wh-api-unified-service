import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigModule, AppConfigService } from '@/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PermissionService } from './permission.service';
import { TokenService } from './token.service';
import { VerificationDeliveryService } from './verification-delivery.service';
import { VerificationService } from './verification.service';

@Module({
  imports: [
    AppConfigModule,
    JwtModule.registerAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.auth.accessSecret,
        // HS256 is stated explicitly: leaving the algorithm implicit is how
        // "alg: none" and confusion attacks become possible.
        signOptions: { algorithm: 'HS256' },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    PermissionService,
    VerificationService,
    VerificationDeliveryService,
  ],
  // TokenService and PermissionService are exported because the global guards
  // depend on them.
  exports: [TokenService, PermissionService, VerificationService, VerificationDeliveryService],
})
export class AuthModule {}

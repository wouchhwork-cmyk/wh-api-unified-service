import { Global, Module } from '@nestjs/common';
import { SecretHashService } from './secret-hash.service';
import { TokenCipherService } from './token-cipher.service';

/** Global: the cipher and hasher are needed by auth, connections, and workers. */
@Global()
@Module({
  providers: [TokenCipherService, SecretHashService],
  exports: [TokenCipherService, SecretHashService],
})
export class CryptoModule {}

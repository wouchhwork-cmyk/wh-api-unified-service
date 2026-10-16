import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'wouchh:rawResponse';

/**
 * Opts a route out of the response envelope.
 *
 * Exists for exactly one case: Meta's webhook verification handshake must reply
 * with the bare `hub.challenge` string as text/plain, or Meta rejects the
 * subscription. Everything else is enveloped.
 */
export const RawResponse = (): MethodDecorator => SetMetadata(RAW_RESPONSE_KEY, true);

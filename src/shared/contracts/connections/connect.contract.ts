import { z } from 'zod';
import { Provider } from '@/shared/enums';

/**
 * Which platform to connect.
 *
 * An allowlisted enum, so an unknown value is a clean 422 and never reaches a
 * registry lookup or a query. Note the deliberate gap between this and what is
 * IMPLEMENTED: `google` parses and then returns 501, because "we recognise that
 * platform but cannot connect it yet" is a different answer from "that is not a
 * platform".
 */
export const StartConnectionRequestSchema = z.object({ provider: z.enum(Provider) }).strict();

export type StartConnectionRequest = z.infer<typeof StartConnectionRequestSchema>;

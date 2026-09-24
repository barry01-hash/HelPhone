/**
 * Server-side environment variable validation using Zod.
 *
 * Validates all required server environment variables at startup.
 * Fails loudly if required variables are missing or invalid.
 */
import { z } from 'zod';

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url(),
  STELLAR_SECRET_KEY: z.string().min(56),
  STELLAR_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_KEY: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Mask a secret value for safe logging.
 * Shows first 4 and last 4 characters, masks the rest.
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
}

function validateServerEnv(): ServerEnv {
  const result = serverEnvSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    console.error('❌ Invalid server environment variables:');
    for (const [key, msgs] of Object.entries(errors)) {
      console.error(`  ${key}: ${msgs?.join(', ')}`);
    }
    throw new Error('Server environment validation failed');
  }

  return result.data;
}

export const serverEnv = validateServerEnv();

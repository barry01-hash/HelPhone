/**
 * Client-side environment variable validation using Zod.
 *
 * Validates public (non-secret) environment variables at build time.
 * Secrets should never be exposed to the client bundle.
 */
import { z } from 'zod';

const clientEnvSchema = z.object({
  VITE_STELLAR_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  VITE_SUPABASE_URL: z.string().url().optional(),
  VITE_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  VITE_MAPBOX_TOKEN: z.string().min(1).optional(),
  VITE_API_BASE_URL: z.string().url().optional(),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

function validateClientEnv(): ClientEnv {
  const result = clientEnvSchema.safeParse(import.meta.env);

  if (!result.success) {
    console.error(
      '❌ Invalid client environment variables:',
      result.error.flatten().fieldErrors
    );
    // In development, throw to fail fast; in production, use defaults
    if (import.meta.env.DEV) {
      throw new Error('Invalid client environment configuration');
    }
  }

  return result.success ? result.data : clientEnvSchema.parse({});
}

export const clientEnv = validateClientEnv();

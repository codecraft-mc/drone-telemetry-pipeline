/// <reference types="node" />
import process from "node:process";
import { z, ZodError } from "zod";

export const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

type RawEnv = {
  DATABASE_URL: string | undefined;
  REDIS_URL: string | undefined;
  NODE_ENV: string | undefined;
  LOG_LEVEL: string | undefined;
};

function readProcessEnv(): RawEnv {
  return {
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    NODE_ENV: process.env.NODE_ENV,
    LOG_LEVEL: process.env.LOG_LEVEL,
  };
}

export function parseEnv(source: RawEnv = readProcessEnv()): Env {
  try {
    return EnvSchema.parse(source);
  } catch (e) {
    if (e instanceof ZodError) {
      process.stderr.write("Invalid environment configuration\n");
      const { formErrors, fieldErrors } = e.flatten();
      for (const msg of formErrors) {
        process.stderr.write(`${msg}\n`);
      }
      for (const [field, messages] of Object.entries(fieldErrors)) {
        if (Array.isArray(messages) && messages.length > 0) {
          process.stderr.write(`${field}: ${messages.join(", ")}\n`);
        }
      }
      process.exit(1);
    }
    throw e;
  }
}

export const env = parseEnv();

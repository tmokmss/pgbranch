import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { parseDuration } from './duration.js';
import { validatePrefix } from './names.js';

export const DEFAULT_CONFIG_FILE = 'pgbranch.json';

const strategySchema = z.enum(['template', 'dump']);
const driverSchema = z.enum(['pg', 'data-api']);

/** Schema of `pgbranch.json`. */
export const fileConfigSchema = z
  .object({
    prefix: z.string().optional(),
    maintenanceDatabase: z.string().min(1).optional(),
    strategy: strategySchema.optional(),
    driver: driverSchema.optional(),
    hooks: z
      .object({
        migrate: z.string().optional(),
        seed: z.string().optional(),
      })
      .strict()
      .optional(),
    gc: z.object({ ttl: z.string().optional() }).strict().optional(),
    appUrl: z.string().optional(),
    dataApi: z
      .object({
        resourceArn: z.string().optional(),
        secretArn: z.string().optional(),
        region: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type FileConfig = z.infer<typeof fileConfigSchema>;

export type Strategy = z.infer<typeof strategySchema>;
export type DriverKind = z.infer<typeof driverSchema>;

export interface ResolvedConfig {
  prefix: string;
  maintenanceDatabase: string;
  strategy: Strategy;
  driver: DriverKind;
  hooks: { migrate?: string; seed?: string };
  gc: { ttl: string };
  appUrl?: string;
  /** Only for driver "pg". */
  adminUrl?: string;
  /** Only for driver "data-api". */
  dataApi?: { resourceArn: string; secretArn: string; region?: string };
  /** Hooks run here. The directory of the config file, or the cwd. */
  rootDir: string;
  /** Path of the config file that was loaded, if any. */
  configPath?: string;
}

/** Values given on the command line. They win over env vars and the file. */
export interface ConfigOverrides {
  config?: string;
  adminUrl?: string;
  prefix?: string;
  maintenanceDatabase?: string;
  strategy?: string;
  driver?: string;
  migrateHook?: string;
  seedHook?: string;
  gcTtl?: string;
  appUrl?: string;
  resourceArn?: string;
  secretArn?: string;
  region?: string;
}

/** Env var names for every field. */
export const ENV_VARS = {
  config: 'PGBRANCH_CONFIG',
  adminUrl: 'PGBRANCH_ADMIN_URL',
  prefix: 'PGBRANCH_PREFIX',
  maintenanceDatabase: 'PGBRANCH_MAINTENANCE_DATABASE',
  strategy: 'PGBRANCH_STRATEGY',
  driver: 'PGBRANCH_DRIVER',
  migrateHook: 'PGBRANCH_HOOKS_MIGRATE',
  seedHook: 'PGBRANCH_HOOKS_SEED',
  gcTtl: 'PGBRANCH_GC_TTL',
  appUrl: 'PGBRANCH_APP_URL',
  resourceArn: 'PGBRANCH_RESOURCE_ARN',
  secretArn: 'PGBRANCH_SECRET_ARN',
  region: 'PGBRANCH_REGION',
} as const satisfies Record<keyof ConfigOverrides, string>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function readConfigFile(path: string): FileConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Cannot read config file ${path}: ${(err as Error).message}`);
  }
  const parsed = fileConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid config file ${path}:\n${issues}`);
  }
  return parsed.data;
}

function envOverrides(env: NodeJS.ProcessEnv): ConfigOverrides {
  const out: ConfigOverrides = {};
  for (const [key, name] of Object.entries(ENV_VARS) as [keyof ConfigOverrides, string][]) {
    const value = env[name];
    if (value !== undefined && value !== '') {
      out[key] = value;
    }
  }
  return out;
}

function pick<T>(...values: (T | undefined)[]): T | undefined {
  for (const v of values) {
    if (v !== undefined) return v;
  }
  return undefined;
}

export interface LoadConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: ConfigOverrides;
}

/**
 * Load config: file < env vars < CLI flags.
 * A missing default config file is fine; a missing file given explicitly is an error.
 */
export function loadConfig(options: LoadConfigOptions = {}): ResolvedConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const cli = options.overrides ?? {};
  const fromEnv = envOverrides(env);

  const explicitPath = pick(cli.config, fromEnv.config);
  const configPath = resolve(cwd, explicitPath ?? DEFAULT_CONFIG_FILE);
  let file: FileConfig = {};
  let loadedPath: string | undefined;
  if (existsSync(configPath)) {
    file = readConfigFile(configPath);
    loadedPath = configPath;
  } else if (explicitPath !== undefined) {
    throw new ConfigError(`Config file not found: ${configPath}`);
  }

  const prefix = pick(cli.prefix, fromEnv.prefix, file.prefix);
  if (prefix === undefined) {
    throw new ConfigError(`"prefix" is required (set it in ${DEFAULT_CONFIG_FILE}, ${ENV_VARS.prefix} or --prefix)`);
  }
  try {
    validatePrefix(prefix);
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }

  const strategy = strategySchema.safeParse(pick(cli.strategy, fromEnv.strategy, file.strategy) ?? 'template');
  if (!strategy.success) {
    throw new ConfigError('"strategy" must be "template" or "dump"');
  }
  const driver = driverSchema.safeParse(pick(cli.driver, fromEnv.driver, file.driver) ?? 'pg');
  if (!driver.success) {
    throw new ConfigError('"driver" must be "pg" or "data-api"');
  }

  const ttl = pick(cli.gcTtl, fromEnv.gcTtl, file.gc?.ttl) ?? '7d';
  try {
    parseDuration(ttl);
  } catch (err) {
    throw new ConfigError(`gc.ttl: ${(err as Error).message}`);
  }

  const appUrl = pick(cli.appUrl, fromEnv.appUrl, file.appUrl);
  if (appUrl !== undefined && !appUrl.includes('{database}')) {
    throw new ConfigError('"appUrl" must contain the placeholder {database}');
  }

  const resolved: ResolvedConfig = {
    prefix,
    maintenanceDatabase: pick(cli.maintenanceDatabase, fromEnv.maintenanceDatabase, file.maintenanceDatabase) ?? 'postgres',
    strategy: strategy.data,
    driver: driver.data,
    hooks: {
      migrate: pick(cli.migrateHook, fromEnv.migrateHook, file.hooks?.migrate),
      seed: pick(cli.seedHook, fromEnv.seedHook, file.hooks?.seed),
    },
    gc: { ttl },
    appUrl,
    rootDir: loadedPath ? dirname(loadedPath) : cwd,
    configPath: loadedPath,
  };

  if (resolved.driver === 'pg') {
    const adminUrl = pick(cli.adminUrl, fromEnv.adminUrl);
    if (adminUrl === undefined) {
      throw new ConfigError(`Admin connection URL is required (set ${ENV_VARS.adminUrl} or --admin-url)`);
    }
    try {
      const u = new URL(adminUrl);
      if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
        throw new Error(`unsupported scheme ${u.protocol}`);
      }
    } catch (err) {
      throw new ConfigError(`Invalid admin URL: ${(err as Error).message}`);
    }
    resolved.adminUrl = adminUrl;
  } else {
    const resourceArn = pick(cli.resourceArn, fromEnv.resourceArn, file.dataApi?.resourceArn);
    const secretArn = pick(cli.secretArn, fromEnv.secretArn, file.dataApi?.secretArn);
    if (!resourceArn || !secretArn) {
      throw new ConfigError(
        `Driver "data-api" needs a resource ARN and a secret ARN (${ENV_VARS.resourceArn} / ${ENV_VARS.secretArn}, or dataApi in the config file)`,
      );
    }
    resolved.dataApi = { resourceArn, secretArn, region: pick(cli.region, fromEnv.region, file.dataApi?.region) };
    if (resolved.strategy === 'dump') {
      throw new ConfigError('Strategy "dump" is not supported with driver "data-api" (it needs a direct connection)');
    }
  }

  return resolved;
}

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { parseDuration } from './duration.js';
import type { DataRules } from './copy.js';
import { isManaged, validatePrefix } from './names.js';

export const DEFAULT_CONFIG_FILE = 'pgbranch.json';

const strategySchema = z.enum(['template', 'dump']);

/** Schema of `pgbranch.json`. */
export const fileConfigSchema = z
  .object({
    prefix: z.string().optional(),
    maintenanceDatabase: z.string().min(1).optional(),
    strategy: strategySchema.optional(),
    source: z.string().min(1).optional(),
    data: z.record(z.string(), z.union([z.literal(false), z.string().min(1)])).optional(),
    hooks: z
      .object({
        migrate: z.string().optional(),
        seed: z.string().optional(),
      })
      .strict()
      .optional(),
    gc: z.object({ ttl: z.string().optional() }).strict().optional(),
    appUrl: z.string().optional(),
  })
  .strict();

export type FileConfig = z.infer<typeof fileConfigSchema>;

export type Strategy = z.infer<typeof strategySchema>;

export interface ResolvedConfig {
  prefix: string;
  maintenanceDatabase: string;
  strategy: Strategy;
  /** Live database that `create` copies, instead of the template. It is only read. */
  source?: string;
  /** Rows to copy from `source`, per `schema.table`: `false` for none, or a WHERE condition. */
  data: DataRules;
  hooks: { migrate?: string; seed?: string };
  gc: { ttl: string };
  appUrl?: string;
  adminUrl: string;
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
  source?: string;
  migrateHook?: string;
  seedHook?: string;
  gcTtl?: string;
  appUrl?: string;
}

/** Env var names for every field. */
export const ENV_VARS = {
  config: 'PGBRANCH_CONFIG',
  adminUrl: 'PGBRANCH_ADMIN_URL',
  prefix: 'PGBRANCH_PREFIX',
  maintenanceDatabase: 'PGBRANCH_MAINTENANCE_DATABASE',
  strategy: 'PGBRANCH_STRATEGY',
  source: 'PGBRANCH_SOURCE',
  migrateHook: 'PGBRANCH_HOOKS_MIGRATE',
  seedHook: 'PGBRANCH_HOOKS_SEED',
  gcTtl: 'PGBRANCH_GC_TTL',
  appUrl: 'PGBRANCH_APP_URL',
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

  const ttl = pick(cli.gcTtl, fromEnv.gcTtl, file.gc?.ttl) ?? '7d';
  try {
    parseDuration(ttl);
  } catch (err) {
    throw new ConfigError(`gc.ttl: ${(err as Error).message}`);
  }

  const source = pick(cli.source, fromEnv.source, file.source);
  if (source !== undefined && isManaged(prefix, source)) {
    throw new ConfigError(`"source" must not be a database pgbranch manages (${source})`);
  }
  const data = file.data ?? {};
  if (source === undefined && Object.keys(data).length > 0) {
    throw new ConfigError('"data" needs "source"');
  }
  for (const key of Object.keys(data)) {
    if (!/^[^.]+\.[^.]+$/.test(key)) throw new ConfigError(`"data" key must be "schema.table": ${key}`);
  }

  const appUrl = pick(cli.appUrl, fromEnv.appUrl, file.appUrl);
  if (appUrl !== undefined && !appUrl.includes('{database}')) {
    throw new ConfigError('"appUrl" must contain the placeholder {database}');
  }

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

  return {
    prefix,
    maintenanceDatabase: pick(cli.maintenanceDatabase, fromEnv.maintenanceDatabase, file.maintenanceDatabase) ?? 'postgres',
    strategy: strategy.data,
    source,
    data,
    hooks: {
      migrate: pick(cli.migrateHook, fromEnv.migrateHook, file.hooks?.migrate),
      seed: pick(cli.seedHook, fromEnv.seedHook, file.hooks?.seed),
    },
    gc: { ttl },
    appUrl,
    adminUrl,
    rootDir: loadedPath ? dirname(loadedPath) : cwd,
    configPath: loadedPath,
  };
}

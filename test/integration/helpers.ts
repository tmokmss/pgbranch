import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { ResolvedConfig } from '../../src/config.js';
import { PgDriver } from '../../src/driver/pg.js';
import { PgBranch, type PgBranchOptions } from '../../src/pgbranch.js';
import { withDatabase } from '../../src/url.js';

/**
 * Superuser URL used only to set up the test role and to inspect results.
 * Integration tests are skipped if it is not set.
 */
export const SUPER_URL = process.env.PGBRANCH_TEST_URL;
export const enabled = SUPER_URL !== undefined && SUPER_URL !== '';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SQL_HOOK = join(ROOT, 'test', 'fixtures', 'sql.mjs');

/** Shell command for a hook that runs the given SQL statements. */
export function sqlHook(...statements: string[]): string {
  return ['node', JSON.stringify(SQL_HOOK), ...statements.map((s) => `'${s.replace(/'/g, `'\\''`)}'`)].join(' ');
}

export const ROLE = 'pgbranch_it';
const ROLE_PASSWORD = 'pgbranch_it_pw';

/** Admin URL for a role with only CREATEDB (no superuser), like on Aurora. */
export function adminUrl(): string {
  const u = new URL(SUPER_URL!);
  u.username = ROLE;
  u.password = ROLE_PASSWORD;
  return u.toString();
}

export async function superQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  database?: string,
): Promise<T[]> {
  const client = new pg.Client({ connectionString: database ? withDatabase(SUPER_URL!, database) : SUPER_URL });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

export const APP_ROLE = 'pgbranch_it_app';

async function createRole(name: string, options: string): Promise<void> {
  const exists = await superQuery('select 1 from pg_roles where rolname = $1', [name]);
  if (exists.length > 0) return;
  try {
    await superQuery(`create role ${name} ${options}`);
  } catch (err) {
    // Another test file created it at the same time.
    const code = (err as { code?: string }).code;
    if (code !== '42710' && code !== '23505') throw err;
  }
}

/**
 * Admin role: CREATEDB + pg_signal_backend (like rds_superuser has), no superuser.
 * App role: a plain login role, used to hold connections open.
 */
export async function ensureRole(): Promise<void> {
  await createRole(ROLE, `login createdb password '${ROLE_PASSWORD}'`);
  await createRole(APP_ROLE, `login password '${ROLE_PASSWORD}'`);
  await superQuery(`grant pg_signal_backend to ${ROLE}`);
}

/** URL for the plain app role. */
export function appRoleUrl(database: string): string {
  const u = new URL(SUPER_URL!);
  u.username = APP_ROLE;
  u.password = ROLE_PASSWORD;
  u.pathname = `/${database}`;
  return u.toString();
}

export function uniquePrefix(name: string): string {
  return `it_${name}_${randomBytes(3).toString('hex')}`;
}

export async function dropAllWithPrefix(prefix: string): Promise<void> {
  const rows = await superQuery<{ datname: string }>(
    'select datname from pg_database where left(datname, length($1)) = $1',
    [`${prefix}_`],
  );
  for (const { datname } of rows) {
    await superQuery(`alter database "${datname}" with is_template false`);
    await superQuery(`drop database "${datname}" with (force)`);
  }
}

export async function databases(prefix: string): Promise<string[]> {
  const rows = await superQuery<{ datname: string }>(
    'select datname from pg_database where left(datname, length($1)) = $1 order by datname',
    [`${prefix}_`],
  );
  return rows.map((r) => r.datname);
}

export function makeConfig(prefix: string, extra: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    prefix,
    maintenanceDatabase: 'postgres',
    strategy: 'template',
    driver: 'pg',
    hooks: {},
    gc: { ttl: '7d' },
    adminUrl: adminUrl(),
    rootDir: ROOT,
    ...extra,
  };
}

/** Make a PgBranch with its own connection. Call `close` when done. */
export function makeApp(config: ResolvedConfig, options: Partial<PgBranchOptions> = {}) {
  const driver = new PgDriver(config.adminUrl!, config.maintenanceDatabase);
  const app = new PgBranch({ config, driver, lockTimeoutMs: 120_000, ...options });
  return { app, close: () => driver.close() };
}

export async function withApp<T>(
  config: ResolvedConfig,
  fn: (app: PgBranch) => Promise<T>,
  options: Partial<PgBranchOptions> = {},
): Promise<T> {
  const { app, close } = makeApp(config, options);
  try {
    return await fn(app);
  } finally {
    await close();
  }
}

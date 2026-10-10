#!/usr/bin/env node
// Manual test for the RDS Data API driver. Run it against a real Aurora PostgreSQL
// cluster with the Data API turned on. It answers the open questions in NOTES.md:
//   1. Does ExecuteStatement (no transactionId) run CREATE / ALTER / DROP DATABASE?
//   2. Does an advisory lock taken inside a Data API transaction block other callers?
//   3. Does the full pgbranch flow work (template refresh, create, list, delete)?
//
// Usage:
//   npm run build
//   PGBRANCH_RESOURCE_ARN=arn:aws:rds:...:cluster:xxx \
//   PGBRANCH_SECRET_ARN=arn:aws:secretsmanager:...:secret:xxx \
//   AWS_REGION=ap-northeast-1 \
//   node scripts/data-api-smoke.mjs
//
// It only creates and drops databases whose name starts with "pgbranch_smoke_".
// The secret's user needs CREATEDB.

import { DataApiDriver, PgBranch } from '../dist/index.js';

const resourceArn = process.env.PGBRANCH_RESOURCE_ARN;
const secretArn = process.env.PGBRANCH_SECRET_ARN;
const maintenanceDatabase = process.env.PGBRANCH_MAINTENANCE_DATABASE ?? 'postgres';
if (!resourceArn || !secretArn) {
  console.error('Set PGBRANCH_RESOURCE_ARN and PGBRANCH_SECRET_ARN');
  process.exit(2);
}

const prefix = 'pgbranch_smoke';
const db = `${prefix}_raw`;
const copy = `${prefix}_raw_copy`;
const renamed = `${prefix}_raw_renamed`;

const driver = new DataApiDriver({ resourceArn, secretArn, maintenanceDatabase, region: process.env.AWS_REGION });
const other = new DataApiDriver({ resourceArn, secretArn, maintenanceDatabase, region: process.env.AWS_REGION });

let failed = 0;
async function step(name, fn) {
  try {
    const detail = await fn();
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
  }
}

async function cleanup() {
  for (const name of [db, copy, renamed, `${prefix}_template`, `${prefix}_template_next`, `${prefix}_template_old`, `${prefix}_br_smoke`]) {
    try {
      await driver.query(`ALTER DATABASE "${name}" WITH IS_TEMPLATE false`);
    } catch {}
    try {
      await driver.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } catch {}
  }
}

await cleanup();

console.log('--- Q1: database DDL through ExecuteStatement without a transaction');
await step('CREATE DATABASE', () => driver.query(`CREATE DATABASE "${db}"`));
await step('COMMENT ON DATABASE', () => driver.query(`COMMENT ON DATABASE "${db}" IS E'{"pgbranch":1}'`));
await step('read comment back', async () => {
  const rows = await driver.query(`select shobj_description(oid, 'pg_database') as c from pg_database where datname = $1`, [db]);
  if (rows[0]?.c !== '{"pgbranch":1}') throw new Error(`got ${JSON.stringify(rows)}`);
});
await step('ALTER DATABASE ... IS_TEMPLATE true ALLOW_CONNECTIONS false', () =>
  driver.query(`ALTER DATABASE "${db}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`),
);
await step('CREATE DATABASE ... TEMPLATE', () => driver.query(`CREATE DATABASE "${copy}" TEMPLATE "${db}"`));
await step('ExecuteStatement on the new database', async () => {
  const conn = new DataApiDriver({ resourceArn, secretArn, maintenanceDatabase: copy, region: process.env.AWS_REGION });
  const rows = await conn.query('select current_database() as d');
  return `current_database = ${rows[0]?.d}`;
});
await step('pg_terminate_backend on the new database', async () => {
  const rows = await driver.query('select pid from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [copy]);
  for (const { pid } of rows) await driver.query('select pg_terminate_backend($1)', [pid]);
  return `${rows.length} sessions`;
});
await step('ALTER DATABASE ... RENAME', () => driver.query(`ALTER DATABASE "${copy}" RENAME TO "${renamed}"`));
await step('DROP DATABASE ... WITH (FORCE)', () => driver.query(`DROP DATABASE IF EXISTS "${renamed}" WITH (FORCE)`));

console.log('--- Q2: advisory lock held in a Data API transaction');
await step('first caller gets the lock', async () => {
  if (!(await driver.tryLock('pgbranch:smoke'))) throw new Error('did not get the lock');
});
await step('second caller does not get it', async () => {
  if (await other.tryLock('pgbranch:smoke')) throw new Error('second caller also got the lock');
});
await step('DDL works while the lock transaction is open', () => driver.query(`ALTER DATABASE "${db}" WITH IS_TEMPLATE false`));
await step('lock still held after 200 s idle (keepalive)', async () => {
  await new Promise((r) => setTimeout(r, 200_000));
  if (await other.tryLock('pgbranch:smoke')) throw new Error('lock was lost');
});
await step('unlock, then second caller gets it', async () => {
  await driver.unlock('pgbranch:smoke');
  if (!(await other.tryLock('pgbranch:smoke'))) throw new Error('still locked');
  await other.unlock('pgbranch:smoke');
});

console.log('--- Q3: full pgbranch flow (hooks are no-ops)');
const app = new PgBranch({
  config: {
    prefix,
    maintenanceDatabase,
    strategy: 'template',
    driver: 'data-api',
    hooks: { migrate: 'true', seed: 'true' },
    gc: { ttl: '7d' },
    dataApi: { resourceArn, secretArn, region: process.env.AWS_REGION },
    rootDir: process.cwd(),
  },
  driver,
  log: { info: (m) => console.log(`      ${m}`), warn: (m) => console.log(`      warning: ${m}`) },
});
await step('template refresh (from empty)', async () => JSON.stringify(await app.templateRefresh()).slice(0, 80));
await step('template refresh (update)', async () => JSON.stringify(await app.templateRefresh()).slice(0, 80));
await step('create', async () => (await app.create('smoke')).database);
await step('list', async () => JSON.stringify(await app.list()));
await step('reset', async () => (await app.reset('smoke')).database);
await step('delete', async () => String((await app.delete('smoke')).deleted));

await cleanup();
await driver.close();
await other.close();
console.log(failed === 0 ? '\nAll steps passed.' : `\n${failed} step(s) failed. Please paste this output in an issue.`);
process.exitCode = failed === 0 ? 0 : 1;

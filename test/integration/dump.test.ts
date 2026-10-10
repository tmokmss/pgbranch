import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  appRoleUrl,
  databases,
  dropAllWithPrefix,
  enabled,
  ensureRole,
  makeConfig,
  sqlHook,
  superQuery,
  uniquePrefix,
  withApp,
  SUPER_URL,
} from './helpers.js';

/** pg_dump must be the same major version as the server, or newer. */
async function dumpToolsUsable(): Promise<boolean> {
  if (!enabled) return false;
  let tool: number;
  try {
    const out = execFileSync('pg_dump', ['--version'], { encoding: 'utf8' });
    tool = Number(/(\d+)(?:\.\d+)?/.exec(out)?.[1]);
  } catch {
    return false;
  }
  const client = new pg.Client({ connectionString: SUPER_URL });
  await client.connect();
  const server = Number((await client.query('show server_version_num')).rows[0].server_version_num) / 10000;
  await client.end();
  return tool >= Math.floor(server);
}

const usable = await dumpToolsUsable();
if (enabled && !usable) {
  console.warn('Skipping dump strategy tests: pg_dump is missing or older than the server');
}

describe.skipIf(!usable)('dump strategy', () => {
  const prefix = uniquePrefix('dump');
  const config = makeConfig(prefix, {
    strategy: 'dump',
    hooks: {
      migrate: sqlHook('create table if not exists items (id int primary key)'),
      seed: sqlHook('insert into items values (1)'),
    },
  });

  beforeAll(ensureRole);
  afterAll(() => dropAllWithPrefix(prefix));

  it('refresh, create, create --from, reset, refresh again', async () => {
    await withApp(config, async (app) => {
      expect(await app.templateRefresh()).toMatchObject({ fromEmpty: true, seeded: true });

      const a = await app.create('dump-a');
      expect(await superQuery('select id from items', [], a.database)).toEqual([{ id: 1 }]);

      // A connection to the source does not block the dump strategy and is not terminated.
      await superQuery('insert into items values (2)', [], a.database);
      const holder = new pg.Client({ connectionString: appRoleUrl(a.database) });
      await holder.connect();
      const b = await app.create('dump-b', { from: 'dump-a' });
      expect(await superQuery('select id from items order by id', [], b.database)).toEqual([{ id: 1 }, { id: 2 }]);
      await holder.query('select 1');
      await holder.end();

      await app.reset('dump-a');
      expect(await superQuery('select id from items', [], a.database)).toEqual([{ id: 1 }]);

      expect(await app.templateRefresh()).toMatchObject({ fromEmpty: false });
    });

    // The template is locked again after dumping it.
    const rows = await superQuery('select datistemplate, datallowconn from pg_database where datname = $1', [`${prefix}_template`]);
    expect(rows).toEqual([{ datistemplate: true, datallowconn: false }]);
    expect(await databases(prefix)).toEqual([`${prefix}_br_dump_a`, `${prefix}_br_dump_b`, `${prefix}_template`]);
  });

  it('drops the new DB when restore or migrate fails', async () => {
    const failing = makeConfig(prefix, { strategy: 'dump', hooks: { migrate: 'exit 1' } });
    await withApp(failing, async (app) => {
      await expect(app.create('dump-broken')).rejects.toThrow(/Hook "migrate" failed/);
    });
    expect(await databases(prefix)).not.toContain(`${prefix}_br_dump_broken`);
  });
});

describe.skipIf(!enabled)('dump strategy without tools', () => {
  it('gives a clear error when pg_dump is not in PATH', async () => {
    const prefix = uniquePrefix('notool');
    const path = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      await withApp(makeConfig(prefix, { strategy: 'dump' }), async (app) => {
        await expect(app.create('x')).rejects.toThrow(/"pg_dump" was not found in PATH/);
      });
    } finally {
      process.env.PATH = path;
    }
    expect(await databases(prefix)).toEqual([]);
  });
});

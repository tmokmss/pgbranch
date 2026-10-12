import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { withDatabase } from '../../src/url.js';
import {
  APP_ROLE,
  appRoleUrl,
  ROLE,
  databases,
  dropAllWithPrefix,
  enabled,
  makeApp,
  makeConfig,
  sqlHook,
  superQuery,
  uniquePrefix,
  withApp,
  SUPER_URL,
} from './helpers.js';

async function columns(database: string): Promise<string[]> {
  const rows = await superQuery<{ column_name: string }>(
    `select column_name from information_schema.columns where table_name = 'items' order by ordinal_position`,
    [],
    database,
  );
  return rows.map((r) => r.column_name);
}

describe.skipIf(!enabled)('template refresh', () => {
  const prefix = uniquePrefix('tmpl');
  const v1 = makeConfig(prefix, {
    hooks: { migrate: sqlHook('create table if not exists items (id int)'), seed: sqlHook('insert into items values (1)') },
  });
  const v2 = makeConfig(prefix, {
    hooks: {
      migrate: sqlHook('create table if not exists items (id int)', 'alter table items add column if not exists v2 int'),
      seed: sqlHook('insert into items values (99)'),
    },
  });

  afterAll(() => dropAllWithPrefix(prefix));

  it('builds from empty, then updates from the old template without seeding again', async () => {
    const first = await withApp(v1, (app) => app.templateRefresh());
    expect(first).toMatchObject({ fromEmpty: true, migrated: true, seeded: true });

    const second = await withApp(v2, (app) => app.templateRefresh());
    expect(second).toMatchObject({ fromEmpty: false, migrated: true, seeded: false });
    expect(await databases(prefix)).toEqual([`${prefix}_template`]);

    const { database } = await withApp(v2, (app) => app.create('check', { migrate: false }));
    expect(await columns(database)).toEqual(['id', 'v2']);
    expect(await superQuery('select id from items', [], database)).toEqual([{ id: 1 }]);
    await withApp(v2, (app) => app.delete('check'));
  });

  it('keeps the old template when the migrate hook fails', async () => {
    const broken = makeConfig(prefix, { hooks: { migrate: sqlHook('alter table items add column v3 int', 'select broken from nowhere') } });
    await withApp(broken, async (app) => {
      await expect(app.templateRefresh()).rejects.toThrow(/Hook "migrate" failed/);
    });
    expect(await databases(prefix)).toEqual([`${prefix}_template`]);
    const rows = await superQuery<{ datistemplate: boolean; datallowconn: boolean }>(
      'select datistemplate, datallowconn from pg_database where datname = $1',
      [`${prefix}_template`],
    );
    expect(rows).toEqual([{ datistemplate: true, datallowconn: false }]);

    const { database } = await withApp(v2, (app) => app.create('after-fail', { migrate: false }));
    expect(await columns(database)).toEqual(['id', 'v2']);
    await withApp(v2, (app) => app.delete('after-fail'));
  });

  it('cleans up leftovers and recovers a template lost in a half-done swap', async () => {
    // Simulate a crash after "rename template -> template_old".
    await superQuery(`alter database "${prefix}_template" rename to "${prefix}_template_old"`);
    await superQuery(`create database "${prefix}_template_next" owner pgbranch_it`);
    const result = await withApp(v2, (app) => app.templateRefresh());
    expect(result.fromEmpty).toBe(false);
    expect(await databases(prefix)).toEqual([`${prefix}_template`]);
    const { database } = await withApp(v2, (app) => app.create('recovered', { migrate: false }));
    expect(await superQuery('select id from items', [], database)).toEqual([{ id: 1 }]);
    await withApp(v2, (app) => app.delete('recovered'));
  });

  it('nobody can connect to the template, and create still works', async () => {
    for (const url of [appRoleUrl(`${prefix}_template`), withDatabase(SUPER_URL!, `${prefix}_template`)]) {
      const client = new pg.Client({ connectionString: url });
      await expect(client.connect()).rejects.toThrow(/not currently accepting connections/);
    }
    // Someone is connected to template1 and to a branch DB. Neither matters.
    const created = await withApp(v2, (app) => app.create('while-connected', { migrate: false }));
    const holder = new pg.Client({ connectionString: appRoleUrl(created.database) });
    await holder.connect();
    const second = await withApp(v2, (app) => app.create('while-connected-2', { migrate: false }));
    expect(second.created).toBe(true);
    await holder.end();
    await withApp(v2, async (app) => {
      await app.delete('while-connected');
      await app.delete('while-connected-2');
    });
  });

  it('two refreshes at the same time both succeed', async () => {
    const slow = makeConfig(prefix, {
      hooks: { migrate: sqlHook('create table if not exists items (id int)', 'select pg_sleep(0.5)') },
    });
    const a = makeApp(slow);
    const b = makeApp(slow);
    try {
      const results = await Promise.all([a.app.templateRefresh(), b.app.templateRefresh()]);
      expect(results.map((r) => r.fromEmpty)).toEqual([false, false]);
    } finally {
      await a.close();
      await b.close();
    }
    expect(await databases(prefix)).toEqual([`${prefix}_template`]);
  });
});

describe.skipIf(!enabled)('template refresh from a template source', () => {
  const prefix = uniquePrefix('tsrc');
  // Not managed by pgbranch: it does not start with `${prefix}_`.
  const source = `src_${prefix}`;
  const config = makeConfig(prefix, {
    templateSource: source,
    hooks: { migrate: sqlHook('alter table items add column if not exists v2 int'), seed: sqlHook('insert into items values (99)') },
  });

  afterAll(async () => {
    await dropAllWithPrefix(prefix);
    await superQuery(`drop database if exists "${source}" with (force)`);
  });

  it('dumps the source into the template, runs migrate, and leaves the source as it was', async () => {
    await superQuery(`create database "${source}" owner pgbranch_it`);
    await superQuery('create table items (id int)', [], source);
    await superQuery('insert into items values (1)', [], source);
    await superQuery(`alter table items owner to ${ROLE}`, [], source);
    await superQuery(`grant select on items to ${APP_ROLE}`, [], source);
    const holder = new pg.Client({ connectionString: appRoleUrl(source) });
    await holder.connect();
    try {
      const first = await withApp(config, (app) => app.templateRefresh());
      expect(first).toMatchObject({ fromEmpty: false, migrated: true, seeded: false });

      await superQuery('insert into items values (2)', [], source);
      await withApp(config, (app) => app.templateRefresh());
      expect(await databases(prefix)).toEqual([`${prefix}_template`]);

      const { database } = await withApp(config, (app) => app.create('check', { migrate: false }));
      expect(await columns(database)).toEqual(['id', 'v2']);
      expect(await superQuery('select id from items order by id', [], database)).toEqual([{ id: 1 }, { id: 2 }]);

      expect(await holder.query('select id from items order by id')).toMatchObject({ rows: [{ id: 1 }, { id: 2 }] });
      expect(await columns(source)).toEqual(['id']);
      const rows = await superQuery<{ datistemplate: boolean; datallowconn: boolean }>(
        'select datistemplate, datallowconn from pg_database where datname = $1',
        [source],
      );
      expect(rows).toEqual([{ datistemplate: false, datallowconn: true }]);
    } finally {
      await holder.end();
    }
  });

  it('fails without touching the template when the source does not exist', async () => {
    const before = await databases(prefix);
    const missing = makeConfig(prefix, { templateSource: `missing_${prefix}` });
    await withApp(missing, async (app) => {
      await expect(app.templateRefresh()).rejects.toThrow(/does not exist/);
    });
    expect(await databases(prefix)).toEqual(before);
  });
});

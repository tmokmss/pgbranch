import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { withDatabase } from '../../src/url.js';
import {
  adminUrl,
  databases,
  dropAllWithPrefix,
  enabled,
  ensureRole,
  makeConfig,
  sqlHook,
  superQuery,
  uniquePrefix,
  withApp,
  appRoleUrl,
} from './helpers.js';

describe.skipIf(!enabled)('branch lifecycle', () => {
  const prefix = uniquePrefix('life');
  const config = makeConfig(prefix, {
    hooks: {
      migrate: sqlHook('create table if not exists items (id int primary key, name text)'),
      seed: sqlHook(`insert into items values (1, 'seed')`),
    },
  });

  beforeAll(async () => {
    await ensureRole();
    await withApp(config, (app) => app.templateRefresh());
  });

  afterAll(async () => {
    await dropAllWithPrefix(prefix);
  });

  it('builds the template from empty with migrate and seed', async () => {
    const rows = await superQuery<{ datistemplate: boolean; datallowconn: boolean }>(
      'select datistemplate, datallowconn from pg_database where datname = $1',
      [`${prefix}_template`],
    );
    expect(rows).toEqual([{ datistemplate: true, datallowconn: false }]);
    expect(await databases(prefix)).toEqual([`${prefix}_template`]);
  });

  it('create / list / url / reset / delete', async () => {
    await withApp(config, async (app) => {
      const created = await app.create('feature/Life-1');
      expect(created).toMatchObject({
        branch: 'feature/Life-1',
        database: `${prefix}_br_feature_life_1`,
        created: true,
        migrated: true,
        source: 'template',
      });
      expect(created.url).toBe(withDatabase(adminUrl(), created.database));

      // Seed data came from the template.
      expect(await superQuery('select id, name from items', [], created.database)).toEqual([{ id: 1, name: 'seed' }]);

      // The app URL works.
      const client = new pg.Client({ connectionString: created.url });
      await client.connect();
      await client.query(`insert into items values (2, 'branch')`);
      await client.end();

      const list = await app.list();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ branch: 'feature/Life-1', database: created.database, source: 'template' });
      expect(list[0].sizeBytes).toBeGreaterThan(0);
      expect(Date.parse(list[0].createdAt!)).toBeGreaterThan(Date.now() - 60_000);

      expect(await app.url('feature/Life-1')).toEqual({ branch: 'feature/Life-1', database: created.database, url: created.url });

      // Reset drops the branch change.
      const reset = await app.reset('feature/Life-1');
      expect(reset.created).toBe(true);
      expect(await superQuery('select id from items order by id', [], created.database)).toEqual([{ id: 1 }]);

      expect(await app.delete('feature/Life-1')).toMatchObject({ deleted: true });
      expect(await app.list()).toEqual([]);
      await expect(app.delete('feature/Life-1')).rejects.toThrow(/does not exist/);
      expect(await app.delete('feature/Life-1', { ifExists: true })).toMatchObject({ deleted: false });
      await expect(app.url('feature/Life-1')).rejects.toThrow(/does not exist/);
      await expect(app.reset('feature/Life-1')).rejects.toThrow(/does not exist/);
    });
  });

  it('fails on an existing DB unless --if-not-exists, which still migrates', async () => {
    await withApp(config, async (app) => {
      await app.create('exists');
      await expect(app.create('exists')).rejects.toThrow(/already exists/);
      const again = await app.create('exists', { ifNotExists: true });
      expect(again).toMatchObject({ created: false, migrated: true });
      const noMigrate = await app.create('exists', { ifNotExists: true, migrate: false });
      expect(noMigrate).toMatchObject({ created: false, migrated: false });
      await app.delete('exists');
    });
  });

  it('applies the branch migration on top of the template', async () => {
    const branchConfig = makeConfig(prefix, {
      hooks: { migrate: sqlHook('create table if not exists items (id int primary key, name text)', 'alter table items add column if not exists extra int') },
    });
    await withApp(branchConfig, async (app) => {
      const { database } = await app.create('with-migration');
      const cols = await superQuery<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'items' order by ordinal_position`,
        [],
        database,
      );
      expect(cols.map((c) => c.column_name)).toEqual(['id', 'name', 'extra']);
      await app.delete('with-migration');
    });
  });

  it('drops the new DB when the migrate hook fails', async () => {
    const failing = makeConfig(prefix, { hooks: { migrate: sqlHook('select * from no_such_table') } });
    await withApp(failing, async (app) => {
      await expect(app.create('broken')).rejects.toThrow(/Hook "migrate" failed/);
    });
    expect(await databases(prefix)).toEqual([`${prefix}_template`]);
  });

  it('does not drop an existing DB when migrate fails with --if-not-exists', async () => {
    await withApp(config, (app) => app.create('keep-me'));
    const failing = makeConfig(prefix, { hooks: { migrate: 'exit 3' } });
    await withApp(failing, async (app) => {
      await expect(app.create('keep-me', { ifNotExists: true })).rejects.toThrow(/exit code 3/);
    });
    expect(await databases(prefix)).toContain(`${prefix}_br_keep_me`);
    await withApp(config, (app) => app.delete('keep-me'));
  });

  it('creates from another branch even with an open connection to it', async () => {
    await withApp(config, async (app) => {
      const parent = await app.create('parent');
      await superQuery(`insert into items values (10, 'parent only')`, [], parent.database);

      // Someone is connected to the parent branch DB.
      const holder = new pg.Client({ connectionString: appRoleUrl(parent.database) });
      holder.on('error', () => {});
      await holder.connect();

      const child = await app.create('child', { from: 'parent' });
      expect(child.source).toBe('branch:parent');
      expect(await superQuery('select id from items order by id', [], child.database)).toEqual([{ id: 1 }, { id: 10 }]);
      await holder.end().catch(() => {});

      // Reset uses the same source.
      await superQuery(`insert into items values (11, 'child only')`, [], child.database);
      await app.reset('child');
      expect(await superQuery('select id from items order by id', [], child.database)).toEqual([{ id: 1 }, { id: 10 }]);

      await expect(app.create('ghost-child', { from: 'no-such-branch' })).rejects.toThrow(/has no database/);
      await app.delete('child');
      await app.delete('parent');
    });
  });

  it('refuses a DB that belongs to a different branch after sanitizing', async () => {
    await withApp(config, async (app) => {
      await app.create('feature/same');
      await expect(app.create('feature-same', { ifNotExists: true })).rejects.toThrow(/belongs to branch "feature\/same"/);
      await expect(app.delete('feature-same')).rejects.toThrow(/belongs to branch/);
      await app.delete('feature/same');
    });
  });

  it('gc drops old branch DBs and keeps the rest', async () => {
    await withApp(config, async (app) => {
      await app.create('old-1');
      await app.create('old-2');
      await app.create('pinned');
    });
    // A DB with the branch prefix but no metadata is skipped.
    await superQuery(`create database "${prefix}_br_manual" owner pgbranch_it`);

    const later = () => new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);

    const dry = await withApp(config, (app) => app.gc({ keep: ['pinned'] }), { now: later, dryRun: true });
    expect(dry.dropped.map((e) => e.branch).sort()).toEqual(['old-1', 'old-2']);
    expect((await databases(prefix)).length).toBe(5);

    const notYet = await withApp(config, (app) => app.gc({ keep: ['pinned'] }));
    expect(notYet.dropped).toEqual([]);

    const result = await withApp(config, (app) => app.gc({ keep: ['pinned'] }), { now: later });
    expect(result.dropped.map((e) => e.branch).sort()).toEqual(['old-1', 'old-2']);
    expect(result.kept.map((e) => e.branch)).toEqual(['pinned']);
    expect(result.skipped.map((e) => e.database)).toEqual([`${prefix}_br_manual`]);
    expect(await databases(prefix)).toEqual([`${prefix}_br_manual`, `${prefix}_br_pinned`, `${prefix}_template`]);

    const short = await withApp(config, (app) => app.gc({ ttl: '0s' }));
    expect(short.dropped.map((e) => e.branch)).toEqual(['pinned']);
    await superQuery(`drop database "${prefix}_br_manual"`);
  });

  it('dry-run changes nothing', async () => {
    const before = await databases(prefix);
    const result = await withApp(config, (app) => app.create('dry'), { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.actions[0]).toBe(`CREATE DATABASE "${prefix}_br_dry" TEMPLATE "${prefix}_template"`);
    expect(result.actions.some((a) => a.startsWith('run migrate hook'))).toBe(true);
    await withApp(config, (app) => app.templateRefresh(), { dryRun: true });
    expect(await databases(prefix)).toEqual(before);
  });

  it('fails clearly when the template is missing', async () => {
    const other = makeConfig(uniquePrefix('none'));
    await withApp(other, async (app) => {
      await expect(app.create('x')).rejects.toThrow(/template refresh/);
    });
  });
});

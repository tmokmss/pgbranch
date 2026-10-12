import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { DataRules } from '../../src/copy.js';
import {
  APP_ROLE,
  appRoleUrl,
  databases,
  dropAllWithPrefix,
  enabled,
  makeConfig,
  ROLE,
  superQuery,
  uniquePrefix,
  withApp,
} from './helpers.js';

describe.skipIf(!enabled)('create from a live source database', () => {
  const prefix = uniquePrefix('src');
  // Not managed by pgbranch: it does not start with `${prefix}_`.
  const source = `src_${prefix}`;
  const owner = `${prefix}_owner`;
  const config = makeConfig(prefix, {
    source,
    data: {
      'app.logs': false,
      'app.runs': "created_at >= '2026-01-01'",
      'app.nodes': 'id <> 2',
    },
  });
  let holder: pg.Client;

  const count = async (database: string, table: string) =>
    (await superQuery<{ n: number }>(`select count(*)::int as n from app.${table}`, [], database))[0]!.n;

  beforeAll(async () => {
    // Like Aurora: the schema is owned by the admin role, the objects by a role the admin is a member of.
    await superQuery(`create role ${owner}`);
    await superQuery(`grant ${owner} to ${ROLE}`);
    await superQuery(`create database "${source}" owner ${ROLE}`);
    await superQuery(`create schema app authorization ${ROLE}`, [], source);
    await superQuery(`grant usage, create on schema app to ${owner}`, [], source);
    await superQuery(`grant usage on schema app to ${APP_ROLE}`, [], source);
    await superQuery(
      `set role ${owner};
       create table app.tenants (id int primary key, name text not null);
       create table app.runs (id int generated always as identity primary key, tenant_id int not null references app.tenants, created_at date not null);
       create index runs_created_at_idx on app.runs (created_at);
       create table app.results (id serial primary key, run_id int not null references app.runs, doubled int generated always as (id * 2) stored);
       create table app.logs (id int primary key, run_id int not null references app.runs);
       create table app.comments (id int primary key, run_id int not null references app.runs, log_id int references app.logs);
       create table app.nodes (id int primary key, parent_id int references app.nodes);
       alter table app.results enable row level security;
       create policy tenant_results on app.results using (run_id > 0);
       insert into app.tenants values (1, 'a'), (2, 'b');
       insert into app.runs (tenant_id, created_at) values (1, '2025-06-01'), (1, '2026-02-01'), (2, '2026-03-01');
       insert into app.results (run_id) values (1), (2), (3), (3);
       insert into app.logs values (1, 2), (2, 3);
       insert into app.comments values (1, 2, null), (2, 2, 1), (3, 1, null), (4, 3, null);
       insert into app.nodes values (1, null), (2, 1), (3, 2), (4, 3), (5, 1);
       grant select on app.tenants to ${APP_ROLE};`,
      [],
      source,
    );
    holder = new pg.Client({ connectionString: appRoleUrl(source) });
    await holder.connect();
  });

  afterAll(async () => {
    await holder?.end();
    await dropAllWithPrefix(prefix);
    await superQuery(`drop database if exists "${source}" with (force)`);
    await superQuery(`drop role if exists ${owner}`);
  });

  it('copies the rows the rules allow and deletes rows whose parent was not copied', async () => {
    const result = await withApp(config, (app) => app.create('feature/a'));
    expect(result).toMatchObject({ created: true, source: `database:${source}` });
    const db = result.database;

    expect(await count(db, 'tenants')).toBe(2);
    expect(await superQuery('select id from app.runs order by id', [], db)).toEqual([{ id: 2 }, { id: 3 }]);
    expect(await superQuery('select id, run_id, doubled from app.results order by id', [], db)).toEqual([
      { id: 2, run_id: 2, doubled: 4 },
      { id: 3, run_id: 3, doubled: 6 },
      { id: 4, run_id: 3, doubled: 8 },
    ]);
    expect(await count(db, 'logs')).toBe(0);
    // Comment 2 lost its log, comment 3 lost its run.
    expect(await superQuery('select id from app.comments order by id', [], db)).toEqual([{ id: 1 }, { id: 4 }]);
    // Node 2 is filtered out, so 3 and then 4 lose their parent. 5 hangs off 1 and stays.
    expect(await superQuery('select id from app.nodes order by id', [], db)).toEqual([{ id: 1 }, { id: 5 }]);
  });

  it('creates indexes, constraints and policies after the data, and keeps owners and grants', async () => {
    const db = `${prefix}_br_feature_a`;
    const constraints = await superQuery<{ conname: string; convalidated: boolean }>(
      `select conname, convalidated from pg_constraint where connamespace = 'app'::regnamespace and contype = 'f' order by conname`,
      [],
      db,
    );
    expect(constraints).toHaveLength(6);
    expect(constraints.every((c) => c.convalidated)).toBe(true);
    expect(await superQuery(`select indexname from pg_indexes where indexname = 'runs_created_at_idx'`, [], db)).toHaveLength(1);
    expect(await superQuery(`select relrowsecurity from pg_class where oid = 'app.results'::regclass`, [], db)).toEqual([
      { relrowsecurity: true },
    ]);
    expect(await superQuery(`select policyname from pg_policies where schemaname = 'app'`, [], db)).toEqual([
      { policyname: 'tenant_results' },
    ]);
    const owners = await superQuery<{ owner: string }>(
      `select distinct pg_get_userbyid(relowner) as owner from pg_class where relnamespace = 'app'::regnamespace and relkind = 'r'`,
      [],
      db,
    );
    expect(owners).toEqual([{ owner }]);
    const app = new pg.Client({ connectionString: appRoleUrl(db) });
    await app.connect();
    try {
      expect((await app.query('select count(*)::int as n from app.tenants')).rows).toEqual([{ n: 2 }]);
    } finally {
      await app.end();
    }
  });

  it('continues sequences and identity columns after the copied values', async () => {
    const db = `${prefix}_br_feature_a`;
    expect(await superQuery(`insert into app.results (run_id) values (2) returning id`, [], db)).toEqual([{ id: 5 }]);
    expect(await superQuery(`insert into app.runs (tenant_id, created_at) values (1, '2026-04-01') returning id`, [], db)).toEqual([
      { id: 4 },
    ]);
  });

  it('leaves the source as it was, and does not end its connections', async () => {
    expect((await holder.query('select count(*)::int as n from app.tenants')).rows).toEqual([{ n: 2 }]);
    for (const [table, n] of [['runs', 3], ['results', 4], ['logs', 2], ['comments', 4], ['nodes', 5]] as const) {
      expect(await count(source, table)).toBe(n);
    }
    expect(
      await superQuery('select datistemplate, datallowconn from pg_database where datname = $1', [source]),
    ).toEqual([{ datistemplate: false, datallowconn: true }]);
  });

  it('reset copies the source again', async () => {
    await superQuery('insert into app.tenants values (3, $1)', ['c'], source);
    const result = await withApp(config, (app) => app.reset('feature/a'));
    expect(await count(result.database, 'tenants')).toBe(3);
    await superQuery('delete from app.tenants where id = 3', [], source);
  });

  it('refuses template refresh while "source" is set', async () => {
    await withApp(config, async (app) => {
      await expect(app.templateRefresh()).rejects.toThrow(/no template to refresh/);
    });
  });

  it('drops the new database when a rule names an unknown table or has a bad condition', async () => {
    const rules: DataRules[] = [{ 'app.nope': false }, { 'app.runs': 'no_such_column > 0' }];
    for (const data of rules) {
      const broken = makeConfig(prefix, { source, data });
      await withApp(broken, async (app) => {
        await expect(app.create('broken')).rejects.toThrow(/nope|no_such_column/);
      });
      expect(await databases(prefix)).toEqual([`${prefix}_br_feature_a`]);
    }
  });
});

import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RollbackTransactionCommand,
} from '@aws-sdk/client-rds-data';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedConfig } from '../../src/config.js';
import { DataApiDriver, toNamedParams, toSqlParameters, type RdsDataLike } from '../../src/driver/data-api.js';
import { PgBranch } from '../../src/pgbranch.js';

type Sent = { name: string; input: Record<string, unknown> };

const RESOURCE = 'arn:aws:rds:us-east-1:123456789012:cluster:demo';
const SECRET = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:demo';

/**
 * Mock RDS Data client with a tiny fake catalog, enough for PgBranch to run.
 * `locked` holds lock keys taken by any transaction.
 */
class MockRdsData implements RdsDataLike {
  readonly sent: Sent[] = [];
  readonly databases = new Map<string, { isTemplate: boolean; allowConn: boolean; comment: string | null }>();
  readonly lockedBy = new Map<string, string>();
  private txCounter = 0;
  failOn?: RegExp;

  async send(command: unknown): Promise<unknown> {
    const name = (command as object).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    this.sent.push({ name, input });
    if (name === 'BeginTransactionCommand') return { transactionId: `tx-${++this.txCounter}` };
    if (name === 'CommitTransactionCommand' || name === 'RollbackTransactionCommand') {
      for (const [key, tx] of this.lockedBy) if (tx === input.transactionId) this.lockedBy.delete(key);
      return { transactionStatus: 'ok' };
    }
    if (name !== 'ExecuteStatementCommand') throw new Error(`unexpected ${name}`);
    return this.execute(input);
  }

  private param(input: Record<string, unknown>, n: number): unknown {
    const params = (input.parameters ?? []) as { name: string; value: Record<string, unknown> }[];
    const value = params.find((p) => p.name === `p${n}`)?.value ?? {};
    return value.stringValue ?? value.longValue ?? value.booleanValue ?? null;
  }

  private execute(input: Record<string, unknown>) {
    const sql = input.sql as string;
    if (this.failOn?.test(sql)) throw Object.assign(new Error(`ERROR: mock failure for ${sql}`), { name: 'BadRequestException' });
    const json = (rows: unknown[]) => ({ formattedRecords: JSON.stringify(rows) });
    if (sql.includes('pg_try_advisory_xact_lock')) {
      const key = this.param(input, 1) as string;
      if (this.lockedBy.has(key)) return json([{ locked: false }]);
      this.lockedBy.set(key, input.transactionId as string);
      return json([{ locked: true }]);
    }
    if (sql.includes('from pg_database where datname = :p1')) {
      const name = this.param(input, 1) as string;
      const db = this.databases.get(name);
      return json(db ? [{ datname: name, datistemplate: db.isTemplate, datallowconn: db.allowConn, comment: db.comment }] : []);
    }
    if (sql.includes('from pg_stat_activity')) return json([]);
    if (sql.includes('where left(datname, length(:p1)) = :p1')) {
      const prefix = this.param(input, 1) as string;
      return json(
        [...this.databases]
          .filter(([name]) => name.startsWith(prefix))
          .map(([name, db]) => ({ datname: name, datistemplate: db.isTemplate, datallowconn: db.allowConn, comment: db.comment, size: '8000' })),
      );
    }
    let m: RegExpExecArray | null;
    if ((m = /^CREATE DATABASE "([^"]+)"/.exec(sql))) {
      this.databases.set(m[1], { isTemplate: false, allowConn: true, comment: null });
      return {};
    }
    if ((m = /^COMMENT ON DATABASE "([^"]+)" IS E'(.*)'$/.exec(sql))) {
      this.databases.get(m[1])!.comment = m[2].replace(/''/g, "'");
      return {};
    }
    if ((m = /^DROP DATABASE IF EXISTS "([^"]+)"/.exec(sql))) {
      this.databases.delete(m[1]);
      return {};
    }
    if ((m = /^ALTER DATABASE "([^"]+)" RENAME TO "([^"]+)"/.exec(sql))) {
      this.databases.set(m[2], this.databases.get(m[1])!);
      this.databases.delete(m[1]);
      return {};
    }
    if ((m = /^ALTER DATABASE "([^"]+)" WITH IS_TEMPLATE (true|false)( ALLOW_CONNECTIONS false)?/.exec(sql))) {
      const db = this.databases.get(m[1])!;
      db.isTemplate = m[2] === 'true';
      if (m[3]) db.allowConn = false;
      return {};
    }
    throw new Error(`mock does not know: ${sql}`);
  }

  executed(): string[] {
    return this.sent.filter((s) => s.name === 'ExecuteStatementCommand').map((s) => s.input.sql as string);
  }
}

function driverWith(client: MockRdsData, keepAliveMs?: number) {
  return new DataApiDriver({ resourceArn: RESOURCE, secretArn: SECRET, maintenanceDatabase: 'postgres', client, keepAliveMs });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parameter conversion', () => {
  it('converts $n to :pn outside quotes', () => {
    expect(toNamedParams('select $1, $2::text, $10')).toBe('select :p1, :p2::text, :p10');
    expect(toNamedParams(`select '$1', "$2", 'it''s $3', $4`)).toBe(`select '$1', "$2", 'it''s $3', :p4`);
    expect(toNamedParams('select $a, $')).toBe('select $a, $');
  });

  it('builds typed parameters', () => {
    expect(toSqlParameters(['x', 5, 1.5, true, null])).toEqual([
      { name: 'p1', value: { stringValue: 'x' } },
      { name: 'p2', value: { longValue: 5 } },
      { name: 'p3', value: { doubleValue: 1.5 } },
      { name: 'p4', value: { booleanValue: true } },
      { name: 'p5', value: { isNull: true } },
    ]);
  });
});

describe('DataApiDriver', () => {
  it('runs statements on the maintenance database without a transaction', async () => {
    const client = new MockRdsData();
    const driver = driverWith(client);
    const rows = await driver.query('select datname, datistemplate, datallowconn, comment from pg_database where datname = $1', ['nope']);
    expect(rows).toEqual([]);
    await driver.query('CREATE DATABASE "app_br_x"');
    expect(client.sent[1].name).toBe('ExecuteStatementCommand');
    expect(client.sent[1].input).toEqual({
      resourceArn: RESOURCE,
      secretArn: SECRET,
      database: 'postgres',
      sql: 'CREATE DATABASE "app_br_x"',
      parameters: undefined,
      formatRecordsAs: 'JSON',
      transactionId: undefined,
    });
    expect(client.sent[0].input.parameters).toEqual([{ name: 'p1', value: { stringValue: 'nope' } }]);
  });

  it('uses real SDK command classes', async () => {
    const client = new MockRdsData();
    const driver = driverWith(client);
    await driver.query('select 1 from pg_stat_activity');
    expect(client.sent[0].name).toBe(ExecuteStatementCommand.name);
  });

  it('holds a lock in an open transaction and commits on unlock', async () => {
    const client = new MockRdsData();
    const a = driverWith(client);
    const b = driverWith(client);

    expect(await a.tryLock('k')).toBe(true);
    expect(await b.tryLock('k')).toBe(false);
    const names = client.sent.map((s) => s.name);
    expect(names).toEqual([
      BeginTransactionCommand.name,
      ExecuteStatementCommand.name,
      BeginTransactionCommand.name,
      ExecuteStatementCommand.name,
      RollbackTransactionCommand.name,
    ]);
    expect(client.sent[1].input).toMatchObject({ transactionId: 'tx-1', sql: 'select pg_try_advisory_xact_lock(hashtext(:p1)) as locked' });
    expect(client.sent[4].input.transactionId).toBe('tx-2');

    await a.unlock('k');
    expect(client.sent.at(-1)).toMatchObject({ name: CommitTransactionCommand.name, input: { transactionId: 'tx-1' } });
    expect(await b.tryLock('k')).toBe(true);
    await b.close();
    expect(client.lockedBy.size).toBe(0);
  });

  it('rolls back the transaction if the lock query fails', async () => {
    const client = new MockRdsData();
    client.failOn = /advisory/;
    await expect(driverWith(client).tryLock('k')).rejects.toThrow(/mock failure/);
    expect(client.sent.at(-1)?.name).toBe(RollbackTransactionCommand.name);
  });

  it('keeps the lock transaction alive while held', async () => {
    vi.useFakeTimers();
    const client = new MockRdsData();
    const driver = driverWith(client, 1000);
    await driver.tryLock('k');
    const before = client.executed().length;
    await vi.advanceTimersByTimeAsync(3500);
    const pings = client.sent.slice(2).filter((s) => s.input.sql === 'select 1');
    expect(pings).toHaveLength(3);
    expect(pings.every((p) => p.input.transactionId === 'tx-1')).toBe(true);
    await driver.unlock('k');
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.executed().length).toBe(before + 3);
  });
});

describe('PgBranch over the Data API (mocked)', () => {
  const config: ResolvedConfig = {
    prefix: 'app',
    maintenanceDatabase: 'postgres',
    strategy: 'template',
    driver: 'data-api',
    hooks: { migrate: 'migrate-cmd', seed: 'seed-cmd' },
    gc: { ttl: '7d' },
    dataApi: { resourceArn: RESOURCE, secretArn: SECRET },
    rootDir: '/repo',
  };

  function setup(extra: Partial<ResolvedConfig> = {}) {
    const client = new MockRdsData();
    const hooks: { name: string; command: string; env: Record<string, string>; cwd: string }[] = [];
    const app = new PgBranch({
      config: { ...config, ...extra },
      driver: driverWith(client),
      hookRunner: async (name, command, env, cwd) => {
        hooks.push({ name, command, env, cwd });
      },
    });
    return { client, hooks, app };
  }

  it('refreshes the template, then creates and deletes a branch', async () => {
    const { client, hooks, app } = setup();
    expect(await app.templateRefresh()).toMatchObject({ fromEmpty: true, migrated: true, seeded: true });
    expect([...client.databases.keys()]).toEqual(['app_template']);
    expect(client.databases.get('app_template')).toMatchObject({ isTemplate: true, allowConn: false });

    const created = await app.create('feature/x');
    expect(created).toMatchObject({ database: 'app_br_feature_x', created: true, migrated: true, url: undefined });
    expect(hooks.map((h) => [h.name, h.env.PGBRANCH_DATABASE])).toEqual([
      ['migrate', 'app_template_next'],
      ['seed', 'app_template_next'],
      ['migrate', 'app_br_feature_x'],
    ]);
    expect(hooks[2].env).toEqual({
      PGBRANCH_DATABASE: 'app_br_feature_x',
      PGBRANCH_BRANCH: 'feature/x',
      PGBRANCH_RESOURCE_ARN: RESOURCE,
      PGBRANCH_SECRET_ARN: SECRET,
    });
    expect(hooks[2].cwd).toBe('/repo');

    expect(await app.list()).toMatchObject([{ branch: 'feature/x', database: 'app_br_feature_x', source: 'template', sizeBytes: 8000 }]);

    expect(await app.delete('feature/x')).toMatchObject({ deleted: true });
    expect([...client.databases.keys()]).toEqual(['app_template']);

    // DDL never runs inside a transaction.
    const ddl = client.sent.filter((s) => /^(CREATE|DROP|ALTER|COMMENT)/.test(String(s.input.sql)));
    expect(ddl.length).toBeGreaterThan(0);
    expect(ddl.every((s) => s.input.transactionId === undefined)).toBe(true);
    // All locks were released.
    expect(client.lockedBy.size).toBe(0);
  });

  it('prints the appUrl when set', async () => {
    const { app } = setup({ appUrl: 'postgresql://app@h/{database}' });
    await app.templateRefresh();
    expect((await app.create('b')).url).toBe('postgresql://app@h/app_br_b');
  });

  it('refuses the dump strategy', async () => {
    const { app } = setup({ strategy: 'dump' });
    await expect(app.templateRefresh()).rejects.toThrow(/needs a direct connection/);
  });

  it('drops the branch DB if CREATE works but the hook fails', async () => {
    const { client, app } = setup();
    await app.templateRefresh();
    const failing = new PgBranch({
      config,
      driver: driverWith(client),
      hookRunner: async () => {
        throw new Error('migration broke');
      },
    });
    await expect(failing.create('bad')).rejects.toThrow('migration broke');
    expect([...client.databases.keys()]).toEqual(['app_template']);
  });
});

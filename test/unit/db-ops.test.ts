import { describe, expect, it } from 'vitest';
import { DbOps } from '../../src/db-ops.js';
import type { Driver, Row, SqlParam } from '../../src/driver/types.js';
import { buildMetadata } from '../../src/metadata.js';
import { SafetyError } from '../../src/names.js';

/** Records every statement. Answers pg_database lookups from a fixed set. */
class FakeDriver implements Driver {
  readonly kind = 'pg' as const;
  readonly statements: string[] = [];
  constructor(private readonly databases: Record<string, { isTemplate?: boolean }> = {}) {}

  async query<T extends Row = Row>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    this.statements.push(sql);
    if (sql.includes('from pg_database where datname = $1')) {
      const db = this.databases[params[0] as string];
      return (db ? [{ datname: params[0], datistemplate: db.isTemplate ?? false, datallowconn: true, comment: null }] : []) as unknown as T[];
    }
    return [];
  }
  async tryLock(): Promise<boolean> {
    return true;
  }
  async unlock(): Promise<void> {}
  async close(): Promise<void> {}
}

const changing = (d: FakeDriver) => d.statements.filter((s) => /^(CREATE|DROP|ALTER|COMMENT)|pg_terminate_backend|pg_stat_activity/.test(s));

describe('DbOps safety rule', () => {
  const unmanaged = ['postgres', 'template1', 'other_db', 'appx_br_y', 'app'];

  it.each(unmanaged)('drop refuses %s and sends no SQL', async (db) => {
    const driver = new FakeDriver({ [db]: {} });
    const ops = new DbOps(driver, 'app', false);
    await expect(ops.drop(db)).rejects.toThrow(SafetyError);
    expect(changing(driver)).toEqual([]);
  });

  it.each(unmanaged)('terminate refuses %s', async (db) => {
    const driver = new FakeDriver();
    await expect(new DbOps(driver, 'app', false).terminate(db)).rejects.toThrow(SafetyError);
    expect(driver.statements).toEqual([]);
  });

  it.each(unmanaged)('rename refuses %s as source or target', async (db) => {
    const driver = new FakeDriver();
    const ops = new DbOps(driver, 'app', false);
    await expect(ops.rename(db, 'app_x')).rejects.toThrow(SafetyError);
    await expect(ops.rename('app_x', db)).rejects.toThrow(SafetyError);
    expect(driver.statements).toEqual([]);
  });

  it.each(unmanaged)('create, setTemplate, setComment, setAllowConnections refuse %s', async (db) => {
    const driver = new FakeDriver();
    const ops = new DbOps(driver, 'app', false);
    await expect(ops.create(db)).rejects.toThrow(SafetyError);
    await expect(ops.create('app_x', { source: db })).rejects.toThrow(SafetyError);
    await expect(ops.setTemplate(db, true)).rejects.toThrow(SafetyError);
    await expect(ops.setAllowConnections(db, true)).rejects.toThrow(SafetyError);
    await expect(ops.setComment(db, buildMetadata('b', 'template'))).rejects.toThrow(SafetyError);
    expect(driver.statements).toEqual([]);
  });

  it('only allows template0 / template1 as an empty base', async () => {
    const ops = new DbOps(new FakeDriver(), 'app', false);
    await expect(ops.create('app_x', { baseTemplate: 'postgres' })).rejects.toThrow();
  });
});

describe('DbOps SQL', () => {
  it('quotes identifiers and literals', async () => {
    const driver = new FakeDriver();
    const ops = new DbOps(driver, 'app', false);
    await ops.create('app_br_x', { source: 'app_template' });
    await ops.setComment('app_br_x', buildMetadata("it's \\ me", 'template', new Date('2024-01-01T00:00:00Z')));
    expect(driver.statements).toEqual([
      'CREATE DATABASE "app_br_x" TEMPLATE "app_template"',
      `COMMENT ON DATABASE "app_br_x" IS E'{"pgbranch":1,"branch":"it''s \\\\\\\\ me","createdAt":"2024-01-01T00:00:00.000Z","source":"template"}'`,
    ]);
  });

  it('unsets IS_TEMPLATE before dropping a template', async () => {
    const driver = new FakeDriver({ app_template: { isTemplate: true } });
    const ops = new DbOps(driver, 'app', false);
    expect(await ops.drop('app_template')).toBe(true);
    const ddl = driver.statements.filter((s) => /^(ALTER|DROP)/.test(s));
    expect(ddl).toEqual([
      'ALTER DATABASE "app_template" WITH IS_TEMPLATE false',
      'DROP DATABASE IF EXISTS "app_template" WITH (FORCE)',
    ]);
  });

  it('drop of a missing DB does nothing', async () => {
    const driver = new FakeDriver();
    expect(await new DbOps(driver, 'app', false).drop('app_br_none')).toBe(false);
    expect(changing(driver)).toEqual([]);
  });

  it('dry-run records actions and runs no changing SQL', async () => {
    const driver = new FakeDriver({ app_br_x: {} });
    const logs: string[] = [];
    const ops = new DbOps(driver, 'app', true, { info: (m) => logs.push(m), warn: () => {} });
    await ops.drop('app_br_x');
    await ops.create('app_br_y', { source: 'app_template' });
    expect(changing(driver)).toEqual([]);
    expect(ops.actions).toEqual([
      'terminate connections to "app_br_x"',
      'DROP DATABASE IF EXISTS "app_br_x" WITH (FORCE)',
      'CREATE DATABASE "app_br_y" TEMPLATE "app_template"',
    ]);
    expect(logs.every((l) => l.startsWith('[dry-run] '))).toBe(true);
  });
});

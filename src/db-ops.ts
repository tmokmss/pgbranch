import type { BranchMetadata } from './metadata.js';
import { serializeMetadata } from './metadata.js';
import { assertManaged } from './names.js';
import { quoteIdent, quoteLiteral } from './sql.js';
import type { Driver } from './driver/types.js';
import { errorCode } from './driver/types.js';

export interface DatabaseInfo {
  name: string;
  isTemplate: boolean;
  allowConnections: boolean;
  comment: string | null;
}

export interface DatabaseInfoWithSize extends DatabaseInfo {
  sizeBytes: number | null;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

export const silentLogger: Logger = { info: () => {}, warn: () => {} };

export function isObjectInUse(err: unknown): boolean {
  return errorCode(err) === '55006' || /being accessed by other users/i.test(String((err as Error)?.message ?? ''));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * All SQL that changes databases goes through this class.
 * Every method that changes a database calls `assertManaged` first (the safety rule).
 * In dry-run mode, changes are recorded in `actions` and not run.
 */
export class DbOps {
  readonly actions: string[] = [];

  constructor(
    readonly driver: Driver,
    readonly prefix: string,
    readonly dryRun: boolean,
    readonly log: Logger = silentLogger,
  ) {}

  /** Record an action. In dry-run mode it is also printed. */
  note(action: string): void {
    this.actions.push(action);
    if (this.dryRun) this.log.info(`[dry-run] ${action}`);
  }

  private async exec(sql: string): Promise<void> {
    this.note(sql);
    if (!this.dryRun) {
      await this.driver.query(sql);
    }
  }

  async get(name: string): Promise<DatabaseInfo | undefined> {
    const rows = await this.driver.query<{
      datname: string;
      datistemplate: boolean;
      datallowconn: boolean;
      comment: string | null;
    }>(
      `select datname, datistemplate, datallowconn, shobj_description(oid, 'pg_database') as comment
         from pg_database where datname = $1`,
      [name],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      name: row.datname,
      isTemplate: row.datistemplate === true,
      allowConnections: row.datallowconn === true,
      comment: row.comment ?? null,
    };
  }

  async exists(name: string): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  /** Databases whose name starts with `namePrefix` (plain string match, no LIKE). */
  async listByPrefix(namePrefix: string): Promise<DatabaseInfoWithSize[]> {
    const rows = await this.driver.query<{
      datname: string;
      datistemplate: boolean;
      datallowconn: boolean;
      comment: string | null;
      size: string | null;
    }>(
      `select datname, datistemplate, datallowconn,
              shobj_description(oid, 'pg_database') as comment,
              case when has_database_privilege(oid, 'CONNECT') then pg_database_size(oid)::text end as size
         from pg_database
        where left(datname, length($1)) = $1
        order by datname`,
      [namePrefix],
    );
    return rows.map((row) => ({
      name: row.datname,
      isTemplate: row.datistemplate === true,
      allowConnections: row.datallowconn === true,
      comment: row.comment ?? null,
      sizeBytes: row.size === null || row.size === undefined ? null : Number(row.size),
    }));
  }

  /** Terminate other sessions connected to a managed database. Returns how many. */
  async terminate(name: string): Promise<number> {
    assertManaged(this.prefix, name);
    this.note(`terminate connections to ${quoteIdent(name)}`);
    if (this.dryRun) return 0;
    const rows = await this.driver.query<{ pid: number }>(
      `select pid from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
      [name],
    );
    let count = 0;
    for (const { pid } of rows) {
      const result = await this.driver.query<{ ok: boolean }>('select pg_terminate_backend($1) as ok', [pid]);
      if (result[0]?.ok) count++;
    }
    return count;
  }

  /** CREATE DATABASE, empty (from `baseTemplate`) or as a copy of a managed source. */
  async create(name: string, options: { source?: string; baseTemplate?: string; retries?: number } = {}): Promise<void> {
    assertManaged(this.prefix, name);
    let sql = `CREATE DATABASE ${quoteIdent(name)}`;
    if (options.source !== undefined) {
      assertManaged(this.prefix, options.source);
      sql += ` TEMPLATE ${quoteIdent(options.source)}`;
    } else if (options.baseTemplate !== undefined) {
      if (options.baseTemplate !== 'template0' && options.baseTemplate !== 'template1') {
        throw new Error(`Unexpected base template ${options.baseTemplate}`);
      }
      sql += ` TEMPLATE ${quoteIdent(options.baseTemplate)}`;
    }
    const retries = options.retries ?? 0;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.exec(sql);
        return;
      } catch (err) {
        if (options.source !== undefined && isObjectInUse(err) && attempt < retries) {
          this.log.warn(`Source ${options.source} is in use, terminating connections and trying again`);
          await this.terminate(options.source);
          await sleep(200 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  }

  async setComment(name: string, meta: BranchMetadata): Promise<void> {
    assertManaged(this.prefix, name);
    await this.exec(`COMMENT ON DATABASE ${quoteIdent(name)} IS ${quoteLiteral(serializeMetadata(meta))}`);
  }

  async setTemplate(name: string, isTemplate: boolean): Promise<void> {
    assertManaged(this.prefix, name);
    await this.exec(
      isTemplate
        ? `ALTER DATABASE ${quoteIdent(name)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`
        : `ALTER DATABASE ${quoteIdent(name)} WITH IS_TEMPLATE false`,
    );
  }

  async setAllowConnections(name: string, allow: boolean): Promise<void> {
    assertManaged(this.prefix, name);
    await this.exec(`ALTER DATABASE ${quoteIdent(name)} WITH ALLOW_CONNECTIONS ${allow}`);
  }

  async rename(from: string, to: string): Promise<void> {
    assertManaged(this.prefix, from);
    assertManaged(this.prefix, to);
    await this.terminate(from);
    await this.exec(`ALTER DATABASE ${quoteIdent(from)} RENAME TO ${quoteIdent(to)}`);
  }

  /** Drop a managed database. Unsets IS_TEMPLATE first if needed. */
  async drop(name: string): Promise<boolean> {
    assertManaged(this.prefix, name);
    const info = await this.get(name);
    if (!info) return false;
    if (info.isTemplate) {
      await this.setTemplate(name, false);
    }
    await this.terminate(name);
    // FORCE (PG13+) also ends sessions that connected after terminate.
    await this.exec(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    return true;
  }
}

import type {
  ExecuteStatementCommandOutput,
  SqlParameter,
  BeginTransactionCommandOutput,
} from '@aws-sdk/client-rds-data';
import type { Driver, Row, SqlParam } from './types.js';

/** The part of `RDSDataClient` we use. Lets tests pass a mock. */
export interface RdsDataLike {
  send(command: unknown): Promise<unknown>;
}

export interface DataApiDriverOptions {
  resourceArn: string;
  secretArn: string;
  maintenanceDatabase: string;
  region?: string;
  /** For tests. If not set, a real `RDSDataClient` is created. */
  client?: RdsDataLike;
}

type Commands = typeof import('@aws-sdk/client-rds-data');

/**
 * Convert `$1`, `$2`, ... to Data API named parameters `:p1`, `:p2`, ...
 * Skips text inside quotes so literals and identifiers are not changed.
 */
export function toNamedParams(sql: string): string {
  let out = '';
  let quote: string | undefined;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += sql[++i];
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '$' && /[0-9]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < sql.length && /[0-9]/.test(sql[j])) j++;
      out += `:p${sql.slice(i + 1, j)}`;
      i = j - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

export function toSqlParameters(params: SqlParam[]): SqlParameter[] {
  return params.map((value, index): SqlParameter => {
    const name = `p${index + 1}`;
    if (value === null) return { name, value: { isNull: true } };
    if (typeof value === 'boolean') return { name, value: { booleanValue: value } };
    if (typeof value === 'number') {
      return Number.isInteger(value) ? { name, value: { longValue: value } } : { name, value: { doubleValue: value } };
    }
    return { name, value: { stringValue: value } };
  });
}

/**
 * Driver that talks to Aurora through the RDS Data API.
 *
 * OPEN QUESTION: it is not yet confirmed that `ExecuteStatement` without a
 * `transactionId` runs `CREATE DATABASE` / `DROP DATABASE` / `ALTER DATABASE`
 * outside a transaction block. See NOTES.md and scripts/data-api-smoke.mjs.
 *
 * Locking: each `ExecuteStatement` can use a different backend connection, so a
 * session-level advisory lock would not stay held. Instead we open a Data API
 * transaction, take `pg_try_advisory_xact_lock` in it, and keep the transaction
 * open until `unlock` commits it. DDL runs outside that transaction.
 */
export class DataApiDriver implements Driver {
  readonly kind = 'data-api' as const;
  private client: RdsDataLike | undefined;
  private commands: Commands | undefined;
  private lockTransactions = new Map<string, string>();

  constructor(private readonly options: DataApiDriverOptions) {
    this.client = options.client;
  }

  private async load(): Promise<{ client: RdsDataLike; commands: Commands }> {
    if (!this.commands) {
      this.commands = await import('@aws-sdk/client-rds-data');
    }
    if (!this.client) {
      this.client = new this.commands.RDSDataClient(this.options.region ? { region: this.options.region } : {});
    }
    return { client: this.client, commands: this.commands };
  }

  private base() {
    return {
      resourceArn: this.options.resourceArn,
      secretArn: this.options.secretArn,
      database: this.options.maintenanceDatabase,
    };
  }

  private async execute(sql: string, params: SqlParam[], transactionId?: string): Promise<Row[]> {
    const { client, commands } = await this.load();
    const output = (await client.send(
      new commands.ExecuteStatementCommand({
        ...this.base(),
        sql: toNamedParams(sql),
        parameters: params.length > 0 ? toSqlParameters(params) : undefined,
        formatRecordsAs: 'JSON',
        transactionId,
      }),
    )) as ExecuteStatementCommandOutput;
    if (!output.formattedRecords) return [];
    return JSON.parse(output.formattedRecords) as Row[];
  }

  async query<T extends Row = Row>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return (await this.execute(sql, params)) as T[];
  }

  async tryLock(key: string): Promise<boolean> {
    if (this.lockTransactions.has(key)) {
      throw new Error(`Lock ${key} is already held by this process`);
    }
    const { client, commands } = await this.load();
    const begin = (await client.send(new commands.BeginTransactionCommand(this.base()))) as BeginTransactionCommandOutput;
    const transactionId = begin.transactionId;
    if (!transactionId) throw new Error('Data API BeginTransaction returned no transactionId');
    let locked = false;
    try {
      const rows = await this.execute('select pg_try_advisory_xact_lock(hashtext($1)) as locked', [key], transactionId);
      locked = rows[0]?.locked === true;
    } finally {
      if (!locked) {
        await client.send(new commands.RollbackTransactionCommand({ ...this.base(), transactionId }));
      }
    }
    if (locked) this.lockTransactions.set(key, transactionId);
    return locked;
  }

  async unlock(key: string): Promise<void> {
    const transactionId = this.lockTransactions.get(key);
    if (!transactionId) return;
    this.lockTransactions.delete(key);
    const { client, commands } = await this.load();
    await client.send(new commands.CommitTransactionCommand({ resourceArn: this.options.resourceArn, secretArn: this.options.secretArn, transactionId }));
  }

  async close(): Promise<void> {
    for (const key of [...this.lockTransactions.keys()]) {
      await this.unlock(key);
    }
  }
}

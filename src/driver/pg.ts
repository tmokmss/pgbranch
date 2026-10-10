import pg from 'pg';
import { withDatabase } from '../url.js';
import type { Driver, Row, SqlParam } from './types.js';

/** Driver that uses one direct `pg` connection to the maintenance database. */
export class PgDriver implements Driver {
  readonly kind = 'pg' as const;
  private client: pg.Client | undefined;
  private connecting: Promise<pg.Client> | undefined;

  constructor(
    private readonly adminUrl: string,
    private readonly maintenanceDatabase: string,
  ) {}

  private async connect(): Promise<pg.Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new pg.Client({
          connectionString: withDatabase(this.adminUrl, this.maintenanceDatabase),
          application_name: 'pgbranch',
        });
        // Avoid crashing the process on a backend error between queries.
        client.on('error', () => {});
        await client.connect();
        this.client = client;
        return client;
      })();
    }
    return this.connecting;
  }

  async query<T extends Row = Row>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    const client = await this.connect();
    const result = await client.query(sql, params);
    return result.rows as T[];
  }

  async tryLock(key: string): Promise<boolean> {
    // Session-level lock: it stays on this connection, outside any transaction.
    const rows = await this.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtext($1)) as locked', [key]);
    return rows[0]?.locked === true;
  }

  async unlock(key: string): Promise<void> {
    await this.query('select pg_advisory_unlock(hashtext($1))', [key]);
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    if (client) await client.end();
  }
}

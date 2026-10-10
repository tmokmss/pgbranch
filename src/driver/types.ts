export type SqlParam = string | number | boolean | null;

export type Row = Record<string, unknown>;

/**
 * A connection to the maintenance database. The core logic only uses this
 * interface, so it does not depend on `pg` or the RDS Data API directly.
 */
export interface Driver {
  readonly kind: 'pg' | 'data-api';

  /**
   * Run one statement on the maintenance database, outside any transaction
   * (CREATE / DROP DATABASE cannot run in a transaction).
   * Use `$1`, `$2`, ... for parameters.
   */
  query<T extends Row = Row>(sql: string, params?: SqlParam[]): Promise<T[]>;

  /** Try to take the advisory lock for `key`. Returns false if someone else holds it. */
  tryLock(key: string): Promise<boolean>;

  /** Release the lock taken with `tryLock`. */
  unlock(key: string): Promise<void>;

  close(): Promise<void>;
}

/** Postgres error code (SQLSTATE) if the error has one. */
export function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Metadata stored as JSON in `COMMENT ON DATABASE`.
 * `source` is "template", "branch:<branch name>" or "database:<database name>".
 */
export interface BranchMetadata {
  pgbranch: 1;
  branch: string;
  createdAt: string;
  source: string;
}

export const TEMPLATE_SOURCE = 'template';

export function branchSource(branch: string): string {
  return `branch:${branch}`;
}

export function databaseSource(database: string): string {
  return `database:${database}`;
}

export function parseSource(
  source: string,
): { kind: 'template' } | { kind: 'branch'; branch: string } | { kind: 'database'; database: string } {
  if (source === TEMPLATE_SOURCE) {
    return { kind: 'template' };
  }
  if (source.startsWith('branch:') && source.length > 'branch:'.length) {
    return { kind: 'branch', branch: source.slice('branch:'.length) };
  }
  if (source.startsWith('database:') && source.length > 'database:'.length) {
    return { kind: 'database', database: source.slice('database:'.length) };
  }
  throw new Error(`Unknown source in metadata: ${JSON.stringify(source)}`);
}

export function buildMetadata(branch: string, source: string, now: Date = new Date()): BranchMetadata {
  return { pgbranch: 1, branch, createdAt: now.toISOString(), source };
}

export function serializeMetadata(meta: BranchMetadata): string {
  return JSON.stringify(meta);
}

/** Parse a database comment. Returns undefined if it is not pgbranch metadata. */
export function parseMetadata(comment: string | null | undefined): BranchMetadata | undefined {
  if (!comment) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(comment);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v.pgbranch !== 1) return undefined;
  if (typeof v.branch !== 'string' || typeof v.createdAt !== 'string') return undefined;
  if (Number.isNaN(Date.parse(v.createdAt))) return undefined;
  const source = typeof v.source === 'string' ? v.source : TEMPLATE_SOURCE;
  return { pgbranch: 1, branch: v.branch, createdAt: v.createdAt, source };
}

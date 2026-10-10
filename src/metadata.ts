/**
 * Metadata stored as JSON in `COMMENT ON DATABASE`.
 * `source` is "template" or "branch:<branch name>".
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

/** Returns the source branch name, or undefined if the source is the template. */
export function parseSource(source: string): { kind: 'template' } | { kind: 'branch'; branch: string } {
  if (source === TEMPLATE_SOURCE) {
    return { kind: 'template' };
  }
  if (source.startsWith('branch:') && source.length > 'branch:'.length) {
    return { kind: 'branch', branch: source.slice('branch:'.length) };
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

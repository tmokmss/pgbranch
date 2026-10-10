import { createHash } from 'node:crypto';

/** Postgres identifier limit (NAMEDATALEN - 1), in bytes. */
export const MAX_IDENTIFIER_BYTES = 63;

/** Longest suffix we add to the template name (`_template_next`). */
const LONGEST_TEMPLATE_SUFFIX = '_template_next';

/** Shortest room we want for the branch part of a branch DB name. */
const MIN_BRANCH_PART = 16;

export const PREFIX_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Databases we never touch, even if the prefix would match. */
const RESERVED_DATABASES = new Set(['postgres', 'template0', 'template1', 'rdsadmin']);

export class SafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafetyError';
  }
}

export function maxPrefixLength(): number {
  return MAX_IDENTIFIER_BYTES - Math.max(LONGEST_TEMPLATE_SUFFIX.length, '_br_'.length + MIN_BRANCH_PART);
}

export function validatePrefix(prefix: string): void {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new Error(`Invalid prefix "${prefix}": use lowercase letters, digits and "_", starting with a letter`);
  }
  if (prefix.length > maxPrefixLength()) {
    throw new Error(`Prefix "${prefix}" is too long (max ${maxPrefixLength()} chars)`);
  }
}

export function templateName(prefix: string): string {
  return `${prefix}_template`;
}

export function templateNextName(prefix: string): string {
  return `${prefix}_template_next`;
}

export function templateOldName(prefix: string): string {
  return `${prefix}_template_old`;
}

export function branchDbPrefix(prefix: string): string {
  return `${prefix}_br_`;
}

/**
 * Lowercase, replace any char not in [a-z0-9_] with "_", collapse repeats,
 * and trim "_" at both ends.
 */
export function sanitizeBranchName(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}

/**
 * Database name for a branch: `<prefix>_br_<sanitized>`.
 * If too long, truncate and add `_<8 hex of sha1(branch)>` so long names do not collide.
 */
export function branchDbName(prefix: string, branch: string): string {
  validatePrefix(prefix);
  if (branch.length === 0) {
    throw new Error('Branch name must not be empty');
  }
  const head = branchDbPrefix(prefix);
  let part = sanitizeBranchName(branch);
  if (part.length === 0) {
    // Nothing usable left (e.g. only non-ASCII chars). Use the hash alone.
    part = shortHash(branch);
  }
  if (head.length + part.length <= MAX_IDENTIFIER_BYTES) {
    return head + part;
  }
  const room = MAX_IDENTIFIER_BYTES - head.length - 9; // 9 = "_" + 8 hex
  const kept = part.slice(0, room).replace(/_+$/, '');
  return `${head}${kept}_${shortHash(branch)}`;
}

/**
 * The safety rule. Every statement that drops, renames, alters, or terminates
 * connections to a database must call this first.
 */
export function assertManaged(prefix: string, database: string): void {
  validatePrefix(prefix);
  if (RESERVED_DATABASES.has(database)) {
    throw new SafetyError(`Refusing to touch reserved database "${database}"`);
  }
  if (!database.startsWith(`${prefix}_`) || database.length <= prefix.length + 1) {
    throw new SafetyError(`Refusing to touch database "${database}": it does not start with "${prefix}_"`);
  }
  if (Buffer.byteLength(database, 'utf8') > MAX_IDENTIFIER_BYTES) {
    throw new SafetyError(`Database name "${database}" is longer than ${MAX_IDENTIFIER_BYTES} bytes`);
  }
}

export function isManaged(prefix: string, database: string): boolean {
  try {
    assertManaged(prefix, database);
    return true;
  } catch {
    return false;
  }
}

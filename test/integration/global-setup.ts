import { enabled, ensureRoles } from './helpers.js';

/** Runs once before all test files. */
export default async function setup(): Promise<void> {
  if (enabled) await ensureRoles();
}

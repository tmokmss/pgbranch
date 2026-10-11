import type { ResolvedConfig } from '../config.js';
import { PgDriver } from './pg.js';
import type { Driver } from './types.js';

export function createDriver(config: ResolvedConfig): Driver {
  return new PgDriver(config.adminUrl, config.maintenanceDatabase);
}

export { PgDriver };
export type { Driver };

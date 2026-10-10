import type { ResolvedConfig } from '../config.js';
import { DataApiDriver } from './data-api.js';
import { PgDriver } from './pg.js';
import type { Driver } from './types.js';

export function createDriver(config: ResolvedConfig): Driver {
  if (config.driver === 'data-api') {
    if (!config.dataApi) throw new Error('Data API settings are missing');
    return new DataApiDriver({
      resourceArn: config.dataApi.resourceArn,
      secretArn: config.dataApi.secretArn,
      region: config.dataApi.region,
      maintenanceDatabase: config.maintenanceDatabase,
    });
  }
  if (!config.adminUrl) throw new Error('Admin URL is missing');
  return new PgDriver(config.adminUrl, config.maintenanceDatabase);
}

export { DataApiDriver, PgDriver };
export type { Driver };

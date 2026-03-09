import type { CommsDriver } from './interface.js';

export type DriverName = 'telegram' | 'discord';

export async function loadDriver(name: DriverName): Promise<CommsDriver> {
  switch (name) {
    case 'telegram': {
      const { TelegramDriver } = await import('./telegram/index.js');
      return new TelegramDriver();
    }
    case 'discord':
      throw new Error('Discord driver not yet implemented');
    default:
      throw new Error(`Unknown driver: ${String(name)}`);
  }
}

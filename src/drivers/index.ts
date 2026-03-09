import type { CommsDriver } from './interface.js';

export type DriverName = 'telegram' | 'slack' | 'discord';

export async function loadDriver(name: DriverName): Promise<CommsDriver> {
  switch (name) {
    case 'telegram': {
      const { TelegramDriver } = await import('./telegram/index.js');
      return new TelegramDriver();
    }
    case 'slack':
      throw new Error('Slack driver not yet implemented');
    case 'discord':
      throw new Error('Discord driver not yet implemented');
    default:
      throw new Error(`Unknown driver: ${String(name)}`);
  }
}

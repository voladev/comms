import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { drainOutbox, clearInbox } from '../src/store.js';

const DATA_DIR = resolve(new URL('.', import.meta.url).pathname, '../data');

beforeEach(() => {
  mkdirSync(DATA_DIR, { recursive: true });
  drainOutbox();
  clearInbox();
});

describe('enqueueOutbox via send flow', () => {
  it('outbox entry without chat_id uses undefined', () => {
    const { enqueueOutbox } = await import('../src/store.js');
    enqueueOutbox({ text: 'broadcast' });
    const entries = drainOutbox();
    expect(entries[0].chat_id).toBeUndefined();
  });
});

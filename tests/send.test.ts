import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { drainOutbox, clearInbox, enqueueOutbox } from '../src/store.js';

const DATA_DIR = resolve(new URL('.', import.meta.url).pathname, '../data');

beforeEach(() => {
  mkdirSync(DATA_DIR, { recursive: true });
  drainOutbox();
  clearInbox();
});

describe('enqueueOutbox via send flow', () => {
  it('outbox entry without chat_id uses undefined', () => {
    enqueueOutbox({ text: 'broadcast' });
    const entries = drainOutbox();
    expect(entries[0].chat_id).toBeUndefined();
  });
});

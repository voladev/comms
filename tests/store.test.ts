import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';

// We test store functions by pointing DATA_DIR at a temp directory.
// Since store.ts derives paths from import.meta.url, we test via re-exports
// with a patched environment.

import {
  drainOutbox,
  enqueueOutbox,
  readInbox,
  appendInbox,
  clearInbox,
} from '../src/store.js';

// Note: integration-style tests — store operates on real files in data/
// In CI the data/ dir may not exist; we create it.
const DATA_DIR = resolve(new URL('.', import.meta.url).pathname, '../data');

beforeEach(() => {
  mkdirSync(DATA_DIR, { recursive: true });
  // Clear state before each test
  clearInbox();
  drainOutbox(); // drain to clear
});

afterEach(() => {
  clearInbox();
  drainOutbox();
});

describe('outbox', () => {
  it('returns empty array when outbox is empty', () => {
    expect(drainOutbox()).toEqual([]);
  });

  it('enqueues and drains an entry', () => {
    enqueueOutbox({ text: 'hello', chat_id: '123' });
    const entries = drainOutbox();
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('hello');
    expect(entries[0].chat_id).toBe('123');
  });

  it('clears outbox after drain', () => {
    enqueueOutbox({ text: 'once' });
    drainOutbox();
    expect(drainOutbox()).toEqual([]);
  });

  it('handles multiple entries', () => {
    enqueueOutbox({ text: 'first' });
    enqueueOutbox({ text: 'second', chat_id: '456' });
    const entries = drainOutbox();
    expect(entries).toHaveLength(2);
    expect(entries[1].text).toBe('second');
  });
});

describe('inbox', () => {
  it('returns empty array when inbox is empty', () => {
    expect(readInbox()).toEqual([]);
  });

  it('appends and reads entries', () => {
    appendInbox({ from: 'olga', id: '123', text: 'hi', time: '2026-01-01T00:00:00Z' });
    const entries = readInbox();
    expect(entries).toHaveLength(1);
    expect(entries[0].from).toBe('olga');
    expect(entries[0].text).toBe('hi');
  });

  it('clears inbox', () => {
    appendInbox({ from: 'igor', id: '456', text: 'test', time: '2026-01-01T00:00:00Z' });
    clearInbox();
    expect(readInbox()).toEqual([]);
  });

  it('preserves entries across multiple reads', () => {
    appendInbox({ from: 'olga', id: '123', text: 'msg1', time: '2026-01-01T00:00:00Z' });
    appendInbox({ from: 'olga', id: '123', text: 'msg2', time: '2026-01-01T00:01:00Z' });
    expect(readInbox()).toHaveLength(2);
    expect(readInbox()).toHaveLength(2); // non-destructive
  });
});

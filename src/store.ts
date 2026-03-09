/**
 * File-based inbox/outbox store.
 * These files are the integration boundary between comms and Gas Town (mayor, scripts).
 *
 * Outbox: mayor writes → driver reads + delivers → clears
 * Inbox:  driver writes → mayor reads via `comms inbox` → clears
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { InboxEntry, OutboxEntry } from './drivers/interface.js';

export const DATA_DIR = resolve(new URL('.', import.meta.url).pathname, '../data');
export const OUTBOX_FILE = resolve(DATA_DIR, 'outbox.jsonl');
export const INBOX_FILE = resolve(DATA_DIR, 'inbox.jsonl');
export const PROGRESS_FILE = resolve(DATA_DIR, 'progress-cache.json');

/** Atomically drain the outbox. Returns entries (or [] if empty/missing). */
export function drainOutbox(): OutboxEntry[] {
  if (!existsSync(OUTBOX_FILE)) return [];
  let raw: string;
  try {
    raw = readFileSync(OUTBOX_FILE, 'utf8').trim();
    if (!raw) return [];
    writeFileSync(OUTBOX_FILE, ''); // clear before processing to avoid double-send
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as OutboxEntry];
      } catch {
        return [];
      }
    });
}

/** Append one entry to the outbox (used by `comms send`). */
export function enqueueOutbox(entry: OutboxEntry): void {
  appendFileSync(OUTBOX_FILE, JSON.stringify(entry) + '\n');
}

/** Read all inbox entries without clearing. */
export function readInbox(): InboxEntry[] {
  if (!existsSync(INBOX_FILE)) return [];
  return readFileSync(INBOX_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as InboxEntry];
      } catch {
        return [];
      }
    });
}

/** Append one message to the inbox (used by drivers on incoming message). */
export function appendInbox(entry: InboxEntry): void {
  appendFileSync(INBOX_FILE, JSON.stringify(entry) + '\n');
}

/** Clear the inbox. */
export function clearInbox(): void {
  writeFileSync(INBOX_FILE, '');
}

export interface ProgressCache {
  updated_at: string;
  text: string;
}

export function readProgressCache(): ProgressCache | null {
  if (!existsSync(PROGRESS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8')) as ProgressCache;
  } catch {
    return null;
  }
}

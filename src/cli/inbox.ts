#!/usr/bin/env tsx
/**
 * comms inbox [--clear]
 *
 * Prints pending messages from the inbox.
 * --clear  empties the inbox after printing.
 */
import { readInbox, clearInbox } from '../store.js';

const shouldClear = process.argv.includes('--clear');
const entries = readInbox();

if (entries.length === 0) {
  console.log('(no pending messages)');
  process.exit(0);
}

console.log('📱 Pending messages:');
console.log('─────────────────────');
for (const e of entries) {
  console.log(`From: ${e.from}  (${e.time})`);
  console.log(`  ${e.text}`);
  console.log(`  → Reply: comms send --user ${e.from} "your reply"`);
  console.log('');
}

if (shouldClear) {
  clearInbox();
  console.log('✓ Inbox cleared');
}

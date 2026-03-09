#!/usr/bin/env tsx
/**
 * comms send [--user <name>] "message"
 *
 * Enqueues a message to the outbox. The running driver delivers it within ~5s.
 * Resolves --user <name> to a platform-specific chat_id via COMMS_USER_<name>.
 */
import 'dotenv/config';
import { enqueueOutbox } from '../store.js';

const args = process.argv.slice(2);

let targetUser = '';
let message = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--user' && args[i + 1]) {
    targetUser = args[++i];
  } else {
    message = args[i];
  }
}

if (!message) {
  console.error('Usage: comms send [--user <name>] "message"');
  process.exit(1);
}

let chatId: string | undefined;

if (targetUser) {
  // Support both legacy TELEGRAM_USER_<name> and new COMMS_USER_<name>
  const varName = `COMMS_USER_${targetUser}`;
  const legacyVar = `TELEGRAM_USER_${targetUser}`;
  chatId = process.env[varName] ?? process.env[legacyVar];
  if (!chatId) {
    console.error(`ERROR: No chat ID for user "${targetUser}". Set ${varName} in .env`);
    process.exit(1);
  }
} else {
  chatId = process.env.COMMS_DEFAULT_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    console.error('ERROR: COMMS_DEFAULT_CHAT_ID not set in .env');
    process.exit(1);
  }
}

enqueueOutbox({ text: message, chat_id: chatId });
console.log(`✓ Queued → ${targetUser || 'default'} (${chatId})`);

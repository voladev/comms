/**
 * CommsDriver — implemented by each platform adapter (Telegram, Slack, etc.)
 *
 * The file-based inbox/outbox acts as the integration contract with Gas Town:
 *   - Outbox (mayor → users): comms-send writes JSON lines; driver polls and delivers.
 *   - Inbox  (users → mayor): driver appends JSON lines; comms-inbox reads them.
 */

export interface InboxEntry {
  from: string;      // username / display name
  id: string;        // platform user id
  text: string;
  time: string;      // ISO 8601
}

export interface OutboxEntry {
  text: string;
  chat_id?: string;  // platform-specific target; falls back to default
}

export interface CommsDriver {
  /** Start the bot / long-poll loop. Runs until process exits. */
  serve(): Promise<void>;
}

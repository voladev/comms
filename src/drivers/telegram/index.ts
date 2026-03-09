import 'dotenv/config';
import { Telegraf, Context } from 'telegraf';
import { exec } from 'child_process';
import { promisify } from 'util';
import { drainOutbox, appendInbox, readProgressCache } from '../../store.js';
import type { CommsDriver } from '../interface.js';

const execAsync = promisify(exec);

// ── Config ────────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';
const ALLOWED_IDS = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// TELEGRAM_USER_<name>=<id>  →  id → name
const USER_NAMES: Record<string, string> = {};
for (const [key, val] of Object.entries(process.env)) {
  const m = key.match(/^TELEGRAM_USER_(.+)$/);
  if (m && val) USER_NAMES[val.trim()] = m[1];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isAllowed(ctx: Context): boolean {
  return ALLOWED_IDS.includes(String(ctx.from?.id ?? ''));
}

function guard(ctx: Context): boolean {
  if (!isAllowed(ctx)) {
    ctx.reply('⛔ Unauthorized.').catch(() => {});
    return false;
  }
  return true;
}

async function run(cmd: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      env: { ...process.env, HOME: process.env.HOME ?? '/root' },
      timeout: 30_000,
    });
    return (stdout || stderr).trim() || '(no output)';
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return (e.stderr || e.stdout || e.message || String(err)).trim();
  }
}

function truncate(text: string, max = 3800): string {
  return text.length <= max ? text : text.slice(0, max) + '\n…(truncated)';
}

async function replyText(ctx: Context, text: string): Promise<void> {
  await ctx.reply(truncate(text));
}

async function replyCode(ctx: Context, text: string): Promise<void> {
  const safe = truncate(text).replace(/`/g, "'");
  await ctx
    .reply('```\n' + safe + '\n```', { parse_mode: 'MarkdownV2' })
    .catch(() => ctx.reply(truncate(text)));
}

// ── Outbox polling ────────────────────────────────────────────────────────────

async function pollOutbox(bot: Telegraf): Promise<void> {
  const entries = drainOutbox();
  for (const entry of entries) {
    const target = entry.chat_id ?? DEFAULT_CHAT_ID;
    if (!target) continue;
    try {
      await bot.telegram.sendMessage(target, truncate(entry.text));
    } catch {
      // ignore delivery errors (user blocked bot, etc.)
    }
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

const HELP_TEXT =
  'Gas Town commands:\n' +
  '/status — gt status\n' +
  '/progress — cached task progress snapshot\n' +
  '/convoys — active polecats\n' +
  '/polecats [rig] — gt polecat list\n' +
  '/rigs — gt rig list\n' +
  '/mail — gt mail inbox\n' +
  '/ready — bd ready\n\n' +
  'Text message → forwarded to mayor as mail\n' +
  'Mayor replies arrive here automatically';

// ── Driver ────────────────────────────────────────────────────────────────────

export class TelegramDriver implements CommsDriver {
  async serve(): Promise<void> {
    if (!BOT_TOKEN) {
      console.error('ERROR: TELEGRAM_BOT_TOKEN is not set');
      process.exit(1);
    }
    if (ALLOWED_IDS.length === 0) {
      console.warn('WARNING: TELEGRAM_ALLOWED_USER_IDS is empty — bot will reject all users');
    }

    const bot = new Telegraf(BOT_TOKEN);

    bot.start((ctx) => {
      if (!guard(ctx)) return;
      ctx.reply(
        '👋 Gas Town bot online.\n\n' +
          'Commands:\n' +
          '/status — town status\n' +
          '/progress — active task progress (cached)\n' +
          '/convoys — active polecats\n' +
          '/polecats [rig] — list polecats\n' +
          '/rigs — list rigs\n' +
          '/mail — mayor inbox\n' +
          '/ready — beads ready to work\n' +
          '/help — this message\n\n' +
          'Send any text → forwarded to mayor as mail.\n' +
          'Mayor replies appear here automatically.'
      );
    });

    bot.help((ctx) => {
      if (!guard(ctx)) return;
      ctx.reply(HELP_TEXT);
    });

    bot.command('status', async (ctx) => {
      if (!guard(ctx)) return;
      await replyCode(ctx, await run('gt status'));
    });

    bot.command('convoys', async (ctx) => {
      if (!guard(ctx)) return;
      await replyCode(ctx, await run('gt polecat list --all'));
    });

    bot.command('polecats', async (ctx) => {
      if (!guard(ctx)) return;
      const rig = ctx.message.text.split(' ')[1] ?? '--all';
      await replyCode(ctx, await run(`gt polecat list ${rig}`));
    });

    bot.command('rigs', async (ctx) => {
      if (!guard(ctx)) return;
      await replyCode(ctx, await run('gt rig list'));
    });

    bot.command('mail', async (ctx) => {
      if (!guard(ctx)) return;
      await replyCode(ctx, await run('gt mail inbox'));
    });

    bot.command('ready', async (ctx) => {
      if (!guard(ctx)) return;
      await replyCode(ctx, await run('bd ready 2>&1'));
    });

    bot.command('progress', async (ctx) => {
      if (!guard(ctx)) return;
      const cache = readProgressCache();
      if (cache) {
        await replyText(ctx, `${cache.text}\n\n_Last updated: ${cache.updated_at}_`);
      } else {
        await replyCode(ctx, await run('gt polecat list --all 2>&1'));
      }
    });

    bot.on('text', async (ctx) => {
      if (!guard(ctx)) return;
      const text = ctx.message.text;
      if (text.startsWith('/')) return;

      const userId = String(ctx.from?.id ?? '');
      const name = USER_NAMES[userId] ?? ctx.from?.username ?? ctx.from?.first_name ?? 'unknown';

      appendInbox({
        from: name,
        id: userId,
        text,
        time: new Date().toISOString(),
      });

      run(`gt nudge mayor/ "📱 New message from ${name}: ${text.slice(0, 40)}"`).catch(() => {});
      await replyText(ctx, '✉️ Sent to mayor. Reply will appear here.');
    });

    bot.launch({ dropPendingUpdates: true });

    console.log('🚂 Gas Town comms (telegram) running...');
    console.log(`   Allowed users: ${ALLOWED_IDS.join(', ') || '(none)'}`);

    setInterval(() => pollOutbox(bot).catch(() => {}), 5_000);

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));

    // Keep process alive
    await new Promise(() => {});
  }
}

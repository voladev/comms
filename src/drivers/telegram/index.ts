import 'dotenv/config';
import { Telegraf, Context } from 'telegraf';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { drainOutbox, appendInbox } from '../../store.js';
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

// Town root — needed so bd commands find the routing config and cross-rig databases.
const TOWN_ROOT = process.env.GT_TOWN_ROOT ?? '/gt';

async function run(cmd: string, cwd?: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: cwd ?? TOWN_ROOT,
      env: { ...process.env, HOME: process.env.HOME ?? '/root' },
      timeout: 30_000,
    });
    return (stdout || stderr).trim() || '(no output)';
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return (e.stderr || e.stdout || e.message || String(err)).trim();
  }
}

/** Run a shell command with the given string piped to its stdin. */
async function runWithStdin(cmd: string, input: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], {
      cwd: TOWN_ROOT,
      env: { ...process.env, HOME: process.env.HOME ?? '/root' },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.stdin.end(input);
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
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

// ── Progress ──────────────────────────────────────────────────────────────────

interface PolecatJson {
  rig: string;
  name: string;
  state: string;
  issue?: string;
  zombie?: boolean;
}

interface BdIssue {
  id: string;
  title: string;
  priority: number;
}

async function fetchIssueTitle(id: string): Promise<string | null> {
  try {
    const out = await run(`bd show ${id} --json 2>/dev/null`);
    const arr = JSON.parse(out) as BdIssue[];
    return arr[0]?.title ?? null;
  } catch {
    return null;
  }
}

async function buildProgressReport(): Promise<string> {
  const lines: string[] = [];

  // ── Active workers ──
  let polecats: PolecatJson[] = [];
  try {
    const raw = await run('gt polecat list --all --json 2>/dev/null');
    const parsed = JSON.parse(raw);
    polecats = (Array.isArray(parsed) ? parsed : []).filter((p: PolecatJson) => !p.zombie);
  } catch { /* ignore */ }

  if (polecats.length > 0) {
    lines.push('🐱 Active workers:');
    for (const p of polecats) {
      let label = p.state;
      if (p.issue) {
        const title = await fetchIssueTitle(p.issue);
        label = title ? `${p.issue}: ${title}` : p.issue;
      }
      lines.push(`  ● ${p.rig}/${p.name} — ${label}`);
    }
  } else {
    lines.push('🐱 No active workers');
  }

  // ── Queued (ready) issues ──
  let ready: BdIssue[] = [];
  try {
    const raw = await run('bd ready --json 2>/dev/null');
    const parsed = JSON.parse(raw);
    ready = Array.isArray(parsed) ? parsed : (parsed.issues ?? []);
  } catch { /* ignore */ }

  lines.push('');
  if (ready.length > 0) {
    lines.push('📋 Queued:');
    for (const issue of ready.slice(0, 8)) {
      lines.push(`  ○ ${issue.id} P${issue.priority} — ${issue.title}`);
    }
    if (ready.length > 8) lines.push(`  … and ${ready.length - 8} more`);
  } else {
    lines.push('📋 No queued work');
  }

  lines.push('');
  lines.push(`_Updated: ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC_`);
  return lines.join('\n');
}

// ── Commands ──────────────────────────────────────────────────────────────────

const HELP_TEXT =
  'Gas Town commands:\n' +
  '/status — gt status\n' +
  '/progress — active workers + queued tasks\n' +
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
          '/progress — active workers + queued tasks (live)\n' +
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
      await replyText(ctx, await buildProgressReport());
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

      // Send durable mail to mayor (persisted to inbox, survives session restarts)
      const mailBody = `📱 Telegram message\n\nFrom: ${name} (id: ${userId})\n\n${text}\n\n---\nReply: comms send --user ${name} "your reply here"`;
      runWithStdin(`gt mail send mayor/ --subject "COMMS: ${name.replace(/"/g, '')}: ${text.slice(0, 60).replace(/"/g, '')}" --type task --priority 1 --stdin`, mailBody).catch(() => {});
      // Nudge co-witness (always idle) so response is immediate even when mayor is mid-conversation.
      // co-witness forwards to mayor if action is needed; mayor also has it in mail.
      run(`gt nudge --mode=immediate co-witness "📱 Telegram message from ${name}: ${text.slice(0, 60)} — reply via: comms send --user ${name} \\"...\\""`).catch(() => {});
      run(`gt nudge --mode=queue mayor/ "📱 New Telegram message from ${name} — check mail"`).catch(() => {});
      await replyText(ctx, '✉️ Sent to mayor. Reply will appear here.');
    });

    await bot.telegram.setMyCommands([
      { command: 'status', description: 'Current town status (gt status)' },
      { command: 'progress', description: 'Active workers + queued tasks (live)' },
      { command: 'convoys', description: 'List all active polecats' },
      { command: 'polecats', description: 'List polecats for a rig (e.g. /polecats pick)' },
      { command: 'rigs', description: 'List all rigs' },
      { command: 'mail', description: 'Mayor inbox' },
      { command: 'ready', description: 'Beads ready to work on' },
      { command: 'help', description: 'Show all commands' },
    ]);

    bot.launch({ dropPendingUpdates: false });

    console.log('🚂 Gas Town comms (telegram) running...');
    console.log(`   Allowed users: ${ALLOWED_IDS.join(', ') || '(none)'}`);

    setInterval(() => pollOutbox(bot).catch(() => {}), 5_000);

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));

    // Keep process alive
    await new Promise(() => {});
  }
}

import 'dotenv/config';
import { Telegraf, Context } from 'telegraf';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import {
  drainOutbox,
  appendInbox,
  readProgressState,
  writeProgressState,
} from '../../store.js';
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
  status?: string;
  description?: string;
  created_by?: string;
  assignee?: string;
  closed_at?: string;
}

/** Fetch a single issue's full details via bd show. */
async function fetchIssue(id: string, cwd?: string): Promise<BdIssue | null> {
  try {
    const out = await run(`bd show ${id} --json 2>/dev/null`, cwd);
    const arr = JSON.parse(out) as BdIssue[];
    return arr[0] ?? null;
  } catch {
    return null;
  }
}

interface CrewWorker {
  name: string;
  rig: string;
  branch: string;
  has_session: boolean;
}

/** Build the Pick crew section using pick-scoped bd and gt crew commands. */
async function buildPickSection(): Promise<string | null> {
  const PICK_ROOT = `${TOWN_ROOT}/pick`;

  // Crew workers
  let workers: CrewWorker[] = [];
  try {
    const raw = await run('gt crew list --rig pick --json 2>/dev/null');
    const parsed = JSON.parse(raw);
    workers = (Array.isArray(parsed) ? parsed : []).filter((w: CrewWorker) => w.has_session);
  } catch { /* ignore */ }
  if (workers.length === 0) return null;

  // In-progress issues (pick-scoped bd)
  // bd list doesn't support --json; parse text to get IDs then bd show for full details
  let inProgress: BdIssue[] = [];
  try {
    const text = await run('bd list --status in_progress 2>/dev/null', PICK_ROOT);
    const ids = [...text.matchAll(/\b(pi-[a-z0-9]+)\b/g)].map((m) => m[1]);
    inProgress = (
      await Promise.all(ids.map((id) => fetchIssue(id, PICK_ROOT)))
    ).filter((i): i is BdIssue => i != null && !NOISE_IDS.test(i.id));
  } catch { /* ignore */ }

  // Queued issues (pick-scoped bd)
  let queued: BdIssue[] = [];
  try {
    const raw = await run('bd ready --json 2>/dev/null', PICK_ROOT);
    const parsed = JSON.parse(raw);
    queued = (Array.isArray(parsed) ? parsed : (parsed.issues ?? [])).filter(
      (i: BdIssue) => !NOISE_IDS.test(i.id),
    );
  } catch { /* ignore */ }

  const lines: string[] = ['🎬 Pick crew (ratedby.dev):'];

  for (const worker of workers) {
    const assigneePath = `pick/crew/${worker.name}`;
    const issue = inProgress.find((i) => i.assignee === assigneePath);
    if (issue) {
      lines.push(`  ● ${worker.name} — ${issue.id}: ${issue.title}`);
      const ctx = extractContext(issue.description);
      if (ctx) lines.push(`    ↳ ${ctx}`);
    } else {
      const branchHint = worker.branch && worker.branch !== 'main' ? ` (${worker.branch})` : '';
      lines.push(`  ○ ${worker.name} — idle${branchHint}`);
    }
  }

  if (queued.length > 0) {
    lines.push('  📋 Queued:');
    for (const issue of queued.slice(0, 4)) {
      lines.push(`    ○ ${issue.id} P${issue.priority} — ${issue.title}`);
    }
    if (queued.length > 4) lines.push(`    … and ${queued.length - 4} more`);
  }

  return lines.join('\n');
}

/**
 * Extract a short human-readable context from a beads issue description.
 * Prefers the ## Context section; falls back to the first meaningful line.
 */
function extractContext(description: string | undefined): string | null {
  if (!description) return null;
  const contextMatch = description.match(/##\s*Context\s*\n([\s\S]*?)(?:\n##|\n---|\s*$)/i);
  if (contextMatch) {
    const text = contextMatch[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length > 0) return text.length > 140 ? text.slice(0, 140) + '…' : text;
  }
  const firstLine = description.split('\n').find(
    (l) => l.trim().length > 10 && !l.startsWith('#') && !l.startsWith('-') && !l.startsWith('*'),
  );
  if (firstLine) {
    const t = firstLine.trim();
    return t.length > 140 ? t.slice(0, 140) + '…' : t;
  }
  return null;
}

const NOISE_IDS = /wisp|mol-/;

async function buildProgressReport(): Promise<string> {
  const now = new Date().toISOString();
  const lastState = readProgressState();
  const lastAt = lastState?.last_progress_at ?? null;

  // Record this call so next /progress can show "done since last check"
  writeProgressState({ last_progress_at: now });

  const sections: string[] = [];

  // ── Done since last check ──
  if (lastAt) {
    let closed: BdIssue[] = [];
    try {
      const raw = await run('bd list --status closed --json 2>/dev/null');
      const parsed = JSON.parse(raw);
      const all: BdIssue[] = Array.isArray(parsed) ? parsed : (parsed.issues ?? []);
      closed = all.filter(
        (i) => !NOISE_IDS.test(i.id) && i.closed_at != null && i.closed_at > lastAt,
      );
    } catch { /* ignore */ }

    if (closed.length > 0) {
      const lines = ['✅ Done since last check:'];
      for (const issue of closed.slice(0, 5)) {
        lines.push(`  ✓ ${issue.id} — ${issue.title}`);
      }
      if (closed.length > 5) lines.push(`  … and ${closed.length - 5} more`);
      sections.push(lines.join('\n'));
    }
  }

  // ── In progress ──
  let inProgress: BdIssue[] = [];
  try {
    const raw = await run('bd list --status in_progress --json 2>/dev/null');
    const parsed = JSON.parse(raw);
    inProgress = (Array.isArray(parsed) ? parsed : (parsed.issues ?? [])).filter(
      (i: BdIssue) => !NOISE_IDS.test(i.id),
    );
  } catch { /* ignore */ }

  if (inProgress.length > 0) {
    const lines = ['⚙️ In progress:'];
    for (const issue of inProgress) {
      // bd list may return summary only — fetch full details for context
      const full = issue.description != null ? issue : await fetchIssue(issue.id);
      lines.push(`  ● ${issue.id} P${issue.priority} — ${issue.title}`);
      const ctx = extractContext(full?.description);
      if (ctx) lines.push(`    ↳ ${ctx}`);
    }
    sections.push(lines.join('\n'));
  }

  // ── Active workers ──
  let polecats: PolecatJson[] = [];
  try {
    const raw = await run('gt polecat list --all --json 2>/dev/null');
    const parsed = JSON.parse(raw);
    polecats = (Array.isArray(parsed) ? parsed : []).filter((p: PolecatJson) => !p.zombie);
  } catch { /* ignore */ }

  if (polecats.length > 0) {
    const lines = ['🐱 Workers:'];
    for (const p of polecats) {
      let label = p.state;
      if (p.issue) {
        const issue = await fetchIssue(p.issue);
        label = issue?.title ? `${p.issue}: ${issue.title}` : p.issue;
      }
      lines.push(`  ● ${p.rig}/${p.name} — ${label}`);
    }
    sections.push(lines.join('\n'));
  }

  // ── Planned (ready to pick up) ──
  let ready: BdIssue[] = [];
  try {
    const raw = await run('bd ready --json 2>/dev/null');
    const parsed = JSON.parse(raw);
    ready = (Array.isArray(parsed) ? parsed : (parsed.issues ?? [])).filter(
      (i: BdIssue) => !NOISE_IDS.test(i.id),
    );
  } catch { /* ignore */ }

  if (ready.length > 0) {
    const lines = ['📋 Planned:'];
    // Show context for top 4; rest just titles
    for (let i = 0; i < Math.min(ready.length, 6); i++) {
      const issue = ready[i];
      lines.push(`  ○ ${issue.id} P${issue.priority} — ${issue.title}`);
      if (i < 4) {
        const full = issue.description != null ? issue : await fetchIssue(issue.id);
        const ctx = extractContext(full?.description);
        if (ctx) lines.push(`    ↳ ${ctx}`);
      }
    }
    if (ready.length > 6) lines.push(`  … and ${ready.length - 6} more`);
    sections.push(lines.join('\n'));
  }

  // ── Pick crew ──
  const pickSection = await buildPickSection();
  if (pickSection) sections.push(pickSection);

  if (sections.length === 0) sections.push('💤 No active work');

  const since = lastAt
    ? `last checked: ${lastAt.replace('T', ' ').slice(0, 16)} UTC`
    : 'first check';
  sections.push(`_${now.replace('T', ' ').slice(0, 16)} UTC · ${since}_`);

  return sections.join('\n\n');
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

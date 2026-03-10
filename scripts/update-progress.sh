#!/usr/bin/env bash
# update-progress.sh — Snapshot current work status into progress-cache.json.
#
# Called by:
#   - relay-inbox.sh (every minute)
#   - Gas Town mail hook (on work events)

set -euo pipefail

COMMS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROGRESS_FILE="$COMMS_DIR/data/progress-cache.json"
mkdir -p "$COMMS_DIR/data"

# ── Gather data ──────────────────────────────────────────────────────────────

strip_noise() {
  grep -v "^Warning:" | grep -v "^-\+" | grep -v "^Total:" \
    | grep -v "^Status:" | grep -v "^$" | grep -v "dolt_server_port" \
    | grep -v "port file\|beads.role" || true
}

polecats=$(gt polecat list --all 2>/dev/null | strip_noise || echo "")

in_progress=$(bd list --status in_progress --limit 0 2>/dev/null | strip_noise \
  | grep -v "No issues found" || echo "")

queued=$(bd list --status open --limit 0 2>/dev/null | strip_noise \
  | grep -v "No issues found" \
  | grep -v "wisp" \
  | grep -Ev "^(ESCALATION|COMMS|relay test|test$|CRASHED|MERGED|Beads)" \
  | head -8 || echo "")

recently_done=$(bd list --status closed --limit 8 2>/dev/null | strip_noise \
  | grep -v "No issues found" | grep -v "mol-\|wisp" | head -3 || echo "")

# ── Build text ───────────────────────────────────────────────────────────────

python3 - "$PROGRESS_FILE" <<PYEOF
import sys, json, datetime

progress_file = sys.argv[1]

polecats = """$polecats""".strip()
in_progress = """$in_progress""".strip()
queued = """$queued""".strip()
recently_done = """$recently_done""".strip()

parts = []
if polecats and polecats != "No polecats found.":
    parts.append("🐱 Active workers:\n" + polecats)
if in_progress:
    parts.append("⚙️ In progress:\n" + in_progress)
if queued:
    parts.append("📋 Queued:\n" + queued)
if recently_done:
    parts.append("✅ Recently done:\n" + recently_done)

text = "\n\n".join(parts) if parts else "💤 No active work"
updated_at = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

with open(progress_file, "w") as f:
    json.dump({"updated_at": updated_at, "text": text}, f, ensure_ascii=False)
print("✓ Progress cache updated:", updated_at)
PYEOF

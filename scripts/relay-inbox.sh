#!/usr/bin/env bash
# relay-inbox.sh — Forward comms inbox messages to the mayor as mail.
#
# Run every minute via cron. Reads the JSONL inbox, sends each message to
# mayor/ as a mail (with user info for routing replies), then clears the inbox.
#
# Reply to a user: comms send --user <name> "your reply"
# User IDs are resolved via COMMS_USER_<name> in the comms .env file.

set -euo pipefail

COMMS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INBOX="$COMMS_DIR/data/inbox.jsonl"

# Nothing to do if inbox is missing or empty
[[ -f "$INBOX" ]] || exit 0
[[ -s "$INBOX" ]] || exit 0

# Read and clear atomically (move to temp file)
TMP=$(mktemp)
mv "$INBOX" "$TMP"
touch "$INBOX"

# Process each line
while IFS= read -r line; do
  [[ -z "$line" ]] && continue

  # Extract fields with jq (available in the container)
  from=$(echo "$line" | jq -r '.from // "unknown"')
  user_id=$(echo "$line" | jq -r '.id // ""')
  text=$(echo "$line" | jq -r '.text // ""')
  ts=$(echo "$line" | jq -r '.time // ""')

  [[ -z "$text" ]] && continue

  # Build mail body
  body="📱 Message from Telegram

From: $from (id: $user_id)
Time: $ts

$text

---
Reply: comms send --user $from \"your reply here\""

  gt mail send mayor/ \
    --subject "COMMS: $from: $(echo "$text" | head -c 60)" \
    --type task \
    --priority 1 \
    --stdin <<< "$body" 2>/dev/null || true

done < "$TMP"

rm -f "$TMP"

# Always update progress cache so /progress is fresh
"$COMMS_DIR/scripts/update-progress.sh" 2>/dev/null || true

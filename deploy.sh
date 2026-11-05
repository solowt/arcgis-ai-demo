#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'Deployment error: %s\n' "$*" >&2
  exit 1
}

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$PROJECT_ROOT/deploy.conf"

[[ -f "$CONFIG_FILE" ]] ||
  fail "Missing $CONFIG_FILE. Copy deploy.conf.example to deploy.conf and edit it."

REMOTE_HOST=""
REMOTE_DIR=""
source "$CONFIG_FILE"

[[ -n "$REMOTE_HOST" && "$REMOTE_HOST" != -* &&
  "$REMOTE_HOST" != *[[:space:]/:]* ]] ||
  fail "Set REMOTE_HOST to an SSH host alias or user@hostname in $CONFIG_FILE."
[[ "$REMOTE_DIR" == /* && "$REMOTE_DIR" != / ]] ||
  fail "Set REMOTE_DIR to an absolute project directory other than /."

for tool in ssh rsync; do
  command -v "$tool" >/dev/null ||
    fail "Required local command not found: $tool"
done

# SSH joins arguments into a remote shell command, so quote the path explicitly.
REMOTE_COMMAND="bash -s -- '${REMOTE_DIR//\'/\'\\\'\'}'"

printf 'Checking %s:%s\n' "$REMOTE_HOST" "$REMOTE_DIR"
ssh -T -- "$REMOTE_HOST" "$REMOTE_COMMAND" <<'REMOTE'
set -euo pipefail
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
source "$NVM_DIR/nvm.sh"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=4096"
for tool in node npm rsync; do
  command -v "$tool" >/dev/null || {
    printf 'Required remote command not found: %s\n' "$tool" >&2
    exit 1
  }
done
mkdir -p -- "$1"
cd -P -- "$1"
if [[ "$PWD" == / || ! -w . ]]; then
  printf 'Remote destination must be a writable project directory, not /.\n' >&2
  exit 1
fi
REMOTE

printf 'Uploading project...\n'
rsync --archive --compress --safe-links --protect-args --rsh=ssh \
  --exclude='.git' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='.vite/' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='.npmrc' \
  --exclude='/deploy.conf' \
  -- "$PROJECT_ROOT/" "$REMOTE_HOST:$REMOTE_DIR/"

printf 'Installing dependencies and building on the remote...\n'
ssh -T -- "$REMOTE_HOST" "$REMOTE_COMMAND" <<'REMOTE'
set -euo pipefail
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
source "$NVM_DIR/nvm.sh"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=4096"
cd -- "$1"
npm install --include=dev
npm --prefix apps/helper-services-assistant install --include=dev
npm --prefix apps/helper-services-assistant run build
REMOTE

printf 'Deployment complete: %s:%s\n' "$REMOTE_HOST" "$REMOTE_DIR"

#!/usr/bin/env bash
# 보존 정책 실행. crontab 이 주 1회 부른다.
# 수집 슬롯과 **같은 락**을 잡는다 - 아카이브를 파싱하는 도중에 지우면 안 된다.
set -uo pipefail

export HOME="${HOME:-/root}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

NODE="${CLAUDE_MONITOR_NODE:-$(command -v node || true)}"
if [[ -z "$NODE" ]]; then
    for candidate in "$HOME"/.nvm/versions/node/*/bin/node /usr/local/bin/node /usr/bin/node; do
        [[ -x "$candidate" ]] && NODE="$candidate" && break
    done
fi
[[ -x "$NODE" ]] || { echo "node not found" >&2; exit 0; }

mkdir -p "$REPO/data"
exec 9>"$REPO/data/collect.lock"
# 수집 슬롯이 5분마다 짧게 돈다. 여기서는 기다린다 (주 1회라 서둘 이유가 없다).
if ! flock -w 600 9; then
    echo "$(date -Is) prune skipped: could not acquire lock" >&2
    exit 0
fi

cd "$REPO"
"$NODE" collector/prune-main.ts
exit 0

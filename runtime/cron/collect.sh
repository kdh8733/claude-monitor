#!/usr/bin/env bash
# M4: 수집 슬롯 1회. crontab 이 5분마다 부른다.
# 스냅샷 폴(M1/M2) + 트랜스크립트 아카이브(M3) + 파싱(M5) 을 순서대로 돌린다.
# 정책: 조용히 종료한다. 상태는 collector_run 테이블과 heartbeat 파일에 남는다.
#       실패해도 exit 0 - cron 이 다음 슬롯에 다시 기동한다(자가치유). 죽음 감지는 health.sh 가 한다.
set -uo pipefail

export HOME="${HOME:-/root}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# cron 은 로그인 셸이 아니라 PATH 가 빈약하다. node 를 명시적으로 찾는다.
NODE="${CLAUDE_MONITOR_NODE:-$(command -v node || true)}"
if [[ -z "$NODE" ]]; then
    for candidate in "$HOME"/.nvm/versions/node/*/bin/node /usr/local/bin/node /usr/bin/node; do
        [[ -x "$candidate" ]] && NODE="$candidate" && break
    done
fi
[[ -x "$NODE" ]] || { echo "node not found" >&2; exit 0; }

mkdir -p "$REPO/data"
LOCK="$REPO/data/collect.lock"

# 앞 슬롯이 아직 돌고 있으면 이번 슬롯은 건너뛴다. 겹치면 SQLite 라이터가 둘이 된다.
# -n: 즉시 실패. 기다리면 슬롯이 밀려 쌓인다.
exec 9>"$LOCK"
if ! flock -n 9; then
    echo "$(date -Is) skip: previous slot still running" >&2
    exit 0
fi

cd "$REPO"
"$NODE" collector/main.ts
"$NODE" collector/archive-main.ts
"$NODE" collector/parse-main.ts

# 성공적으로 한 슬롯을 마쳤다는 표식. health.sh 가 이 파일의 mtime 을 본다.
touch "$REPO/data/heartbeat"
exit 0

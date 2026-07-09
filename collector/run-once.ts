// 한 번의 폴 = runOnce. M1(스냅샷 적재) + M2(토큰 ride-along).
// 자격증명은 읽기만 한다 - 갱신·재기록·refreshToken 소비 절대 금지 (004 C5-A).
// 어떤 경우에도 던지지 않는다 - 결과는 collector_run.status로 구분한다.
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// cron이 5분마다 기동한다. 응답이 걸리면 프로세스가 슬롯을 넘어 쌓인다.
const FETCH_TIMEOUT_MS = 30_000;

export interface RunOnceDeps {
  db: DatabaseSync;
  fetchFn: typeof fetch;
  credentialsPath: string;
}

export async function runOnce(deps: RunOnceDeps): Promise<void> {
  const startedAt = Date.now();
  const insertRun = deps.db.prepare(`
    INSERT INTO collector_run (started_at, finished_at, kind, status, http_status, note, snapshot_id)
    VALUES (?, ?, 'snapshot', ?, ?, ?, ?)
  `);

  try {
    const cred = readCredentials(deps.credentialsPath);
    if (cred === null || cred.expiresAt <= startedAt) {
      // 토큰 값 금지 - 길이와 만료시각만 (CLAUDE.md 2항).
      const note = cred === null
        ? 'credentials unusable'
        : `token_len=${cred.accessToken.length} expired_at=${new Date(cred.expiresAt).toISOString()}`;
      insertRun.run(startedAt, Date.now(), 'auth_skip', null, note, null);
      return;
    }

    const res = await deps.fetchFn(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${cred.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await res.text();
    if (res.status !== 200) {
      insertRun.run(startedAt, Date.now(), 'http_error', res.status, null, null);
      return;
    }

    // 스냅샷 행과 run 행은 함께 커밋되어야 한다. 둘 사이에서 죽으면 collector_run 이
    // 결손의 권위 있는 출처라는 불변식(I3)이 깨진다.
    deps.db.exec('BEGIN IMMEDIATE');
    try {
      // 본문 텍스트를 verbatim 그대로 적재 (I1). 파싱·재직렬화 금지.
      const { lastInsertRowid } = deps.db
        .prepare('INSERT INTO snapshot (captured_at, raw_json) VALUES (?, ?)')
        .run(startedAt, body);
      insertRun.run(startedAt, Date.now(), 'ok', 200, null, lastInsertRowid);
      deps.db.exec('COMMIT');
    } catch (err) {
      deps.db.exec('ROLLBACK');
      throw err;
    }
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err);
    insertRun.run(startedAt, Date.now(), 'error', null, note, null);
  }
}

// 자격증명 파일도 미문서화 스키마다. 성치 않으면 null 을 돌려 auth_skip 으로 안전하게 실패한다.
// 여기서 null 대신 부분값을 돌리면 `Bearer undefined` 가 나간다.
function readCredentials(path: string): { accessToken: string; expiresAt: number } | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null; // 파일 없음 -> auth_skip
  }
  let oauth: unknown;
  try {
    oauth = (JSON.parse(text) as { claudeAiOauth?: unknown }).claudeAiOauth;
  } catch {
    return null; // 파싱 불가 -> auth_skip. 에러 메시지에 파일 내용이 실릴 수 있어 되던지지 않는다.
  }
  if (typeof oauth !== 'object' || oauth === null) return null;
  const { accessToken, expiresAt } = oauth as { accessToken?: unknown; expiresAt?: unknown };
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  return { accessToken, expiresAt };
}

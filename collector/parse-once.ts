// M5 트랜스크립트 파서: 아카이브(gz)에서 usage 이벤트를 추출해 usage_event 로 적재한다.
// grain = message.id. 한 메시지가 스트리밍으로 여러 라인에 누적 기록되므로 (2.3:1)
// 라인을 그대로 합치면 output 이 2.5~3.0배 과대계상된다. 종단(=최대 output) usage 가 이긴다.
// 순서에 의존하지 않는다 - 파일 순회 순서는 보장되지 않는다 (004 C2, 전수 실측).
// message.content 는 읽지도 저장하지도 않는다 - 우리가 원하는 건 usage 뿐이다.
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { createGunzip } from 'node:zlib';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

export interface ParseOnceDeps {
  db: DatabaseSync;
  archiveRoot: string;
}

export interface ParseCounts {
  archivesScanned: number;
  archivesParsed: number;
  archivesSkipped: number;
  linesRead: number;
  eventsUpserted: number;
  errors: number;
}

export async function parseOnce(deps: ParseOnceDeps): Promise<ParseCounts> {
  const counts: ParseCounts = {
    archivesScanned: 0, archivesParsed: 0, archivesSkipped: 0,
    linesRead: 0, eventsUpserted: 0, errors: 0,
  };

  // 보존본(*.jsonl.<mtime>.gz)도 포함한다 - compaction 으로 원본에서 사라진 이벤트가
  // 거기에만 남아 있을 수 있다 (M3 가 보존한 이유).
  let entries: string[];
  try {
    entries = (readdirSync(deps.archiveRoot, { recursive: true }) as string[])
      .filter((p) => p.endsWith('.gz'));
  } catch {
    return counts; // 아카이브 루트 부재 - 아직 M3 가 돈 적 없는 머신
  }

  // 스킵 판정은 1회 조회로 메모리에 올린다 - 파일마다 SELECT 하면 매 슬롯 아카이브 수에 선형.
  const parsedMtimes = new Map(
    (deps.db.prepare('SELECT archive_path, mtime_ms FROM parsed_archive').all() as
      Array<{ archive_path: string; mtime_ms: number }>)
      .map((r) => [r.archive_path, r.mtime_ms]),
  );
  const upsertParsed = deps.db.prepare(`
    INSERT INTO parsed_archive (archive_path, mtime_ms, parsed_at) VALUES (?, ?, ?)
    ON CONFLICT (archive_path) DO UPDATE SET
      mtime_ms = excluded.mtime_ms,
      parsed_at = excluded.parsed_at
  `);
  // 종단 usage 승리: output 이 더 클 때만 교체. 동률이면 기존 행 유지.
  const upsertEvent = deps.db.prepare(`
    INSERT INTO usage_event (
      message_id, captured_at, source_id, session_id, cwd, git_branch,
      model, service_tier, speed, is_sidechain, request_id,
      input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
      cache_creation_5m_tokens, cache_creation_1h_tokens, raw_usage_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (message_id) DO UPDATE SET
      captured_at = excluded.captured_at,
      source_id = excluded.source_id,
      session_id = excluded.session_id,
      cwd = excluded.cwd,
      git_branch = excluded.git_branch,
      model = excluded.model,
      service_tier = excluded.service_tier,
      speed = excluded.speed,
      is_sidechain = excluded.is_sidechain,
      request_id = excluded.request_id,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_input_tokens = excluded.cache_read_input_tokens,
      cache_creation_input_tokens = excluded.cache_creation_input_tokens,
      cache_creation_5m_tokens = excluded.cache_creation_5m_tokens,
      cache_creation_1h_tokens = excluded.cache_creation_1h_tokens,
      raw_usage_json = excluded.raw_usage_json
    WHERE excluded.output_tokens > usage_event.output_tokens
  `);

  for (const relPath of entries) {
    // 한 아카이브의 실패가 나머지를 막지 않는다. 실패는 카운트만
    // (경로는 로그에 남기지 않는다 - 아카이브 경로에 실 프로젝트명이 들어 있다).
    try {
      const st = statSync(join(deps.archiveRoot, relPath));
      if (!st.isFile()) continue;
      counts.archivesScanned++;

      const mtimeMs = Math.floor(st.mtimeMs);
      if (parsedMtimes.get(relPath) === mtimeMs) {
        counts.archivesSkipped++;
        continue;
      }

      const sourceId = relPath.split(sep)[0]; // 상대경로 첫 세그먼트 = 소스 id
      // 아카이브 단위 트랜잭션: 이벤트와 parsed_archive 부기가 원자적으로 함께 커밋된다.
      deps.db.exec('BEGIN');
      try {
        const r = await parseArchive(join(deps.archiveRoot, relPath), sourceId, upsertEvent);
        upsertParsed.run(relPath, mtimeMs, Date.now());
        deps.db.exec('COMMIT');
        counts.linesRead += r.lines;
        counts.eventsUpserted += r.upserted;
        counts.archivesParsed++;
      } catch (err) {
        deps.db.exec('ROLLBACK');
        throw err;
      }
    } catch {
      counts.errors++;
    }
  }
  return counts;
}

// gz 를 스트리밍으로 한 줄씩 처리한다. 큰 파일이 있으므로 통째로 메모리에 올리지 않는다.
async function parseArchive(
  absPath: string,
  sourceId: string,
  upsertEvent: StatementSync,
): Promise<{ lines: number; upserted: number }> {
  const src = createReadStream(absPath);
  const gz = createGunzip();
  src.on('error', (err) => gz.destroy(err)); // 읽기 에러를 gunzip 스트림으로 전파
  src.pipe(gz);
  gz.setEncoding('utf8'); // 청크 경계의 멀티바이트 문자를 안전하게 처리

  let lines = 0;
  let upserted = 0;
  let buf = '';
  for await (const chunk of gz) {
    buf += chunk as string;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      lines++;
      upserted += handleLine(line, sourceId, upsertEvent);
    }
  }
  if (buf.trim().length > 0) { // 개행 없이 끝나는 마지막 라인
    lines++;
    upserted += handleLine(buf, sourceId, upsertEvent);
  }
  return { lines, upserted };
}

function handleLine(text: string, sourceId: string, upsertEvent: StatementSync): number {
  // 프리필터: usage 키가 아예 없는 라인(user 턴, 대형 tool_result 등)은 JSON.parse 를 건너뛴다.
  // 활성 세션 파일은 매 슬롯 변경돼 전체 재파싱되므로 이 비용이 반복된다.
  // 오탐(content 안의 "usage")은 파싱 후 아래 조건에서 정상 폐기된다 - 정확성 불변.
  if (!text.includes('"usage"')) return 0;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return 0; // JSON 이 아닌 라인은 무시 (usage 없는 라인과 동급)
  }
  const msg = parsed.message as Record<string, unknown> | undefined;
  const usage = msg?.usage as Record<string, unknown> | undefined;
  const messageId = msg?.id;
  // message.usage 와 message.id 가 둘 다 있는 라인만 취한다 (전수 실측: 해당 누락 0건)
  if (typeof messageId !== 'string' || messageId === '' || usage === undefined || usage === null) return 0;

  const capturedAt = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN;
  if (Number.isNaN(capturedAt)) return 0; // timestamp 불량 라인은 버리고 계속

  const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
  const result = upsertEvent.run(
    messageId,
    capturedAt,
    sourceId,
    str(parsed.sessionId),
    str(parsed.cwd),
    str(parsed.gitBranch),
    str(msg!.model),
    str(usage.service_tier),
    str(usage.speed), // 구버전 기록 14~16% 에서 부재 -> NULL
    parsed.isSidechain === true ? 1 : parsed.isSidechain === false ? 0 : null,
    str(parsed.requestId),
    int(usage.input_tokens),
    int(usage.output_tokens),
    int(usage.cache_read_input_tokens),
    int(usage.cache_creation_input_tokens),
    int(cacheCreation?.ephemeral_5m_input_tokens),
    int(cacheCreation?.ephemeral_1h_input_tokens),
    JSON.stringify(usage), // 미승격 필드(server_tool_use 등) 보존
  );
  return Number(result.changes); // WHERE 로 교체가 거부되면 0
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function int(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}

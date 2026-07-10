// LLM 분석용 리포트 테스트. 순수 함수 계약 - 시계를 읽지 않고, 같은 입력이면 같은 출력이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportJson, buildReportMarkdown, type ReportInput } from './report.ts';

const at = (iso: string) => Date.parse(iso);

function baseInput(): ReportInput {
  return {
    mode: 'demo',
    anchorMs: at('2026-07-10T04:00:00Z'),
    fromMs: at('2026-06-12T04:00:00Z'),
    rangeDays: 28,
    headroom: { samples: 2689, meanUtilization: 45.2, abandonedPct: 54.8 },
    scopes: [
      { kind: 'weekly_scoped', percent: 68, isActive: true, resetsAt: '2026-07-14T00:00:00.000Z', scopeModel: 'Fable' },
      { kind: 'weekly_all', percent: 45, isActive: false, resetsAt: '2026-07-14T00:00:00.000Z', scopeModel: null },
      { kind: 'session', percent: 28, isActive: false, resetsAt: '2026-07-10T08:00:00.000Z', scopeModel: null },
    ],
    projects: [
      {
        project: 'aurora-api', sidechainEvents: 12, events: 100,
        inputTokens: 1_000, outputTokens: 2_000, cacheReadTokens: 50_000, cacheCreationTokens: 3_000,
        apiEquivalentUsd: 1.23,
      },
      {
        project: 'widget-shop', sidechainEvents: 0, events: 40,
        inputTokens: 400, outputTokens: 900, cacheReadTokens: 10_000, cacheCreationTokens: 700,
        apiEquivalentUsd: 4.56,
      },
    ],
    models: [
      {
        model: 'claude-opus-4-8', events: 140,
        inputTokens: 1_400, outputTokens: 2_900, cacheReadTokens: 60_000, cacheCreationTokens: 3_700,
        apiEquivalentUsd: 5.79,
      },
    ],
    gaps: { ok: 2500, failed: 3, authSkip: 312, gapPct: 0.12 },
    apiEquivalentUsd: 5.79,
  };
}

// 1. 면책 문구 - 환산가치가 청구액으로 오독되면 리포트가 거짓말을 하는 것이다 (CLAUDE.md 6항).
test('report md: 면책 한 줄이 반드시 있다', () => {
  const md = buildReportMarkdown(baseInput());
  assert.ok(md.includes('API 환산가치는 실제 청구액이 아니다. 이 구독은 정액제다.'));
});

// 2. billable 정의 - LLM 이 다른 정의로 재해석하지 않게 리포트 안에 명시한다.
test('report md: billable 토큰 정의가 리포트 안에 있다', () => {
  const md = buildReportMarkdown(baseInput());
  assert.ok(md.includes('input + output + cache_creation'));
  assert.ok(md.includes('cache_read 제외'));
});

// 3. auth_skip 은 데이터에 뚫린 구멍이다 - 숫자를 감추지 않는다.
test('report md: auth_skip 이 0 이 아니면 그 숫자가 나온다', () => {
  const md = buildReportMarkdown(baseInput());
  assert.ok(md.includes('312'), 'auth_skip 슬롯 수 312 가 마크다운에 없다');
  assert.ok(md.includes('auth_skip'));
});

// 4. null 은 0 이 아니다. "미상"으로 쓰고 $0 으로 쓰지 않는다.
test('report md: 환산가치 null -> "미상", "$0" 아님', () => {
  const input = baseInput();
  input.apiEquivalentUsd = null;
  input.projects[0].apiEquivalentUsd = null;
  input.models[0].apiEquivalentUsd = null;
  input.projects[1].apiEquivalentUsd = 4.56; // null 아닌 행은 그대로 값이 나온다
  const md = buildReportMarkdown(input);
  assert.ok(md.includes('미상'));
  assert.ok(!md.includes('$0'), 'null 환산가치가 $0 으로 렌더되었다');
  assert.ok(md.includes('$4.56'));
});

// 5. demo 는 "합성 시드"를 명시 - LLM 이 실데이터로 오인하지 않게. live 에는 그 문구가 없다.
test('report md: demo -> "합성 시드" 표기, live -> 없음', () => {
  const demo = buildReportMarkdown(baseInput());
  assert.ok(demo.includes('합성 시드'));
  const live = buildReportMarkdown({ ...baseInput(), mode: 'live' });
  assert.ok(!live.includes('합성 시드'));
});

// 6. 결정적 - 시계를 읽지 않는다. 같은 입력이면 같은 문자열.
test('report md/json: 같은 입력이면 같은 출력 (결정적)', () => {
  const a = buildReportMarkdown(baseInput());
  const b = buildReportMarkdown(baseInput());
  assert.equal(a, b);
  assert.deepEqual(buildReportJson(baseInput()), buildReportJson(baseInput()));
});

// 7. JSON 리포트는 직렬화 라운드트립을 통과한다 (undefined/NaN/함수 없음).
test('report json: JSON.parse(JSON.stringify(x)) 라운드트립', () => {
  const j = buildReportJson(baseInput());
  assert.deepStrictEqual(JSON.parse(JSON.stringify(j)), j);
});

// 8. 경로 유출 방지 - 절대경로가 라벨로 들어와도 리포트에는 마지막 세그먼트만 나간다.
test('report md/json: 프로젝트 라벨에 / 로 시작하는 절대경로가 없다', () => {
  const input = baseInput();
  input.projects[0].project = '/root/leak/secret-project';
  const md = buildReportMarkdown(input);
  assert.ok(!md.includes('/root/leak'), '절대경로가 마크다운에 유출되었다');
  assert.ok(md.includes('secret-project'));
  assert.ok(!/^\|\s*\//m.test(md), '표의 라벨 셀이 / 로 시작한다');
  const json = JSON.stringify(buildReportJson(input));
  assert.ok(!json.includes('/root/leak'), '절대경로가 JSON 에 유출되었다');
});

// 9. 프로젝트가 많아도 리포트는 짧게 유지된다 - 상위 10 + "기타" 접기.
test('report md: 프로젝트 10개 초과 시 상위 10 + 기타로 접는다', () => {
  const input = baseInput();
  input.projects = Array.from({ length: 15 }, (_, i) => ({
    project: `proj-${String(i).padStart(2, '0')}`,
    sidechainEvents: 0,
    events: 10,
    inputTokens: (15 - i) * 1_000, // proj-00 이 가장 크다
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    apiEquivalentUsd: 0.1,
  }));
  const md = buildReportMarkdown(input);
  assert.ok(md.includes('proj-00'));
  assert.ok(md.includes('기타 (5개)'));
  assert.ok(!md.includes('proj-14'), '하위 프로젝트가 접히지 않았다');
});

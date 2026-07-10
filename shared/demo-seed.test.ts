// 시드 테스트. 핵심은 두 가지다.
//   1. 완전 합성이다 (완료 기준 6). 실 경로·실 프로젝트명이 없다.
//   2. 시드만으로 완료 기준 5의 두 수치가 의미 있게 렌더된다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../collector/db.ts';
import { generateSeed, loadSeed, seedRawJson } from './demo-seed.ts';
import { abandonedHeadroom, scopeRanking, attributionByProject, collectionGaps, resetEvents } from './queries.ts';

const END = Date.parse('2026-07-09T12:00:00Z');

function seededDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  loadSeed(db, generateSeed(END));
  return db;
}

test('the generator is deterministic - same seed, same bytes', () => {
  assert.equal(JSON.stringify(generateSeed(END)), JSON.stringify(generateSeed(END)));
});

test('a different seed gives different data', () => {
  assert.notEqual(JSON.stringify(generateSeed(END, 1)), JSON.stringify(generateSeed(END, 2)));
});

test('seed contains no real filesystem roots or usernames', () => {
  const text = JSON.stringify(generateSeed(END));
  for (const forbidden of ['/root/workspace', '/mnt/c/Users', '/home/', '.claude']) {
    assert.equal(text.includes(forbidden), false, `시드에 ${forbidden} 가 들어 있다`);
  }
});

test('snapshot raw_json mirrors the real response shape - limits use percent, not utilization', () => {
  const s = generateSeed(END).snapshots[0]!;
  const o = JSON.parse(seedRawJson(s));
  assert.equal(typeof o.five_hour.utilization, 'number');   // 최상위는 utilization
  for (const limit of o.limits) {
    assert.equal(typeof limit.percent, 'number');           // limits[] 원소는 percent
    assert.equal('utilization' in limit, false, 'limits[] 에 utilization 을 넣으면 실 응답과 다르다');
  }
  assert.equal(o.tangelo, null); // 모르는 코드네임 필드도 보존 형상을 흉내낸다
});

test('the seed answers completion criterion 5 - abandoned headroom renders', () => {
  const db = seededDb();
  const h = abandonedHeadroom(db, END - 28 * 86_400_000, END + 1);
  assert.ok(h.samples > 1000, `샘플이 ${h.samples} 건뿐이다`);
  assert.ok(h.abandonedPct !== null && h.abandonedPct > 10 && h.abandonedPct < 90,
    `버려진 헤드룸이 ${h.abandonedPct} 로 렌더할 값이 아니다`);
});

test('the seed answers completion criterion 5 - weekly_scoped fills first and is active', () => {
  const db = seededDb();
  const ranking = scopeRanking(db, END + 1);
  assert.equal(ranking.length, 3);
  assert.equal(ranking[0]!.kind, 'weekly_scoped', '데모가 보여줘야 할 이야기는 스코프가 먼저 찬다는 것이다');
  assert.equal(ranking[0]!.isActive, true);
  assert.equal(ranking[0]!.scopeModel, 'Fable');
  // 내림차순
  for (let i = 1; i < ranking.length; i++) {
    assert.ok(ranking[i - 1]!.percent! >= ranking[i]!.percent!);
  }
});

test('the seed produces a weekly sawtooth (completion criterion 2 shape)', () => {
  const seed = generateSeed(END);
  const vals = seed.snapshots.map((s) => s.weeklyAll);
  const drops = vals.filter((v, i) => i > 0 && v < vals[i - 1]! - 30).length;
  assert.ok(drops >= 3, `주간 리셋 하락이 ${drops} 회뿐이다 (4주면 3회 이상이어야 한다)`);
});

test('the seed yields weekly_all reset events in the dashboard window - the trend markers depend on this', () => {
  const db = seededDb();
  // 대시보드와 같은 윈도우: 최근 28일 (web/lib/data.ts 의 RANGE_DAYS).
  const ev = resetEvents(db, END - 28 * 86_400_000, END + 1);
  const weekly = ev.filter((e) => e.kind === 'weekly_all');
  assert.ok(weekly.length >= 1, '데모 시드에 weekly_all 리셋 톱니가 없다 - 트렌드 차트에 마커가 렌더되지 않는다');
});

test('the seed has attributable projects and separately counted subagents', () => {
  const db = seededDb();
  const rows = attributionByProject(db, 0, END + 1, ['/demo/workspace']);
  assert.ok(rows.length >= 3, '프로젝트가 갈리지 않는다');
  assert.ok(rows.every((r) => !r.project.startsWith('/')), '프로젝트 라벨에 경로가 새어 나왔다');
  assert.ok(rows.some((r) => r.sidechainEvents > 0), '서브에이전트 이벤트가 없다');
  assert.ok(rows.every((r) => r.apiEquivalentUsd !== null), '데모에 단가 미상 이벤트가 있다');
});

test('the seed includes auth_skip holes - the demo must not hide them', () => {
  const db = seededDb();
  const gaps = collectionGaps(db, 0, END + 1);
  assert.ok(gaps.authSkip > 0, 'auth_skip 이 0 이면 데모가 현실을 감춘다');
  assert.equal(gaps.gapPct, 0, 'auth_skip 은 결손율에 들어가면 안 된다');
});

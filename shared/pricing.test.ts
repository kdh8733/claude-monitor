// M7 단가표 테스트. 핵심은 "현재가로 과거를 소급 계산하지 않는다" (CLAUDE.md 5항).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPrice, apiEquivalentUsd, PRICES } from './pricing.ts';

const NONE = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 };
const at = (iso: string) => Date.parse(iso);

// 이 테스트가 이 마일스톤의 존재 이유다. 현재가 소급 계산이면 실패한다.
test('past events are priced at the price in effect then, not the current price', () => {
  const before = at('2026-07-09T00:00:00Z'); // 도입가 구간
  const after = at('2026-09-15T00:00:00Z');  // 표준가 구간

  assert.equal(findPrice('claude-sonnet-5', 'standard', 'standard', before)!.inputPerMTok, 2);
  assert.equal(findPrice('claude-sonnet-5', 'standard', 'standard', after)!.inputPerMTok, 3);

  const tokens = { ...NONE, inputTokens: 1_000_000, outputTokens: 1_000_000 };
  assert.equal(apiEquivalentUsd('claude-sonnet-5', 'standard', 'standard', before, tokens), 12); // 2 + 10
  assert.equal(apiEquivalentUsd('claude-sonnet-5', 'standard', 'standard', after, tokens), 18);  // 3 + 15
});

test('this project data window falls entirely inside the Sonnet 5 introductory period', () => {
  // 데이터 구간은 2026-05-08 ~ 이고 도입가는 2026-08-31 까지다.
  for (const iso of ['2026-05-08T00:00:00Z', '2026-07-09T23:59:59Z', '2026-08-31T23:59:59Z']) {
    const p = findPrice('claude-sonnet-5', 'standard', 'standard', at(iso));
    assert.equal(p!.inputPerMTok, 2, `${iso} 에서 표준가가 적용됐다`);
  }
});

test('the boundary belongs to the new price', () => {
  const boundary = at('2026-09-01T00:00:00Z');
  assert.equal(findPrice('claude-sonnet-5', 'standard', 'standard', boundary)!.inputPerMTok, 3);
  assert.equal(findPrice('claude-sonnet-5', 'standard', 'standard', boundary - 1)!.inputPerMTok, 2);
});

test('unknown model with real tokens yields null, not zero', () => {
  // null 은 0 이 아니다. "공짜"와 "모른다"를 구분하지 못하면 대시보드가 거짓말을 한다.
  const t = at('2026-07-09T00:00:00Z');
  assert.equal(findPrice('claude-unknown-9', 'standard', 'standard', t), null);
  assert.equal(apiEquivalentUsd('claude-unknown-9', 'standard', 'standard', t, { ...NONE, outputTokens: 1 }), null);
});

test('unpriced speed (fast mode) yields null, not the standard price', () => {
  // /fast 단가는 확인하지 못했다. 조용히 standard 로 계산하면 대시보드가 거짓말을 한다.
  assert.equal(findPrice('claude-opus-4-8', 'fast', 'standard', at('2026-07-09T00:00:00Z')), null);
});

test('absent speed and service_tier are read as standard (old records)', () => {
  const p = findPrice('claude-opus-4-8', null, null, at('2026-07-09T00:00:00Z'));
  assert.equal(p!.inputPerMTok, 5);
});

test('cache rates derive from base input: 5m write 1.25x, 1h write 2x, read 0.1x', () => {
  const t = at('2026-07-09T00:00:00Z');
  const M = 1_000_000;
  // opus-4-8 base input = $5
  assert.equal(apiEquivalentUsd('claude-opus-4-8', 'standard', 'standard', t, { ...NONE, cacheReadInputTokens: M }), 0.5);
  assert.equal(apiEquivalentUsd('claude-opus-4-8', 'standard', 'standard', t, { ...NONE, cacheCreation5mTokens: M }), 6.25);
  assert.equal(apiEquivalentUsd('claude-opus-4-8', 'standard', 'standard', t, { ...NONE, cacheCreation1hTokens: M }), 10);
});

test('every model observed in this project has a price', () => {
  // 트랜스크립트 실측 모델 분포. 하나라도 빠지면 환산가치가 조용히 null 이 된다.
  const observed = ['claude-opus-4-8', 'claude-fable-5', 'claude-haiku-4-5', 'claude-sonnet-5', 'claude-sonnet-4-6'];
  for (const m of observed) {
    assert.ok(findPrice(m, 'standard', 'standard', at('2026-07-09T00:00:00Z')), `${m} 단가 없음`);
  }
});

// 실측: 트랜스크립트는 haiku 를 별칭이 아니라 날짜 붙은 전체 ID 로 기록한다.
test('dated snapshot model ids resolve to the same price as their alias', () => {
  const t = at('2026-07-09T00:00:00Z');
  const dated = findPrice('claude-haiku-4-5-20251001', 'standard', 'standard', t);
  const alias = findPrice('claude-haiku-4-5', 'standard', 'standard', t);
  assert.ok(dated, '날짜 붙은 haiku ID 의 단가가 없다');
  assert.equal(dated.inputPerMTok, alias!.inputPerMTok);
  assert.equal(dated.outputPerMTok, alias!.outputPerMTok);
});

test('an unknown dated id still yields null - we do not guess by prefix', () => {
  assert.equal(findPrice('claude-mystery-9-9-20260101', 'standard', 'standard', at('2026-07-09T00:00:00Z')), null);
});

// 실측: Claude Code 가 만드는 `<synthetic>` 메시지는 토큰이 전부 0 이다.
// 0 곱하기 모르는 단가는 0 이다. 이걸 "단가 미상"으로 세면 잡음만 늘어난다.
test('zero tokens cost zero even when the model is unknown', () => {
  assert.equal(apiEquivalentUsd('<synthetic>', null, null, at('2026-07-09T00:00:00Z'), NONE), 0);
  assert.equal(apiEquivalentUsd('claude-unknown-9', null, null, at('2026-07-09T00:00:00Z'), NONE), 0);
});

test('nonzero tokens on an unknown model still yield null', () => {
  const t = { ...NONE, inputTokens: 1 };
  assert.equal(apiEquivalentUsd('claude-unknown-9', null, null, at('2026-07-09T00:00:00Z'), t), null);
});

// 실측(15,921건)상 cache_creation_input_tokens == 5m + 1h 다. 깨지면 조용히 $0 이 되는 자리다.
test('unbroken-down cache_creation yields null, not a silent zero', () => {
  const t = at('2026-07-09T00:00:00Z');
  const opts = { ...NONE, cacheCreation5mTokens: 100, cacheCreation1hTokens: 0 };

  assert.equal(apiEquivalentUsd('claude-opus-4-8', 'standard', 'standard', t,
    { ...opts, cacheCreationInputTokens: 100 }) !== null, true, '정합하면 계산돼야 한다');

  assert.equal(apiEquivalentUsd('claude-opus-4-8', 'standard', 'standard', t,
    { ...opts, cacheCreationInputTokens: 500 }), null, '분해 안 된 400 토큰이 조용히 무시됐다');
});

test('no duplicate (model, speed, tier, effectiveFrom) rows', () => {
  const keys = PRICES.map((p) => `${p.model}|${p.speed}|${p.serviceTier}|${p.effectiveFrom}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('zero tokens cost zero, not null, when the price is known', () => {
  assert.equal(apiEquivalentUsd('claude-opus-4-8', 'standard', 'standard', at('2026-07-09T00:00:00Z'), NONE), 0);
});

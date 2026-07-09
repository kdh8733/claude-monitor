# claude-monitor - ROADMAP

> Goal의 단일 원천. 마일스톤 분해는 `/project-plan` 이 이 파일에 추가한다.

## Goal

Claude Max 5x 구독의 **한도 소진율**과 **사용 귀속**을 지속 기록해,
"나는 요금제를 얼마나 활용하고 있는가"에 숫자로 답하는 대시보드.

문제 정의 (사용자 원문): *"Pro를 쓰기엔 항상 부족한데, Max를 꽉 채워 쓰진 않는 것 같다."*

이 질문에 답할 수 있는 데이터는 현재 아무 데도 축적되고 있지 않다.
Anthropic은 **현재 시점 게이지만** 제공하고 히스토리를 주지 않으며,
Claude Code 트랜스크립트는 **기본 보존 정책에 의해 소멸**한다.
기록을 시작하는 것 자체가 이 프로젝트의 1차 가치다.

## 검증된 사실 (2026-07-09 실측)

프로젝트 착수 전 검증한 내용. 재조사 불필요.

### 청구 구조
- `~/.claude.json` → `oauthAccount`: `billingType: stripe_subscription`,
  `organizationType: claude_max`, `organizationRateLimitTier: default_claude_max_5x`,
  `hasExtraUsageEnabled: false`, `customApiKeyResponses: null`
- **토큰당 요금이 존재하지 않는다.** 실제 청구액은 매달 고정.
  추가 사용량 과금이 꺼져 있으므로, 한도를 넘으면 돈이 나가는 게 아니라 **작업이 막힌다.**
- 따라서 희소 자원은 돈이 아니라 **한도 헤드룸**이다. 이것이 1급 지표다.

### 데이터 소스 A - 한도 게이지 (권위 있음)
`GET https://api.anthropic.com/api/oauth/usage`
- 헤더: `Authorization: Bearer <accessToken>`, `anthropic-beta: oauth-2025-04-20`
- 토큰: `~/.claude/.credentials.json` → `claudeAiOauth.{accessToken,refreshToken,expiresAt}`
  (accessToken 수명 약 8시간 관측 → 데몬이 갱신을 처리해야 함)
- 응답 형태 (2026-07-09 실측, HTTP 200):
  ```
  five_hour.utilization        21.0    resets_at 2026-07-09T10:20:00Z
  seven_day.utilization        41.0    resets_at 2026-07-10T13:00:00Z
  limits[]  kind=session       21%   is_active=false
            kind=weekly_all    41%   is_active=false
            kind=weekly_scoped 67%   is_active=true   scope.model.display_name=Fable
  extra_usage.is_enabled       false
  spend.enabled                false
  ```
- **스냅샷만 준다. 히스토리도 귀속 정보도 없다.**
- 미문서화 엔드포인트. `tangelo`, `iguana_necktie` 같은 코드네임 필드가 null로 존재 →
  **스키마 드리프트를 전제로 저장 설계할 것** (원본 JSON 보존 + 파생 컬럼).

### 데이터 소스 B - 사용 귀속 (트랜스크립트)
`~/.claude/projects/<slug>/<sessionId>.jsonl`
- WSL: 1,860 파일 / usage 이벤트 22,565건 / 316MB / 2026-06-03 ~
- Windows(`/mnt/c/Users/kdh87/.claude/projects`): 14 파일 / 6,826건 / **2026-05-08 ~**
  (WSL보다 과거 데이터 보유 → 병합의 실익 확인됨)
- `message.usage`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `cache_creation.ephemeral_{5m,1h}_input_tokens`, `service_tier`
- 라인 필드: `timestamp`, `sessionId`, `cwd`, `gitBranch`, `version`, `requestId`,
  `isSidechain`(서브에이전트 판별), `type`
- 모델 분포: `opus-4-8` 14,159 / `fable-5` 4,335 / `haiku-4-5` 3,590 / `sonnet-5` 159 / `sonnet-4-6` 127
- 한도 도달 이벤트: `apiErrorStatus: 429` + `"You've hit your session limit · resets ..."` (7건)
- **`costUSD` 필드 없음.** API 환산가치는 모델별 단가표를 곱해 산출해야 하며,
  과거 데이터는 **당시 단가**로 계산되어야 한다 (단가 개정 시 소급 왜곡 방지).

### 반증된 가설 (재시도 금지)
> "트랜스크립트의 5시간 롤링 토큰 합으로 한도 소진율을 역산할 수 있다."

**틀렸다.** 06-17에 billable 309K에서 429가 발생했고, 06-25에는 13.0M을 쓰고도 발생하지 않았다 (42배 차이).
모델별 가중치 가설도 반증: 06-25 윈도우는 Opus 11.7M으로 오히려 Opus 편중이었다.
Windows 트랜스크립트에도 해당 시각 활동이 0건이므로 멀티머신 누락도 아니다.

**결론: Claude Code 밖(claude.ai 웹/데스크톱)의 사용이 같은 한도를 소모한다.**
트랜스크립트는 탱크 잔량을 설명할 수 없다. 소스 A가 유일한 권위다.
소스 B는 "어디에 썼나"만 답한다. 두 소스는 대체재가 아니라 보완재다.

## 완료 기준 (검증 가능)

각 항목은 실행 가능한 검증 명령/절차를 동반해야 한다. "동작하게 만들기"는 기준이 아니다.

1. **수집 무결성** - 소스 A 스냅샷을 정해진 간격으로 30일 이상 적재하고, 결손율 < 1%.
   accessToken 만료(약 8시간) 구간을 자동 갱신으로 통과한 기록이 로그에 있을 것.
   - 검증: 적재 테이블의 타임스탬프 간격 히스토그램. 기대 간격 초과 gap 수 / 총 기대 슬롯 < 1%.

2. **리셋 경계 재현** - 임의 7일 구간에 대해 `weekly_all` 소진율 시계열을 그리면,
   `resets_at` 시점에 소진율이 하락하는 톱니가 관측된다.
   - 검증: 리셋 시각 전후 샘플에서 값이 감소함을 단언하는 테스트.

3. **귀속 정확도** - 임의 5시간 윈도우에 대한 프로젝트별/모델별 billable 토큰 합이
   원본 JSONL 재계산값과 **오차 0**으로 일치.
   - 검증: 독립 구현한 재계산 스크립트와 대시보드 API 응답을 비교하는 테스트.

4. **소스 어댑터 확장성** - 코드 수정 없이 **설정만으로** Windows 소스를 추가해
   두 소스 병합 통계가 산출된다. 중복 `sessionId` 제거가 검증된다.
   - 검증: 어댑터 1개일 때와 2개일 때의 이벤트 수 차이 = Windows 고유 이벤트 수.

5. **질문에 답하기** - 대시보드가 한 화면에서 다음 두 가지에 답한다.
   - "지난 N주간 버려진 헤드룸" (= 100% - `weekly_all` 구간 평균)
   - "가장 먼저 차는 스코프" (현재 관측상 `weekly_scoped` / Fable 67%)
   - 검증: 실데이터로 두 수치가 렌더되고, 시드 데이터로 재현 가능.

6. **데이터 유출 0** - 공개 레포에 실데이터 0바이트.
   - 검증: `git log -p | grep -c` 로 프롬프트 원문·실 프로젝트명 부재 확인.
     데모 시드만으로 전체 화면 스크린샷 재현 가능.

7. **UI 품질** - 라이트/다크 양쪽 렌더. 주요 뷰 Lighthouse 접근성 90+.
   - 검증: Lighthouse CI 리포트 첨부.

## Non-goals

명시적으로 하지 않는 것. 요청 없이 추가하지 말 것.

- **실시간 스트리밍** (WebSocket/SSE). 이 데이터의 가치는 시계열 축적에 있지 초 단위 갱신에 있지 않다.
- **비용 청구 추적.** 구독제라 청구액이 고정이다. "API 환산가치"는 ROI 서사용 파생지표일 뿐 청구액이 아니며, UI에 그 사실을 명시한다.
- **다중 사용자 / 타인 계정 지원.** 개인용이다.
- **5시간 한도 역산.** 위 반증 참조. 소스 A를 쓴다.

## 열린 질문 (관측으로 해소)

- `limits[].is_active` 의 정확한 의미. "현재 바인딩 제약"으로 **추정** 중이며 미확인.
- `weekly_scoped` 가 Fable 외 다른 모델에도 생기는지. 현재 1개만 관측.
- `cleanupPeriodDays` 기본값의 실제 동작. 문서상 30일로 알려져 있으나
  2026-06-04 파일이 35일 경과 후에도 잔존 → **직접 확인하지 못했다.**

## 마일스톤

`/project-plan` 으로 분해한다.

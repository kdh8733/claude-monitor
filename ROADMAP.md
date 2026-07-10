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
- 응답 형태 (2026-07-09 수집기로 실적재, HTTP 200, raw 1,647바이트):
  ```
  five_hour   { utilization: 28, resets_at, limit_dollars: null, used_dollars: null, remaining_dollars: null }
  seven_day   { utilization: 45, resets_at, limit_dollars: null, ... }
  limits[]    { kind, group, percent, severity, resets_at, scope, is_active }
              kind=session       group=session  percent=28  is_active=false  scope=null
              kind=weekly_all    group=weekly   percent=45  is_active=false  scope=null
              kind=weekly_scoped group=weekly   percent=68  is_active=true
                                 scope.model.display_name=Fable  scope.model.id=null  scope.surface=null
  extra_usage { is_enabled: false, monthly_limit: null, utilization: null, ... }
  spend       { enabled: false, percent: 0, used: {amount_minor:0,...}, disclaimer, ... }
  member_dashboard_available: false
  ```
- **소진율 필드명 주의.** 최상위 `five_hour`/`seven_day` 는 `utilization` 이지만
  **`limits[]` 원소는 `percent` 다.** `limits[]` 안에서 `utilization` 을 꺼내면 조용히 NULL 이 나온다.
  (2026-07-09 실적재로 확인. 이전 기록은 이 구분이 부정확했다.)
- **`weekly_scoped` 는 최상위에 대응 필드가 없다.** `limits[]` 안에만 있다.
  완료 기준 5의 "가장 먼저 차는 스코프"는 반드시 `limits[]` 를 `json_each` 로 펼쳐 읽어야 한다.
- 최상위 코드네임/미사용 필드 (전부 현재 null, **버리지 말 것**):
  `seven_day_oauth_apps`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_cowork`,
  `seven_day_omelette`, `tangelo`, `iguana_necktie`, `omelette_promotional`,
  `nimbus_quill`, `cinder_cove`, `amber_ladder`
  → `seven_day_opus` / `seven_day_sonnet` 는 모델별 주간 버킷으로 **채워질 수 있다.**
- **스냅샷만 준다. 히스토리도 귀속 정보도 없다.**
- 미문서화 엔드포인트. **스키마 드리프트를 전제로 저장 설계할 것**
  (원본 JSON verbatim 보존 + VIRTUAL 파생 컬럼).

### 데이터 소스 B - 사용 귀속 (트랜스크립트)
`~/.claude/projects/<slug>/<sessionId>.jsonl`
- WSL: 2,070 파일 / usage 라인 28,493건 / distinct `message.id` 12,294 / 325MB / 2026-06-03 ~
- Windows(`/mnt/c/Users/<user>/.claude/projects`, 코드에서는 자동 탐지): 52 파일 /
  usage 라인 8,569건 / distinct `message.id` 3,388 / **2026-05-08 ~**
  (WSL보다 과거 데이터 보유 → 병합의 실익 확인됨. 다만 현재 상시 사용하지 않아 1회성 백필이다)
- **소스 간 교집합 0** (`message.id` 도 `sessionId` 도). union = 15,684. (2026-07-09 전수 실측)
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

1. **수집 무결성** - 소스 A 스냅샷을 30일 이상 적재한다. **결손율 < 1%.**
   여기서 결손율의 분모는 **"cron이 발화했고 accessToken이 유효했던 슬롯"** 이다.
   즉 이 기준은 *수집기가 조용히 죽지 않았는가* 를 잰다. 머신이 꺼진 구간과 토큰 만료 구간은
   수집기의 결함이 아니므로 분모에서 빠진다.
   - 검증: `collector_run` 의 status 분포. `error`+`http_error` / (`ok`+`error`+`http_error`) < 1%.
   - **함께 보고할 것 (숨기지 않는다):** `auth_skip` 슬롯 수와 그 시간대 분포. 이것은 결손율에
     들어가지 않지만 **데이터에 실제로 뚫린 구멍**이다. 이 수치를 가리면 대시보드가 거짓말을 한다.
   - 배경: 수집기는 refreshToken을 소비하지 않는다(ride-along, `004` C5-A). 회전 여부가 미검증이라
     갱신하면 본체 Claude Code 인증을 깰 수 있기 때문이다. 대가로 유휴 구간(주로 야간)에 구멍이 생긴다.
     이 구멍을 메우는 경로는 `T4` (수집기 전용 독립 자격증명) 다.

2. **리셋 경계 재현** - 임의 7일 구간에 대해 `weekly_all` 소진율 시계열을 그리면,
   `resets_at` 시점에 소진율이 하락하는 톱니가 관측된다.
   - 검증: 리셋 시각 전후 샘플에서 값이 감소함을 단언하는 테스트.

3. **귀속 정확도** - 임의 5시간 윈도우에 대한 프로젝트별/모델별 billable 토큰 합이
   원본 JSONL 재계산값과 **오차 0**으로 일치.
   - 검증: 독립 구현한 재계산 스크립트와 대시보드 API 응답을 비교하는 테스트.

4. **소스 어댑터 확장성** - 코드 수정 없이 **설정만으로** Windows 소스를 추가해
   두 소스 병합 통계가 산출된다. 중복 `message.id` 제거가 검증된다.
   - 검증: 어댑터 1개일 때와 2개일 때의 이벤트 수 차이 = Windows 고유 `message.id` 수.
   - 주의: dedup 키는 `sessionId` 가 아니다. usage 라인을 그냥 합치면 output 토큰이
     **2.5~3.0배 과대계상**된다 (한 `message.id` 가 여러 라인에 누적 기록되고 종단값이 최대).
     근거는 `docs/decisions/004-reconciliation.md` C2 와 그 아래 전수 실측 절.

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

갱신: 2026-07-09 / 스택: `docs/decisions/001-stack.md` (승인)

### 순서 원칙

**수집이 UI보다 먼저다.** 게이지 엔드포인트는 히스토리를 주지 않고, 트랜스크립트는
보존 정책에 노출돼 있다. 수집기가 없는 하루는 **영구히 잃는 하루**다.
대시보드를 먼저 만들면 그동안 채울 데이터가 사라진다.

완료 기준 1(30일 무중단)과 2(리셋 경계 재현)는 **시간이 지나야 검증된다.**
코드로 앞당길 수 없으므로 아래 "시간 의존" 절에 격리한다.

### 1단계 - 기록을 시작한다 (가장 급함)

- [x] **M1 스냅샷 수집기 최소판** (2026-07-09) - `/api/oauth/usage` 폴링 -> raw JSON 통째로 SQLite 적재.
  파생 컬럼(`five_hour_pct`, `weekly_all_pct`, `resets_at`)은 `json_extract` 로 뽑는다.
  파싱 실패가 적재 실패가 되지 않아야 한다 (모르는 필드 보존).
  - 검증: 5분 간격으로 30분 구동 후 `SELECT count(*) FROM snapshot` 이 6 (±1).
    응답 스키마에 없는 키를 주입한 픽스처로도 적재가 성공한다 (단위 테스트).

- [x] **M2 토큰 ride-along** (2026-07-09) - 수집기는 `~/.claude/.credentials.json` 을 **읽기만** 한다.
  `refreshToken` 을 절대 소비·재기록하지 않는다 (회전 시 본체 Claude Code 인증 파손. `004` C5).
  `expiresAt` 이 지났으면 그 폴을 건너뛰고 `collector_run` 에 `auth_skip` 으로 남긴다.
  토큰은 로그/에러/커밋 어디에도 남기지 않는다 - 길이와 만료시각만 (`CLAUDE.md` 2항).
  - 검증: `expiresAt` 을 과거로 조작하면 HTTP 호출 없이 `auth_skip` 1행이 남고 종료 코드가 0이다.
    수집기 구동 전후로 `.credentials.json` 의 `sha256sum` 이 동일하다 (파일을 안 건드림).
    로그 전문에 `grep -c "sk-\|ey[A-Za-z0-9]\{20,\}"` 가 0.
  - **자동 갱신은 구현하지 않는다.** 되살리려면 `T4` 를 먼저 통과해야 한다.
  - 의존: M1

- [x] **M3 트랜스크립트 아카이브** (2026-07-09) - 원본 JSONL을 소멸 전에 확보한다.
  파싱보다 **보존이 먼저**다. 스키마를 몰라도 일단 복사한다.
  - 검증: 아카이브 파일 수 = 원본 파일 수. `sha256sum` 샘플 10개 일치.
  - 의존: 없음 (M1과 병렬 가능)

- [x] **M4 cron 배선** (2026-07-09) - `claude-config/runtime/cron/` 패턴 재사용해 M1+M3를 스케줄링.
  실패 시 조용히 죽지 않도록 알림.
  - 검증: crontab 등록 후 24시간 뒤 적재 gap 0. 의도적 실패 주입 시 알림 수신.
  - 의존: M1, M3

### 2단계 - 귀속을 붙인다

- [x] **M5 트랜스크립트 파서 + 귀속 스키마** (2026-07-09) - `message.usage` 를 이벤트 테이블로.
  `sessionId`, `cwd`, 모델, `isSidechain`(서브에이전트), `requestId` 보존.
  - 검증 (**완료 기준 3**): 임의 5시간 윈도우의 프로젝트별/모델별 billable 토큰 합이
    독립 구현한 재계산 스크립트 결과와 **오차 0**. TDD로 테스트를 먼저 쓴다.
  - 의존: M3

- [x] **M6 소스 어댑터** (2026-07-09) - WSL 어댑터 + Windows 어댑터. 중복 `message.id` 제거.
  구현체 2개로 인터페이스를 검증한다 (`CLAUDE.md` 7항의 허용된 예외).
  Windows 소스는 상시 병행 수집이 아니라 **1회성 과거 백필**이다 (2026-05-08 ~ 구간 보유).
  - 검증 (**완료 기준 4**): 설정만 바꿔 어댑터를 1개 -> 2개로 늘렸을 때
    이벤트 수 증가분 = Windows 고유 `message.id` 수. 중복 메시지가 이중 계상되지 않는다.
  - 의존: M5

- [x] **M7 단가표 + API 환산가치** (2026-07-09) - `effective_from` 을 갖는 모델 단가 테이블.
  과거 이벤트는 **당시 단가**로 계산한다 (`CLAUDE.md` 5항).
  - 검증: 단가 개정을 모사한 픽스처에서, 개정 전 이벤트가 개정 전 단가로 계산됨을
    단언하는 테스트. 현재가 소급 계산 시 실패하는 테스트를 먼저 쓴다.
  - 의존: M5

- [x] **M8 집계 쿼리 계층** (2026-07-09) - "버려진 헤드룸"(100% - `weekly_all` 구간 평균),
  "가장 먼저 차는 스코프", 프로젝트/모델/시간대별 귀속.
  - 검증: 각 쿼리에 대해 손계산 가능한 소형 픽스처로 기대값 테스트.
  - 의존: M1, M6, M7

### 3단계 - 보여준다

- [x] **M9 Next.js 셸 + 디자인 시스템** (2026-07-10) - shadcn/ui + Tailwind v4.
  자체 팔레트, bespoke 대시보드 셸. 라이트/다크 토큰을 차트와 한 시스템으로 묶는다.
  - 검증: 두 테마에서 셸이 렌더된다. RSC가 SQLite를 읽기 전용으로 열고,
    클라이언트 번들에 실데이터가 포함되지 않는다 (빌드 산출물 grep).
  - 의존: M8

- [x] **M10 visx 차트** (2026-07-10) - 게이지(소진율), 시계열(추이), 스택 바(귀속), 히트맵(시간대).
  게이지는 SVG arc 수작업. 차트 코드 작성 **전에** `dataviz` 스킬을 읽는다.
  - 검증 (**완료 기준 5**): 한 화면에서 "버려진 헤드룸"과 "가장 먼저 차는 스코프"가
    실데이터로 렌더된다. 시드 데이터로 동일 화면 재현.
  - 의존: M9

- [x] **M11 데모 시드 + 공개 배포** (2026-07-10) - 합성 픽스처로 `output: export` 정적 빌드 -> Vercel.
  - 검증 (**완료 기준 6**): `git log -p` 에 프롬프트 원문/실 프로젝트명 부재.
    배포된 페이지의 네트워크 응답에 실데이터 0. 시드만으로 전 화면 스크린샷 재현.
  - 의존: M10

- [x] **M12 접근성** (2026-07-10) - Lighthouse 접근성 90+.
  - 검증 (**완료 기준 7**): Lighthouse CI 리포트 첨부. 두 테마 모두.
  - 의존: M10

### 시간 의존 (코드로 앞당길 수 없음)

- [ ] **T1 수집 무결성 30일** (**완료 기준 1**) - 결손율 < 1%.
  - 검증: 적재 타임스탬프 간격 히스토그램. gap 수 / 기대 슬롯 < 0.01.
  - 착수 가능 시점: M4 완료 + 30일

- [ ] **T2 리셋 경계 재현** (**완료 기준 2**) - `resets_at` 시점에 소진율 톱니 관측.
  - 검증: 리셋 전후 샘플에서 값 감소를 단언하는 테스트.
  - 착수 가능 시점: M4 완료 + 7일 (주간 리셋 1회 이상 필요)

- [ ] **T3 열린 질문 해소** - `is_active` 의 의미, `weekly_scoped` 가 Fable 외 모델에도 생기는지.
  - 검증: 축적된 스냅샷에서 `is_active` 가 바뀌는 순간과 그때 실제로 막혔는지 대조.
  - 착수 가능 시점: M1 완료 + 충분한 관측 (429 이벤트 재발 필요)

- [ ] **T4 야간 결손 해소 (수집기 전용 자격증명)** - 시간이 아니라 **조사**가 게이트다.
  묻는 것: Claude Code가 본체와 분리된 두 번째 OAuth 자격증명 발급을 허용하는가.
  허용된다면 수집기가 자기 refreshToken을 갖고 회전시켜도 본체가 안 깨지고, `auth_skip` 이 0이 된다.
  - **비파괴 조사만 한다.** 본체의 `refreshToken` 을 소비하는 실험은 금지 (회전 시 인증 파손).
  - 성공 시: M2를 갱신 구현으로 승격하고 완료 기준 1의 분모를 "cron이 발화한 슬롯" 으로 되돌린다.
  - 실패/불가 시: ride-along 유지. `auth_skip` 을 영구 지표로 노출한다.
  - 의존: 없음 (M1과 병렬 조사 가능)

  #### 1차 문서 조사 (2026-07-10). **아직 안 열렸다.**

  - **확인함**: `ant auth login --profile <name>` 의 프로필은
    `~/.config/anthropic/credentials/<profile>.json` 에 저장된다. 본체 Claude Code 는
    `~/.claude/.credentials.json` 을 쓴다. **저장소가 분리돼 있다.** 출처:
    <https://platform.claude.com/docs/en/cli-sdks-libraries/cli/authentication>
  - **확인함**: refresh token 은 hard-expire 한다 - 사용해도 수명이 연장되지 않는다
    ("they don't slide with use"). 같은 출처.
  - **확인 못 함 (핵심 질문이 그대로 남았다)**: refresh token 이 **회전**하는지.
    공식 문서에 명시가 없다. hard-expire 는 회전과 다른 얘기다.
  - **확인 못 함**: 별도 프로필 토큰으로 `/api/oauth/usage` 를 부를 수 있는지. 미문서 엔드포인트다.
  - **미해결 리스크**: 공식 문서에 "Claude Code 가 프로필과 자기 로그인 사이의 auth 충돌을 경고할 수
    있다"는 언급이 있다. 프로필 생성이 본체에 무해하다는 것이 **문서로 확정되지 않았다.**

  **다음 단계는 사용자만 할 수 있고, 아직 승인되지 않았다.** `ant auth login --profile collector` 는
  브라우저 인증이며 본체 무해성이 미확정이다. (1차 조사 보고는 이 명령을 "완전 비파괴"라 썼다가
  경고 목록에서는 "실행 금지"로 분류했다. 자기모순이므로 안전한 쪽을 택한다.)

  **별도 확인 필요**: `/api/oauth/usage` 를 개인 수집기가 폴링하는 것이 이용약관상 허용되는지.
  조사에서 "OAuth 사용이 Claude Code 와 claude.ai 로 제한된다"는 3자 출처가 나왔으나
  **공식 문서로 확인하지 못했다.** 공개 레포이므로 README 에 이 불확실성을 명시한다.

## 후순위 / 보류

- **원격/멀티머신 수집 데몬** - M6의 어댑터로 확장 지점만 열어둔다.
  현재 WSL 외에 돌리는 것이 없으므로 구현 보류. 실사용이 생기면 착수.
- **DuckDB 기반 애드혹 분석 노트북** - SQLite `ATTACH` 로 필요할 때 CLI에서.
  런타임 의존성으로 넣지 않는다.
- **Parquet 내보내기 / DuckDB-WASM 데모** - M11의 정적 export로 충분하다.
  데모 요구가 커지면 재검토.
- **알림 (한도 임박 시 텔레그램)** - 요청되지 않았다. `claude-config` 에 텔레그램 자산이
  있어 유혹적이나, Goal이 "관측"이지 "개입"이 아니다.

## 완료 기록

- [x] **M1 스냅샷 수집기 + M2 토큰 ride-along** (2026-07-09) - `npm test` 14/14,
  `tsc --noEmit` exit 0, 런타임 의존성 0. 실 API 폴 2회 `status=ok`/`http_status=200`,
  자격증명 파일 `sha256` 불변, 고아 스냅샷 0행, `journal_mode=wal`.
  - **아직 검증 안 된 것 (정직):** M1의 원래 검증 문구는 "5분 간격으로 30분 구동"이었다.
    벽시계 30분 구동은 하지 않았다. 대신 `runOnce` 6회 호출 -> 6행을 단위 테스트로 확인했다.
    **스케줄러가 실제로 5분마다 깨우는지는 M4(cron 배선)에서 검증한다.**
  - 실측이 설계를 반증한 것: `limits[]` 의 소진율 필드는 `utilization` 이 아니라 `percent` 다.
    픽스처가 틀린 형태였고 테스트가 그 픽스처를 검증하며 green 이었다 (테스트가 현실이 아니라
    자기 픽스처를 검증하는 전형). 실 응답 형태로 교체.
  - 구현 중 잡은 결함 3건: `Bearer undefined` 전송 가능(자격증명 스키마 드리프트),
    스냅샷/run 행 비원자성(불변식 I3 파손), fetch 타임아웃 부재(cron 프로세스 누적).

- [x] **M0 프로젝트 초기 형상** (2026-07-09) - 검증: `setup.sh --check` 드리프트 없음,
  `.gitignore` 가 실파일(`data/leak-test.jsonl`, `usage.sqlite`)을 차단함을 `git check-ignore` 로 확인,
  공개 레포 생성 및 push 완료 (실데이터 0바이트).
  스택 결정 축 2는 리뷰에서 뒤집힘 - DuckDB 인프로세스 동시성 제약(공식 문서)과
  `node:sqlite` 동시 read/write 실측(에러 0건)으로 `node:sqlite` 채택.

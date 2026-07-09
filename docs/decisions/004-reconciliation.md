# 004. 002/003 접합면 조정 + 외부 레퍼런스 반영

- 날짜: 2026-07-09 / 상태: **초안(제안)**. 미결 1건은 사용자 결정 대기.
- 이 문서는 `002-architecture-write-side.md`(쓰기 측)와 `003-architecture-read-side.md`(읽기 측)의
  **충돌을 해결**하고, 새 입력 두 가지를 반영한다. 충돌 항목에서는 **이 문서가 002/003보다 우선**한다.

## 새 입력

1. **사용자 정정 (2026-07-09)**: `/mnt/c` 하위 Windows Claude 경로는 현재 거의 쓰지 않는다.
   주 프로젝트 루트는 `/root/workspace` 하위다.
2. **외부 레퍼런스**: `hoangsonww/Claude-Code-Agent-Monitor` (CCAM, MIT, 778★, TypeScript,
   최종 푸시 2026-07-08). Claude Code 세션/에이전트/토큰을 SQLite에 적재하고 Express+React로
   보여준다. <https://github.com/hoangsonww/Claude-Code-Agent-Monitor>

---

## 레퍼런스에서 배운 것

CCAM은 우리와 목적이 다르다. **CCAM은 세션·에이전트 활동의 실시간 관측**(WebSocket, 칸반, 알림)이고,
우리는 **한도 소진율의 장기 시계열 + 귀속**이다. CCAM에는 `/api/oauth/usage` 게이지 개념 자체가 없다.
그래서 아키텍처를 베낄 대상은 아니다. 다만 **트랜스크립트를 돈으로 환산해 본 선행 구현**이라
우리가 못 본 것을 두 개 짚어준다.

| CCAM에서 관측 | 우리 설계의 상태 | 판정 |
|---|---|---|
| `model_pricing` 에 `fast_input_per_mtok`, 그리고 `token_usage` PK가 `(session_id, model, **speed**, **inference_geo**, **service_tier**)`. 주석: *"tokens are bucketed by these because each changes the per-token RATE (fast mode, US data residency, Batch API)"* | 002/003 **둘 다 단가 키를 `(model, effective_from)` 로만 잡음** | **채택.** 아래 C4 |
| `token_usage.baseline_*` 컬럼군. 주석: *"Compaction baselines preserve pre-rewrite totals (effective = current + baseline)"* | 002는 트랜스크립트 append-only 여부를 **"미확정"** 으로 남기고 해시 가드로 방어 | **002의 해시 가드 정당화.** 아래 C9 |
| `model_pricing.intro_until` 로 도입가 처리 (Sonnet 5 런치 할인 명시) | 003의 `effective_from` 이 더 일반적 | 우리 안 유지 |
| 수집 경로가 **hook 기반 실시간** + 트랜스크립트 보조. `token_usage` grain이 세션 단위 집계 | 우리는 트랜스크립트 배치, grain은 `message.id` | 우리 안 유지 (Goal이 장기 시계열) |
| 서버가 장기 구동 중 OOM (자체 설계문서 `2026-05-22-fix-transcript-cache-leak-design.md`: `data/dashboard.db` 192MB, `events` 251,244행, 트랜스크립트 캐시 무한 증가) | 우리는 상주 데몬을 기각하고 cron 단발 기동(002 축1) | **우리 안이 이 실패를 구조적으로 회피.** 매 슬롯 프로세스가 죽으므로 누수 축적 불가 |

`speed` / `inference_geo` 는 **우리 트랜스크립트에도 실재한다.** 최근 60개 파일 샘플:

```
"service_tier":"standard"        12,953
"speed":"standard"               12,951
"inference_geo":"not_available"  12,955
"compactMetadata": / "isCompactSummary":  각 36
```

현재는 전부 단일 값이다. 그러나 **이 환경은 Opus 4.8에서 `/fast` 토글이 가능**하고, 켜는 순간
`speed` 가 바뀌며 단가도 바뀐다. 지금 이 필드를 컬럼으로 보존하지 않으면, 나중에 fast 단가를
알게 됐을 때 **과거 구간을 소급 보정할 방법이 없다.** (`CLAUDE.md` 3항 "모르는 필드는 버리지 말고 보관"의
직접 적용.) `compactMetadata` 36건은 compaction이 실재함을 보여준다.

---

## 충돌 해결

### C1. 단가표는 어디 사는가 (**정면 충돌**)

- 002: `CREATE TABLE model_price (model, effective_from, ...)` 를 DB에 시딩.
- 003: TS 상수 배열. DB 테이블 안(b)을 **기각**.

**결정: 003 승 (TS 상수). 002의 `model_price` 테이블을 삭제한다.**

결정적 근거는 003도 002도 대지 못한 것이다. **Vercel 데모 빌드에는 수집기가 없고 SQLite도 없다.**
데모는 커밋된 시드에서 정적 빌드된다(003 축3). 단가가 "수집기가 시딩하는 DB 테이블"에만 산다면
**데모 화면은 API 환산가치를 계산할 수 없다.** 단가는 코드와 함께 커밋되는 것이어야 한다.
부차 근거: 단가는 공개 정보라 커밋 가능하고, git diff가 감사 로그가 되며(003 축2), 읽기 측은 DB를
읽기 전용으로 열어 쓰지 못한다.

002의 **I8은 유지**하되 문구를 고친다: "비용은 `usage_event` 에 저장하지 않는다. 단가는 이벤트
시각으로 조회해 **당시 단가**로 계산한다." - 조회 대상이 DB 테이블이 아니라 `shared` 의 단가 상수다.

### C2. 중복 제거 키 (**002가 옳고 ROADMAP이 틀렸다**)

- ROADMAP 완료기준 4 / M6: "중복 `sessionId` 제거"
- 003 요구 6: "`sessionId` 또는 `requestId`"
- 002: **`message.id`**. 실측 근거 - usage 라인 21,924건인데 distinct `message.id` 9,223건 (2.4:1).
  같은 `message.id` 가 스트리밍으로 여러 라인에 걸쳐 누적 기록되고, 종단값이 최대(6,916/6,916 = 100%).

**결정: `message.id`. ROADMAP 완료기준 4와 M6의 문구를 고친다.**
라인을 SUM하면 약 2.4배 과대계상된다. `sessionId` 단위 제거는 grain이 굵어 cross-machine resume 시
데이터를 잃는다. 003의 요구 6은 002의 I4/I5로 대체된다.

### C3. 스냅샷 파생 컬럼 - `weekly_scoped` 가 빠졌다 (**계약 공백**)

003 요구 3은 `weekly_scoped_pct`, `limits[]` 의 `kind`/`is_active`/`scope.model.display_name` 을
파생 컬럼으로 요구했다. **002의 DDL에는 없다.** 그런데 완료기준 5의 두 번째 질문
("가장 먼저 차는 스코프")이 정확히 이 데이터를 쓴다.

`limits[]` 는 **배열**이라 `json_extract(raw_json,'$.limits[2].utilization')` 같은 인덱스 경로는
원소 순서가 바뀌면 조용히 틀린 값을 준다. generated column으로 굳히기에 부적합하다.

**결정:**
- `snapshot` 의 generated column은 **최상위 안정 객체에만** 둔다: `five_hour.*`, `seven_day.*`, `extra_usage.*`.
- `limits[]` 는 **읽기 측이 `raw_json` 을 `json_each` 로 펼쳐서** `kind` 로 조회한다. 인덱스 위치에 의존하지 않는다.
- 계약에 명시: **`raw_json` 은 `limits` 배열을 verbatim 보존한다**(I1이 이미 보증).

### C4. 단가 키에 `speed` / `service_tier` 가 없다 (**둘 다 놓침, 레퍼런스가 짚어줌**)

**결정:**
- `usage_event` 에 `speed TEXT` 컬럼을 추가한다 (`service_tier` 는 이미 002 DDL에 있음).
- 단가 조회 키는 `(model, speed, service_tier, effective_from)` 로 넓힌다.
- **fast 모드의 실제 단가는 확인하지 못했다.** 지금 확정하지 않는다. 지금 하는 일은 **필드 보존**뿐이다.
  값이 전부 `standard` 인 동안은 단가표에 `standard` 행 하나만 두면 되고, `/fast` 를 켠 뒤
  단가를 알게 되면 그때 행을 추가한다. **보존은 지금, 단가는 나중.**
- `inference_geo` 는 컬럼으로 승격하지 않는다. 관측값이 `not_available` 뿐이고 `raw_usage_json` 에
  이미 보존된다. 필요해지면 그때 파생한다. (과설계 금지)

### C5. 토큰 갱신 vs 완료기준 1 (**미결 - 사용자 결정 필요. 아래 별도 절**)

### C6. 코드 배치 - 모노레포 정당화가 무너진다

003 축4의 모노레포 근거는 "collector가 Next.js 의존성을 끌고 오면 안 된다"였다.
그런데 **002의 수집기는 런타임 의존성이 0이다** - `node:sqlite`, `fetch`, `node:zlib` 전부 내장이고,
실행은 Node 24 네이티브 타입 스트리핑(`node collector/main.ts`)이다. 격리할 의존성이 존재하지 않는다.
남는 근거는 "타입 공유"인데, 그건 단일 패키지에서 `import` 하나로 자명하다.

**결정: 단일 패키지.** `collector/`, `web/`(Next.js), `shared/`(타입 + 단가표) 디렉터리로 나누되
`package.json` 은 하나. 003이 스스로 "되돌리기 비용 중간-높음"으로 적은 구조를, 지금 근거 없이
지불할 이유가 없다. 워크스페이스가 실제로 필요해지면(collector가 npm 의존성을 갖게 되면) 그때 쪼갠다.
부수 효과로 003이 "검증 못 함"으로 남긴 리스크(워크스페이스 cross-package raw `.ts` 스트리핑)가 소멸한다.

### C7. 완료기준 3의 "독립 오라클"은 생각보다 덜 독립적이다

003은 "프로덕션 경로(DB→SQL→TS) vs 오라클(원본 JSONL 재계산)"의 독립성이 **데이터 경로 분리**에서
나온다고 했다. 맞다. 그러나 C2가 드러낸 대로, **오라클 스크립트도 `message.id` 로 dedup하고 종단
usage를 취해야** 같은 답이 나온다. 두 구현이 같은 비자명한 규칙을 알아야 한다.

**결정:** grain 규칙(`message.id` 단위, 종단 usage)을 **스펙에 명시**하고, 두 구현이 각자 구현한다.
테스트가 검증하는 것은 "grain 규칙이 옳은가"가 아니라 "두 구현이 그 규칙을 같게 구현했는가"다.
grain 규칙 자체의 정당성은 002의 실측(2.4:1, 종단=max 100%)이 담보한다. 이 한계를 테스트 주석에 적는다.

### C8. Windows 소스 강등 (사용자 정정 반영)

Windows 소스는 현재 쓰지 않는다. 그러나 **2026-05-08 ~ 구간을 WSL보다 과거로 보유**하므로 값은 남는다.

**결정:** 어댑터 추상화를 유지한다. 단 성격이 바뀐다 - "상시 병행 수집"이 아니라 **1회성 과거 백필**이다.
완료기준 4("설정만으로 어댑터 1→2개, 이벤트 증가분 = 고유 이벤트 수")는 그대로 검증 가능하다.
`CLAUDE.md` 7항의 "구현체 2개로 검증" 조건도 충족된다.

**프로젝트 귀속 키:** 주 프로젝트 루트가 `/root/workspace` 이므로, 프로젝트명은 `cwd` 를 설정된
루트 목록에 상대화해 얻는다(`/root/workspace/<name>/...` → `<name>`). `cwd` 전문을 그대로 라벨로 쓰지
않는다 - 데모/스크린샷에 실 경로가 새는 경로다(완료기준 6).

### C9. 트랜스크립트는 append-only가 아니다 (강한 정황)

002는 "미확정"으로 남겼다. CCAM이 compaction 재기록을 전제로 `baseline_*` 을 두고 있고,
우리 트랜스크립트에도 `compactMetadata`(`preTokens` 포함) / `isCompactSummary` 가 실재한다.

**판정:** *파일이 재기록되는지* 를 직접 관측하지는 못했다(단정 금지). 그러나 append-only를 **가정하지
않는** 002의 설계(선두 해시 가드 + 불일치 시 통째 재아카이브)가 옳다. 증분 tail은 최적화이지 정확성의
근거가 아니다. 002 축4를 그대로 유지한다.

---

## 미결: 토큰 갱신 vs 완료기준 1 (사용자 결정 필요)

**문제.** 002는 refresh token 회전(rotation) 여부가 미확인이므로 **읽기 전용 ride-along**(수집기는
`.credentials.json` 을 읽기만, 절대 갱신 안 함)을 권고했다. 안전하다. 회전한다면 수집기의 갱신이
본체 Claude Code 인증을 깨뜨리기 때문이다.

**그런데 이것이 완료기준 1과 충돌한다.** accessToken 수명은 약 8시간이고, 갱신은 본체가 돌 때만
일어난다. 머신이 켜져 있어도 **밤새 Claude Code를 안 쓰면 토큰이 만료되고 그 구간의 폴은 전부
`auth_skip`** 이다. 002의 결손율 정의(`실패행/전체행`, 분모 = cron이 발화한 슬롯)로는
`auth_skip` 이 분자에 들어가므로 **결손율 <1%는 달성 불가능**하다. 밤 시간대는 헤드룸 관측에
오히려 중요한 구간이라 "그 시간은 안 본다"도 답이 아니다.

세 갈래다. 셋 다 트레이드오프가 다르고, **내가 임의로 고를 사안이 아니다.**

| 안 | 본체 인증 파손 위험 | 완료기준 1 | 비고 |
|---|---|---|---|
| **(A) ride-along + 완료기준 1 재정의** | 0 | 분모를 "토큰이 유효했던 슬롯"으로 축소하고, `auth_skip` 을 **별도 지표로 정직하게 노출** | 지표를 후퇴시킨다. 다만 거짓말은 안 한다 |
| **(B) 회전 여부 검증 후 갱신 (002 차선 b)** | 검증 실패 시 실재 | 달성 가능 | 검증 자체가 refresh 1회 소비를 요구 -> 파괴적. 안전한 검증 방법을 못 찾았다 |
| **(C) 수집기 전용 독립 자격증명** | 0 (본체 refresh 토큰을 안 건드림) | 달성 가능 | **미확인**: Claude Code가 두 번째 독립 OAuth 자격증명 발급을 허용하는지 확인 못 했다 |

**내 권고: (A)로 시작하고 (C)를 조사한다.** (A)는 지금 당장 안전하게 기록을 시작하게 해주고 -
ROADMAP이 말하듯 **수집기가 없는 하루는 영구히 잃는 하루**다. (C)가 가능하다면 나중에 무중단으로
승격할 수 있다. (B)는 검증 비용이 곧 사고 위험이라 마지막이다.

**(A)를 택하면 ROADMAP 완료기준 1과 M2를 고쳐야 한다.** M2("만료 시 자동 갱신")는 현재 회전
리스크가 정량화되지 않은 채 확정돼 있다.

---

## 확정 변경 목록

**002 (쓰기 측)**
- `model_price` 테이블 삭제 (C1). I8 문구를 "단가는 `shared` 상수에서 이벤트 시각으로 조회"로 수정.
- `usage_event` 에 `speed TEXT` 추가 (C4).
- generated column을 `five_hour` / `seven_day` / `extra_usage` 로 한정. `limits[]` 는 raw + `json_each` (C3).
- 축 4(해시 가드), 축 1(cron 단발 기동) 유지. C9가 전자를, CCAM의 OOM 사례가 후자를 지지.

**003 (읽기 측)**
- 축 4 모노레포 → **단일 패키지** (C6). "cross-package 타입 스트리핑" 리스크 소멸.
- 요구 6(dedup 키) → 002의 I4/I5로 대체 (C2).
- 축 2 단가표: TS 상수 유지(C1 승). 단 키를 `(model, speed, service_tier, effective_from)` 로 확장 (C4).
- 축 2의 단가 **값**은 여전히 미검증(오늘자 현재가). 2026-05-08 ~ 구간의 소급 발효일 조사 필요.
- 프로젝트 라벨은 `cwd` 를 루트 목록(`/root/workspace`)에 상대화 (C8).

**ROADMAP**
- 완료기준 4 / M6: "중복 `sessionId` 제거" → "중복 `message.id` 제거" (C2).
- 완료기준 1 / M2: 토큰 갱신 결정(A/B/C)이 나온 뒤 수정.

---

## 반증 조건

- **`message.id` 가 없는 usage 라인이 존재**하면 dedup 키가 무너진다. 전수 확인 필요(샘플 120~150 파일).
- **`/fast` 를 켰을 때 `speed` 값이 실제로 바뀌지 않으면** C4의 컬럼 승격은 죽은 코드다. 켜서 확인 가능.
- **Claude Code가 두 번째 자격증명을 허용하면** (C)가 열리고 (A)의 지표 후퇴가 불필요해진다.
- **단가 소급 발효일을 끝내 못 찾으면** "API 환산가치"는 구간별로 정확도가 다르다. UI에 그 사실을
  명시해야 한다(`CLAUDE.md` 6항의 연장).

## 출처

- CCAM 레포 (MIT): <https://github.com/hoangsonww/Claude-Code-Agent-Monitor>
- CCAM 스키마 (`token_usage` PK, `model_pricing.fast_*`/`intro_until`, `baseline_*` 주석): `server/db.js`
- CCAM 메모리 누수 설계문서 (상주 서버 OOM 사례): `docs/superpowers/specs/2026-05-22-fix-transcript-cache-leak-design.md`
- `speed`/`inference_geo`/`compactMetadata` 실재: 본 레포 환경 트랜스크립트 60파일 샘플 (2026-07-09 측정)

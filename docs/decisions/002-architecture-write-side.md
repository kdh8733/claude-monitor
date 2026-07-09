# 002. 쓰기 측(수집·실행·저장·동시성) 아키텍처

- 날짜: 2026-07-09 / 상태: **초안(제안)** - 승인은 사용자가 한다.
- 작성: infra-engineer
- 대상: claude-monitor 수집기(collector). 스택은 `001-stack.md`(승인) 전제.
- 계약 경계: **SQLite 파일 하나가 유일한 인터페이스.** 이 문서는 "SQLite에 무엇이 어떤
  모양으로 들어가는가"까지 책임진다. 읽는 쪽(집계·렌더)은 별도 에이전트가 설계한다.

---

> **[조정 2026-07-09]** `004-reconciliation.md` 가 이 문서의 일부를 덮는다. 충돌 항목은 004가 우선한다.
> - `model_price` 테이블 삭제 (단가는 `shared` TS 상수). I8의 조회 대상이 바뀐다.
> - `usage_event` 에 `speed` 컬럼 추가 (단가 차원).
> - generated column은 `five_hour`/`seven_day`/`extra_usage` 한정. `limits[]` 는 raw + `json_each`.
> - 축 6(토큰 갱신)은 완료기준 1과 충돌한다. 004의 미결 절 참조.

## 배경 / 확정 전제

- 런타임 Node 24 / TypeScript 단일 언어, 저장 `node:sqlite`(WAL, 단일 파일). 재논의 안 함.
- 한도의 권위 있는 출처는 `/api/oauth/usage` 하나. 트랜스크립트 롤링합 역산은 실측 반증됨
  (`ROADMAP.md` 반증된 가설). 되살리지 않는다.
- 두 데이터 소스: (A) `/api/oauth/usage` 게이지 스냅샷, (B) 트랜스크립트 JSONL 귀속.
  A는 "잔량", B는 "어디에 썼나". 보완재.

### 이 문서를 위해 실측한 사실 (2026-07-09, 이 환경)

토큰 값·프롬프트 원문·실 프로젝트명은 출력하지 않았다. 통계·스키마만.

| 관측 | 값 | 방법 |
|---|---|---|
| systemd | **부재** | PID1=`init(rocky9.3)`, `/run/systemd/system` 없음, `systemctl` "not booted with systemd" |
| crond | **상시 구동 중** (PID 3721, Jul05~) | `ps aux`. 부팅 훅 `aoe-web-boot.sh:65` 가 `pgrep -x crond || /usr/sbin/crond` 로 보장 |
| WSL 부팅 훅 | `/etc/wsl.conf [boot] command = /bin/bash /root/aoe-web-boot.sh` | `cat /etc/wsl.conf` |
| 기존 cron 패턴 | `claude-config/runtime/cron/*.sh` 3종 등록됨, 캐치업 로직 존재 | `crontab -l`, `aoe-web-boot.sh:68-75` |
| 트랜스크립트 규모 | 2,069 파일 / 319MB (ROADMAP 시점 316MB에서 증가) | `find`, `du` |
| 활성 쓰기 | 최근 10분 내 5개 파일 수정 (현재 세션이 append 중) | `find -mmin -10` |
| **usage 라인 grain** | usage 라인 21,924건인데 **distinct `message.id` 9,223** (라인:메시지 ≈ 2.4:1) | 120~150 파일 샘플 파싱 |
| **누적 기록** | 같은 `message.id` 반복 그룹에서 `last(output_tokens)==max` 가 **6,916/6,916 = 100%** | 샘플 파싱 |
| usage 라인 role | **전부 `assistant`** (21,924/21,924) | 샘플 파싱 |
| `uuid` 유일성 | 21,921행 중 distinct 21,897, 중복 24건(파일 간, resume 복제로 추정) | 샘플 파싱 |
| `requestId` 유일성 | usage 라인 위 distinct requestId << 라인 수, 파일 내 최대 12회 반복 | 샘플 파싱 |
| **소스 간 sessionId 충돌** | WSL 1,862 × Windows 14, **교집합 0** | 두 트리 내부 `sessionId` 필드 대조 |
| 자격증명 필드 | `claudeAiOauth.{accessToken(len108), refreshToken(len108), expiresAt, refreshTokenExpiresAt}` | `~/.claude/.credentials.json` 키·길이만 |
| access 토큰 수명 | 실측 시점 만료까지 181분(총수명 약 8h로 ROADMAP 일치), refresh 만료는 별도(약 24일 뒤) | 만료시각만 계산 |
| node:sqlite | SQLite **3.53.0** 내장. VIRTUAL/STORED generated column, gencol 인덱스, 누락 JSON 경로→NULL 실측 | `node -e`, `gc.mjs` |

이 실측 두 개가 설계를 지배한다:

1. **트랜스크립트 usage는 라인 단위로 합치면 안 된다.** 한 `message.id` 가 평균 2.4개
   라인으로 스트리밍 기록되고, usage는 누적된다(last==max 100%). 라인을 SUM하면 토큰이
   약 2.4배 부풀려진다. **완료 기준 3(오차 0 귀속)의 최대 함정.** 귀속의 grain은
   `message.id`, 값은 그 그룹의 종단(terminal) usage다.

2. **중복 제거 키는 `sessionId` 가 아니라 `message.id` 다.** `message.id` 는 Anthropic이
   메시지에 부여하는 전역 식별자라 소스에 독립이다. `sessionId` 단위 제거는 grain이 틀렸고,
   같은 세션이 두 머신에 부분적으로 존재하면 데이터 손실이다(현재 관측 교집합은 0이라
   오늘은 우연히 안전하지만, resume 시나리오에 취약). `message.id` 제거는 동일 메시지만
   합치고 서로 다른 메시지는 보존한다.

---

## 프로세스 경계 다이어그램 (텍스트)

```
WSL (사용자 PC가 켜져 있을 때만 존재)
┌─────────────────────────────────────────────────────────────────────────┐
│  crond (PID 3721, 부팅 훅이 보장)                                          │
│    │  */5 * * * *                        0 3 * * *  (또는 부팅 캐치업)      │
│    ▼                                       ▼                              │
│  [snapshot-poll]  1회 실행 후 종료        [transcript-ingest] 1회 후 종료   │
│    │ read-only                              │ list→archive(raw)→parse      │
│    │ ~/.claude/.credentials.json            │                              │
│    │ (accessToken 읽기만, 갱신 안 함)        │  SourceAdapter[wsl]           │
│    ▼                                        │  SourceAdapter[windows]       │
│  GET api.anthropic.com/api/oauth/usage      │  (/mnt/c/.../projects)        │
│    │ 200 → raw JSON 전문                     ▼                              │
│    ▼                                     archive/ (raw JSONL 미러, 압축)    │
│  ┌──────────────────────────── usage.sqlite (WAL, 단일 파일) ───────────┐ │
│  │  snapshot         usage_event        transcript_file   collector_run  │ │
│  │  (raw+VIRTUAL)    (message.id grain)  (오프셋·해시)      (관측·gap)     │ │
│  │  model_price(seed, effective_from)                                    │ │
│  └───────────────────────────────────────────────────────────────────────┘│
│         ▲ 쓰기(1 writer, cron 직렬)              ▲ 읽기(N reader)            │
└─────────┼───────────────────────────────────────┼──────────────────────────┘
          │                                        │
   수집기 프로세스만 write                    Next.js RSC 읽기 전용 (별도 문서)
```

- **쓰기 프로세스는 사실상 직렬 1개.** cron이 snapshot-poll과 transcript-ingest를 각각
  단발로 띄운다. 겹칠 수 있으므로 SQLite는 WAL + `busy_timeout` 로 짧은 경합을 흡수하고,
  수집기 레벨에서 프로세스 락(단일 락 파일)으로 같은 작업의 중복 기동을 막는다.
- **상주 데몬 없음.** cron 자체가 슈퍼바이저다. 한 실행이 죽어도 다음 슬롯이 독립 기동한다.

---

## 축 1. 실행 형상

판정 기준: **결손율 < 1%(완료 기준 1)를 달성 가능한가.** 단, 이 지표는 "슬롯 정의"에
지배된다(아래 축 2에서 재정의).

| 항목 | cron/crond (권고) | systemd user timer | 상주 데몬(long-running) | Claude Code hook |
|---|---|---|---|---|
| 이 환경 가용성 | **가능 (crond 상시 구동 실측)** | **불가 (systemd 부재 실측)** | 가능 | 가능 |
| 슈퍼비전 | crond가 재기동 보장(부팅 훅) | systemd | **없음** (직접 respawn 필요: tmux+부팅 훅) | Claude Code |
| 조용한 죽음 저항 | 높음 (매 슬롯 독립 기동) | 높음 | 낮음 (죽으면 끝, watchdog 별도) | 중 |
| 유휴/야간 폴링 | 됨 (Claude Code 무관) | 됨 | 됨 | **안 됨 (Claude Code 실행 시에만)** |
| 기존 패턴 재사용 | **있음 (`runtime/cron/*` 3종)** | 없음 | 부분(aoe serve) | 없음 |
| PC 꺼짐 결손 | 발생(불가피) | 발생 | 발생 | 발생 |
| 최소 해상도 | 1분 | 1분 | 임의 | 이벤트 구동 |
| 복잡도(1인) | **최저** | (불가) | 중(respawn 배선) | 중 |

**결손율의 냉정한 진실.** `/api/oauth/usage` 는 현재 스냅샷만 주고 **백필이 없다.**
PC가 꺼진 시간은 영구 손실이며 어떤 실행 형상도 이를 못 메운다. 노트북이 하루 8시간
꺼지면 벽시계 기준 결손율은 33%로 완료 기준 1을 자명하게 위반한다. 따라서 결손율은
**"수집기가 돌았어야 하는 슬롯"(=cron이 실제 발화한, 즉 머신이 켜져 있던 슬롯)** 대비로
정의해야 의미가 있다. 이 정의를 축 2/축 7의 `collector_run` 테이블이 강제한다. 이 재정의가
없으면 완료 기준 1은 "24/7 서버에 올려라"라는 배포 요구로 변한다(그 경우 원격 상주가
정답이지만 ROADMAP은 원격을 보류했다).

- **권고: cron/crond + 부팅 캐치업.** 근거: systemd는 실측 부재라 timer는 애초에 불가.
  crond는 이미 돌고 부팅 훅이 보장하며 캐치업 관용구(`aoe-web-boot.sh:68`)까지 있다.
  매 슬롯 독립 기동이라 "조용한 죽음"에 구조적으로 강하다. claude-weekly와 동일 계열이라
  1인 운영 인지 비용이 0에 수렴한다.
- **차선: 상주 데몬(setInterval).** cron 분해상도(1분)보다 촘촘한 적응형 폴링이 필요해지면.
  대가는 respawn 배선(tmux 세션 + 부팅 훅 + watchdog)이고, 현 요건(5분)엔 과하다.
- **기각: systemd user timer** - 이 환경에 systemd가 없다(실측). 이식성 논거도 WSL 전제라
  무의미. **기각: Claude Code hook 단독** - 게이지는 Claude Code 활동과 무관하게(웹/데스크톱
  사용까지) 소모되는데(반증된 가설의 핵심), hook은 Claude Code가 돌 때만 발화해 유휴/야간을
  통째로 놓친다. 다만 "Claude Code가 도는 동안 기회적 추가 스냅샷 1건"을 얹는 **보조**로는
  가치가 있다(백본은 cron).

---

## 축 2. 폴링 간격

판정 기준: **완료 기준 2(resets_at 경계 톱니 재현)에 필요한 최소 해상도**와, 그 간격이
만드는 연간 비용.

### 해상도 계산 (감 아님)

- `five_hour` 창 = 5h = 300분, 하루 4~5회 리셋. `weekly`(=`seven_day`) 창 = 7일 = 10,080분.
- 톱니의 "하강"을 관측하려면 리셋 순간을 사이에 두고 앞뒤 표본 1개씩이면 충분하다.
  균일 5분 폴링은 **모든 리셋 순간을 ≤5분으로 브래킷**한다. weekly 창엔 표본 2,016개,
  five_hour 창엔 60개가 들어가 곡선까지 촘촘히 재현한다.
- **결정적 근거: `resets_at` 이 응답 본문에 이미 들어 있다.** 리셋 시각을 촘촘한 표집으로
  "발견"할 필요가 없다. 이미 아는 경계를 5분 균일이 브래킷하면 완료 기준 2는 충족된다.
  이것이 적응형(리셋 근처만 조밀)의 전제를 무너뜨린다.

### 연간 비용 (raw JSON ≈ 1.5KB/스냅샷, 행 ≈ 1.7KB 가정)

| 간격 | 행/년 | SQLite 크기/년(대략) | API 호출/일 | 톱니 재현 | 판정 |
|---|---|---|---|---|---|
| **5분(권고)** | 105,120 | **약 0.2 GB** | 288 | 충분(≤5분 브래킷) | 균형 |
| 1분 | 525,600 | 약 1.0~1.2 GB | 1,440 | 과잉 | 5배 비용, 분석 이득 0 |
| 15분 | 35,040 | 약 0.06 GB | 96 | 가능(≤15분 브래킷) | 결손 여유 얇아짐 |
| 적응형(리셋±조밀) | 5분과 유사 | 유사 | 유사 | 충분 | 복잡도만 추가 |

- **권고: 고정 5분.** ROADMAP M1 검증(30분 구동→6행 ±1)과 정합. `resets_at` 가 경계를
  알려주므로 균일 5분이 톱니를 브래킷하기에 충분하고, 행 수·API·크기가 온건하다.
- **차선: 고정 15분.** 저장/호출을 더 줄여야 하면. 대가는 결손 허용폭이 얇아져(슬롯이 적어
  1건 결손의 가중치가 커짐) 완료 기준 1 여유가 준다.
- **기각: 1분** - 저장·API 5배인데 `resets_at` 를 이미 아는 이상 리셋 순간 정밀도(5분→1분)
  외 얻는 게 없다. **기각: 적응형** - 전제(리셋을 표집으로 찾는다)가 payload의 `resets_at`
  로 무효. 스케줄러 자기조정 복잡도만 늘고 분석 이득이 없다. (단 훗날 5분 미만 리셋 동역학이
  실제로 흥미로워지면 이때 도입 - 되돌리기 값에 escalation으로 기록.)

---

## 축 3. 스냅샷 저장 스키마 (raw 보존 + 조회 컬럼 파생)

판정 기준: **스키마 드리프트 내성**(모르는 필드 보존, 파싱 실패가 적재 실패가 되지 않음,
`CLAUDE.md` 3항).

### 공식 문서·실측 확인 (추측 아님)

SQLite generated column (<https://www.sqlite.org/gencol.html>), node:sqlite 3.53.0 실측:

- "The value of a **VIRTUAL** column is computed when read" / "**STORED** ... computed when
  the row is written. STORED columns take up space." (VIRTUAL=저장 0, 읽을 때 계산)
- "Generated columns can participate in indexes" (VIRTUAL은 expression index) - 실측 OK.
- **"It is not possible to ALTER TABLE ADD COLUMN a STORED column. One can add a VIRTUAL
  column, however."** - 실측 일치(`cannot add a STORED column` / VIRTUAL ADD OK).
- "Generated columns may not be used as part of the PRIMARY KEY."
- 누락 JSON 경로 → `json_extract` 가 **NULL 반환(에러 아님)** - 실측 확인(`{}` 행 → NULL).
  이것이 "파싱 실패가 적재 실패가 되지 않는다"를 DDL 레벨에서 보장한다.

| 방식 | 드리프트 내성 | 저장 | 새 파생 추가 | 일관성(raw와) | 판정 |
|---|---|---|---|---|---|
| (a) 매 쿼리 `json_extract` | 최상 | 0 | 즉시(뷰/쿼리) | 항상 | 조회 편의·인덱스 약함 |
| **(b) VIRTUAL generated (권고)** | **최상** | **0** | **ALTER ADD 가능(실측)** | **항상(raw서 계산)** | 균형 |
| (b') STORED generated | 최상 | 있음 | **ALTER ADD 불가(실측)** | 항상 | 미래 필드 추가 막힘 |
| (c) 적재 시 파생 write | 중 | 있음 | 로더 수정+백필 | **드리프트 가능** | 로더 버그가 값 오염 |
| (d) 파생 뷰 | 최상 | 0 | 즉시 | 항상 | 인덱스 불가, (b)의 하위호환 |

- **권고: raw_json NOT NULL + VIRTUAL generated column.** raw가 유일한 진실, 파생은 raw에서
  계산이라 드리프트가 구조적으로 불가능. 저장 0, 자주 거는 필드(`resets_at` 등)엔 expression
  index. 새 코드네임 필드가 채워지기 시작하면 `ALTER TABLE ADD COLUMN ... VIRTUAL` 로 무중단
  추가(STORED는 이게 막혀 탈락). 누락 경로는 NULL이라 적재가 안 깨진다.
- **차선: (a) 매 쿼리 json_extract + (d) 뷰.** generated column이 어떤 이유로 부담되면.
  기능 동일, 인덱스 편의만 손해.
- **기각: (c) 적재 시 write** - 로더 로직과 raw가 갈라질 수 있어(드리프트) 미문서 엔드포인트
  전제에 정면으로 반한다. **기각: STORED generated** - 미래 필드 ALTER ADD가 불가(실측)라
  스키마 드리프트 대응이라는 목적 자체를 훼손.

---

## 축 4. 트랜스크립트 수집 전략

판정 기준: **M3 원칙(보존이 파싱보다 먼저)** 존중 + append-only 여부 + 디스크 비용.

### append-only 여부 (실측 + 정직한 한계)

활성 파일이 세션 중 라인을 append하는 것은 관측했다(최근 10분 5개 파일 수정, 파일 수·용량
증가 2,069/319MB). **과거 라인이 재기록되는지는 스냅샷 관측으로 반증할 수 없다.** 파일 내
timestamp가 단조 증가하지 않는 건(서브에이전트/사이드체인 인터리브 때문) append-only의
반증이 아니다. 따라서 append-only는 **강하게 지지되나 미확정**으로 두고, 전략은 재기록/절단
가능성에도 안전하게 설계한다.

디스크: 2026-06-03~07-09(약 36일) 316MB ≈ 약 9MB/일 ≈ **약 3.2GB/년**. 미러 아카이브는
이를 이중화하나 JSONL은 압축률이 높아(대략 10:1) zstd 미러는 **약 0.3GB/년** 수준.

| 방식 | 보존(M3) | 재기록 안전 | I/O 비용 | 디스크 | 판정 |
|---|---|---|---|---|---|
| (a) 통째 복사 아카이브 | 충족 | 안전 | **매번 319MB 복사(변경분만이면 완화)** | 미러(압축 0.3GB/년) | 순진하면 I/O 폭증 |
| (b) 증분 tail + 오프셋 | 파서엔 충족, 원본보존은 별도 | **절단/재기록에 취약** | 최소 | 최소 | 흔한 append엔 최적, 예외에 약함 |
| (c) 해시 변경감지 후 재파싱 | 충족 | 안전 | 변경 시 전체 재읽기 | 미러 | 안전하나 append도 전량 재읽기 |
| **(b+c) 증분 tail + 해시 가드(권고)** | **충족** | **안전** | **흔한 경우 최소, 예외만 전량** | 미러(압축) | 균형 |
| (d) 아카이브 없이 즉시 파싱 | **위반(M3)** | - | 최소 | 0 | M3 원칙 위반으로 탈락 |

**권고: 아카이브(미러, 압축) 선행 + 증분 tail(오프셋) 이 흔한 경우, 해시 가드가 예외 처리.**
파일별로 `(last_size, last_mtime_ms, sha256, last_parsed_offset)` 를 `transcript_file` 에
기록한다. 매 실행:
1. 크기가 늘고 선두 해시가 그대로면(=append) → 늘어난 바이트만 아카이브에 이어붙이고
   `last_parsed_offset` 부터 파싱.
2. 크기가 줄거나 선두 해시가 바뀌면(=재기록/절단) → 그 파일을 **새 버전으로 통째 재아카이브**
   (기존 아카이브본은 덮지 않고 보존, M3), 전량 재파싱.
파서는 아카이브에서 assistant usage 라인만 뽑아 `message.id` 로 dedup(종단 usage) 후
`usage_event` 에 upsert한다. 재실행해도 같은 행이 나온다(멱등).

- **차선: (c) 해시 변경감지 후 재파싱 단독.** append 최적화를 포기하고 단순함을 택하면.
  현 규모(9MB/일)에선 전량 재읽기도 견딜만하다. 코드가 가장 단순한 쪽이 이거라, tail
  최적화가 과하다고 판단되면 여기서 시작해도 된다.
- **기각: (b) 증분 tail 단독** - append-only가 미확정인데 절단/재기록 시 오프셋이 깨져 조용히
  데이터를 놓친다. **기각: (d) 즉시 파싱** - M3(보존 우선) 정면 위반.

---

## 축 5. 소스 어댑터 인터페이스

판정 기준: WSL/Windows 두 구현으로 검증되는 최소 인터페이스 + **중복 제거를 어느 계층에서
하는가.**

### 중복 제거 계층 = 적재(load), 키 = `message.id`

두 소스는 포맷이 동일하고 **(루트 경로, 파일시스템 접근)만 다르다.** 따라서 어댑터는
가장 얇아야 한다: "파일 열거 + raw 바이트 열기 + 소스 정체성 제공". 파싱은 어댑터 밖에서
한 번만 구현(DRY)하고, 아카이브도 raw를 그대로 저장한다.

| 후보 반환형 | 파싱 위치 | dedup 계층 | 판정 |
|---|---|---|---|
| 파일 경로 이터레이터 | 소스 밖(1곳) | 적재 | 너무 얇음(바이트 접근 캡슐화 안 됨) |
| **raw 라인 스트림(권고)** | **소스 밖(1곳)** | **적재(upsert on message.id)** | 파싱 단일화 + 아카이브 raw 보존 |
| 파싱된 이벤트 스트림 | **어댑터 안(2곳 중복)** | 적재/쿼리 | 파싱 로직이 소스마다 중복, DRY 위반 |

중복 키 후보 실검증: `sessionId`(소스 간 교집합 0이나 grain이 굵어 resume에 취약),
`requestId`(파일 내 최대 12회 반복, 유일 아님 → 탈락), `(sessionId,timestamp)`(취약),
라인 해시(같은 메시지의 스트리밍 라인들이 서로 달라 dedup 실패). **승자는 `message.id`**:
전역 유일, 소스 독립, 같은 메시지만 합치고 다른 메시지는 보존. 완료 기준 4("어댑터 2개일 때
증가분 = Windows 고유 이벤트 수")를 `message.id` grain에서 정확히 만족하며, sessionId 제거의
데이터 손실 함정을 피한다.

```ts
interface SourceAdapter {
  readonly id: string;                    // 'wsl' | 'windows' - 모든 행에 provenance로 각인
  listFiles(): AsyncIterable<{ relPath: string; sizeBytes: number; mtimeMs: number }>;
  openRaw(relPath: string): Readable;     // 파싱 안 함, 바이트만
}
// dedup은 어댑터가 아니라 적재기에서: INSERT ... ON CONFLICT(message_id) DO UPDATE
//   SET (종단 usage로 갱신). source_id/session_id는 provenance로 저장하되 정체성엔 불참여.
```

- **권고: raw 라인 스트림 어댑터 + 적재 계층 `message.id` upsert dedup.**
- **차선: 파일 경로 이터레이터.** 바이트 열기를 호출측이 직접 하면. 캡슐화가 약하지만 더 얇다.
- **기각: 파싱된 이벤트 스트림 반환** - 파싱이 어댑터마다 중복되어 DRY 위반, 어댑터가
  뚱뚱해져 "설정만으로 소스 추가"(완료 기준 4)가 어려워진다.
- **ROADMAP 수정 제안:** 완료 기준 4의 "중복 `sessionId` 제거"를 **"중복 `message.id`
  제거"**로 바꿀 것. sessionId 단위 제거는 grain이 틀렸고 cross-machine resume에서
  데이터 손실 위험이 있다(오늘 교집합 0은 우연). 의도(이중 계상 방지)는 message.id가 더
  정확히 만족한다.

---

## 축 6. 토큰 갱신 동시성 (최우선 리스크)

**최우선 리스크: refreshToken을 소비하면 본체 Claude Code 세션이 깨지는가.**
핵심은 refresh token rotation 여부다.

### 확인된 것 / 확인 못 한 것 (정직)

- 확인: 자격증명에 `accessToken`(수명 약 8h)과 **`refreshTokenExpiresAt`(약 24일 뒤, 별도)**
  가 공존한다. refresh 토큰에 독립 만료가 있다는 건 refresh가 장수명이고 **회전(rotation)할
  개연성**을 시사하나 단정 못 한다.
- **확인 못 함(1): refresh token이 사용 시 회전하는가.** 회전한다면, 수집기가 갱신하는 순간
  새 refresh가 발급되고 본체가 들고 있던 옛 refresh가 무효화되어 **다음 갱신 때 본체 세션이
  깨진다.** 검증하려면 실제 refresh를 소비해야 하는데, 이는 지시상 금지이고 파괴적이다.
  공식 문서 확인도 못 했다(미문서 OAuth 플로우). → **확인 못 했다고 명시하고, 가장 안전한
  안을 권고한다.**
- **확인 못 함(2): Claude Code가 매 API 호출 전 자격증명을 디스크에서 다시 읽는가, 아니면
  프로세스 수명 동안 메모리 캐시하는가.** 후자라면 수집기가 파일을 올바로 다시 써도 실행 중인
  본체는 옛 토큰을 계속 써서 깨질 수 있다.

| 방식 | 본체 세션 리스크 | 결손(유휴 시) | rotation 전제 | 판정 |
|---|---|---|---|---|
| **(a) 읽기 전용 ride-along(권고)** | **없음** | 본체가 안 도는 진짜 유휴에 발생 | 무관 | 안전 최우선 |
| (b) flock 후 갱신·재기록 | **회전 시 있음**(락은 회전을 못 막음) | 없음 | 회전 안 함 가정 필요 | 미검증 전제 |
| (c) 별도 토큰 저장소 | 첫 갱신이 곧 회전 트리거면 있음 | 없음 | 회전 안 함 가정 필요 | 미검증 전제 |
| (d) 401 후 재시도 | (b/c와 동일 회전 리스크) | 없음 | 회전 안 함 가정 필요 | 반응형, 동일 리스크 |

**권고: (a) 읽기 전용 ride-along.** 수집기는 본체 Claude Code가 유지하는 `accessToken` 을
**읽기만** 하고 절대 갱신·재기록하지 않는다. 사용자가 이 머신에서 Claude Code를 상시 쓰므로
토큰은 본체가 알아서 신선하게 유지한다. 토큰이 만료됐고 본체도 안 돌아 갱신 안 된 진짜 유휴
구간에서는 **그 폴을 건너뛰고 `collector_run` 에 `auth_skip` 으로 기록**한다(gap 히스토그램에
반영). refresh 토큰을 한 번도 건드리지 않으므로 본체 세션을 깰 위험이 **0**이다. 이것이
"확인 못 하면 가장 안전한 안"의 답이다.

- **차선(승격 경로, 검증 게이트): (b) flock 가드 갱신.** 다음 둘을 **먼저 검증한 뒤에만**:
  (i) refresh 토큰이 회전하지 않는다(재사용 가능)거나 회전해도 본체가 디스크 재읽기로 회복,
  (ii) 갱신·원자적 재기록 후 본체가 새 토큰을 집어간다. 검증 전엔 갱신하지 않는다.
- **기각(현 시점): (b)(c)(d) 무조건 채택** - 전부 refresh 소비를 전제하는데 회전 여부가
  미검증이라 본체 세션 파손(사용자의 Claude Code 인증 붕괴)이라는 중대 downside를 안는다.

**M2에 대한 비판적 검토.** ROADMAP M2는 "만료 시 refreshToken으로 자동 갱신"을 이미 확정하고
검증 절차가 강제 갱신을 돌린다. 이 계획은 **회전 리스크가 정량화되지 않은 채 본체 인증을 깰 수
있다.** 권고: M2의 자동 갱신 구현 **전에** 회전 동작을 사용자 인지 하에 통제된 방식으로
확인하거나(옵션 (b) 게이트), 그때까지 (a)로 운영. 어떤 경우에도 토큰 값은 로그·에러·픽스처·
커밋 어디에도 남기지 않는다 - **길이와 만료시각만**(`CLAUDE.md` 2항).

---

## 축 7. 실패 · 관측

판정 기준: 결손 검출(완료 기준 1 gap 히스토그램) + 조용한 죽음 방지 + 알림 채널 정책.

| 관심사 | 설계 | 근거 |
|---|---|---|
| 결손 검출 | 매 실행이 `collector_run` 1행 기록(성공/`auth_skip`/`http_error`/`error`). gap% = 실패행/전체행 | 슬롯 분모가 "cron이 발화한(=머신 켜짐) 슬롯"이라 PC-off가 지표를 왜곡 안 함 |
| 톱니 검증 | `snapshot` 의 파생 컬럼 시계열 쿼리 | 별도 시스템 불필요 |
| 조용한 죽음 | cron이 매 슬롯 독립 기동(백본이 자가치유) + 성공 시 heartbeat 파일 mtime 갱신 | claude-weekly `last-run` 패턴 재사용 |
| 죽음 알림 | heartbeat가 임계(예: 머신 켜짐에도 N시간 무갱신) 초과면 텔레그램 1줄 | 기존 config-audit cron에 피기백 |

**"수집기 죽음 알림"은 알림인가 관측인가 - 의견.** ROADMAP "후순위"가 보류한 것은
**"한도 임박 시 텔레그램"(개입성 알림)** 이다. 수집기 죽음 감지는 **데이터 파이프라인의
운영 무결성(관측)** 이지, 사용자의 사용 습관에 개입하는 알림이 아니다. 완료 기준 1(결손율
<1%)을 30일간 만족하려면 "수집기가 조용히 죽었는데 몇 주간 몰랐다"를 막을 수단이 반드시
필요하다. 이건 Goal("관측")과 정합하며 보류 대상이 아니다. 다만 **최소로**: 새 봇/채널을
만들지 말고, 기존 `runtime/cron/config-audit.sh`(주간 드리프트 감사, 텔레그램 클로드업데이트
채널)에 "heartbeat가 M시간 이상 stale이면 1줄" 검사를 얹는다. 이는 새 기능이 아니라 기존
관측 자산의 확장이다. "한도 임박 알림"은 여전히 보류(Goal이 개입이 아님).

- **권고: `collector_run` 기반 gap 히스토그램(지표) + heartbeat stale 검사를 config-audit에
  피기백(죽음 관측).** 새 알림 채널 없음.
- **차선: 죽음 관측도 생략, gap 히스토그램만.** 사용자가 대시보드를 자주 본다면 죽음을 눈으로
  발견. 30일 무인 운영엔 약함.
- **기각: 한도 임박 알림 구현** - ROADMAP 보류(Goal은 관측이지 개입이 아님). 요청 없음.

---

## 계약 (스키마 DDL + 불변식)

**이 절이 읽기 측 에이전트와의 계약이다.** DDL은 제안. 불변식은 읽는 쪽이 의존해도 되는 보증.

### DDL (제안)

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

-- 소스 A: 게이지 스냅샷. raw 보존 + VIRTUAL 파생.
CREATE TABLE snapshot (
  id            INTEGER PRIMARY KEY,
  captured_at   INTEGER NOT NULL,          -- 수집기 벽시계, UTC epoch ms. 시간축(gap 분석용).
  raw_json      TEXT    NOT NULL,          -- 응답 본문 전문 verbatim. 절대 NULL 아님(불변식 I1).
  http_status   INTEGER NOT NULL,          -- 200만 이 테이블에 적재.
  -- 파생: VIRTUAL(저장0, raw서 계산, 누락경로→NULL, ALTER ADD 가능)
  five_hour_pct   REAL GENERATED ALWAYS AS (json_extract(raw_json,'$.five_hour.utilization'))    VIRTUAL,
  five_hour_reset TEXT GENERATED ALWAYS AS (json_extract(raw_json,'$.five_hour.resets_at'))      VIRTUAL,
  weekly_all_pct  REAL GENERATED ALWAYS AS (json_extract(raw_json,'$.seven_day.utilization'))    VIRTUAL,
  weekly_reset    TEXT GENERATED ALWAYS AS (json_extract(raw_json,'$.seven_day.resets_at'))      VIRTUAL,
  extra_enabled   INTEGER GENERATED ALWAYS AS (json_extract(raw_json,'$.extra_usage.is_enabled')) VIRTUAL
);
CREATE INDEX ix_snapshot_captured ON snapshot(captured_at);
CREATE INDEX ix_snapshot_wreset    ON snapshot(weekly_reset);   -- 톱니 쿼리용 expression index

-- 소스 B: 귀속. grain = assistant message.id(라인 아님). 종단 usage.
CREATE TABLE usage_event (
  message_id    TEXT PRIMARY KEY,          -- Anthropic 전역 유일. dedup·정체성 키(I4,I5).
  captured_at   INTEGER NOT NULL,          -- 이 message의 timestamp(UTC ms). 단가·윈도우 조회축.
  source_id     TEXT NOT NULL,             -- 'wsl'|'windows'. provenance(정체성 불참여, I6).
  session_id    TEXT,                      -- 귀속 그룹핑용(dedup 키 아님).
  cwd           TEXT,
  git_branch    TEXT,
  model         TEXT,
  service_tier  TEXT,
  is_sidechain  INTEGER,                   -- 서브에이전트 판별.
  request_id    TEXT,
  input_tokens              INTEGER NOT NULL DEFAULT 0,   -- message.usage verbatim.
  output_tokens             INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  raw_usage_json TEXT NOT NULL             -- message.usage 원본(cache_creation.ephemeral_* 등 보존).
);
CREATE INDEX ix_ue_captured ON usage_event(captured_at);
CREATE INDEX ix_ue_session  ON usage_event(session_id);
CREATE INDEX ix_ue_model    ON usage_event(model);

-- 아카이브·증분 파싱 부기.
CREATE TABLE transcript_file (
  source_id     TEXT NOT NULL,
  rel_path      TEXT NOT NULL,
  archive_path  TEXT NOT NULL,             -- 미러(압축) 경로.
  last_size     INTEGER NOT NULL,
  last_mtime_ms INTEGER NOT NULL,
  head_sha256   TEXT NOT NULL,             -- 선두 N바이트 해시(재기록 감지).
  last_offset   INTEGER NOT NULL,          -- 증분 파싱 오프셋.
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (source_id, rel_path)
);

-- 관측·gap의 단일 원천. 실행마다 1행(성공/실패 무관).
CREATE TABLE collector_run (
  id           INTEGER PRIMARY KEY,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  kind         TEXT NOT NULL,              -- 'snapshot'|'transcript'.
  status       TEXT NOT NULL,              -- 'ok'|'auth_skip'|'http_error'|'error'.
  http_status  INTEGER,
  note         TEXT,                       -- 토큰 값 금지. 길이/만료시각만.
  snapshot_id  INTEGER REFERENCES snapshot(id)
);
CREATE INDEX ix_run_started ON collector_run(started_at);

-- 시드(수집기 산출 아님): 시점 버전 단가표(CLAUDE.md 5항).
CREATE TABLE model_price (
  model          TEXT NOT NULL,
  effective_from INTEGER NOT NULL,         -- UTC ms. 이 시각부터 유효.
  input_per_mtok        REAL NOT NULL,
  output_per_mtok       REAL NOT NULL,
  cache_read_per_mtok   REAL NOT NULL,
  cache_write_per_mtok  REAL NOT NULL,
  PRIMARY KEY (model, effective_from)
);
```

### 불변식 (읽는 쪽이 의존해도 되는 계약)

- **I1. `snapshot.raw_json` 은 절대 NULL이 아니다.** 응답 본문 전문을 verbatim 보존한다.
  파생 컬럼은 VIRTUAL이며 필드 부재 시 NULL일 수 있으나 raw_json은 언제나 존재. 모르는
  코드네임 필드도 raw에 그대로 남는다(`CLAUDE.md` 3항).
- **I2. `snapshot.captured_at` 은 수집기 벽시계(UTC ms)이고, gap 분석의 시간축이다.**
  payload의 `resets_at`/파생 리셋 컬럼과 **다르다**(혼동 금지).
- **I3. `snapshot` 1행 = 성공한(HTTP 200) 폴 1회.** 실패·`auth_skip` 폴은 snapshot을 만들지
  않고 `collector_run` 에만 남는다. **gap의 권위 있는 출처는 `collector_run` 이다**(추정 금지).
  결손율 = 실패행/전체행, 분모는 "머신이 켜져 cron이 발화한 슬롯"이다.
- **I4. `usage_event` 의 grain은 assistant `message.id` 이지 트랜스크립트 라인이 아니다.**
  한 message.id는 평균 2.4개 라인으로 스트리밍 기록되고 usage는 누적된다(종단=max, 실측
  100%). **읽는 쪽은 트랜스크립트 라인을 SUM하면 안 된다 - 약 2.4배 과대계상된다.** 적재기가
  message.id로 dedup해 종단 usage만 저장하므로, 읽는 쪽은 `usage_event` 를 그대로 합산하면 된다.
- **I5. `usage_event.message_id` 가 소스 간 중복 제거 키다.** 소스를 하나 더 붙이면 행 수는
  그 소스의 고유 message.id 수만큼만 증가한다(완료 기준 4). `session_id` 는 dedup 키가
  **아니다**(grain이 굵고 cross-machine resume 시 손실 위험).
- **I6. provenance(`source_id`, `session_id`, `cwd`, `git_branch`, `request_id`, `is_sidechain`)
  는 저장되지만 정체성엔 불참여한다.** `session_id` 는 귀속 그룹핑용으로만 신뢰하라.
- **I7. 4종 토큰 카운트는 `message.usage` verbatim이다.** billable 정의(input+output+
  cache_creation 등)와 cache_read 취급은 읽는 쪽이 단가표 조인으로 계산한다. 원본은
  `raw_usage_json` 에도 보존(ephemeral_5m/1h 등 세부 필드).
- **I8. 비용(API 환산가치)은 `usage_event` 에 저장하지 않는다.** `model_price.effective_from`
  을 이벤트 `captured_at` 으로 조회해 **당시 단가**로 계산한다(현재가 소급 금지, `CLAUDE.md`
  5항). 이벤트에 costUSD를 굳혀 넣으면 단가 개정 시 소급 왜곡이 발생하므로 금지.
- **I9. 수집기는 `~/.claude/.credentials.json` 을 절대 쓰지 않는다.** 읽기 전용 ride-along.
  토큰 값은 어디에도 기록하지 않는다 - 길이·만료시각만(`CLAUDE.md` 2항).
- **I10. 아카이브가 파싱보다 먼저다(M3).** 파서는 멱등이다 - 변경 없는 아카이브를 재파싱하면
  동일 `usage_event` 행이 나온다(message.id upsert). 재기록/절단된 원본은 옛 아카이브본을
  덮지 않고 새 버전으로 보존.

---

## 반증 조건 (이 설계가 틀릴 수 있는 경우)

- **트랜스크립트가 append-only가 아니라 빈번히 재기록됨** → 증분 tail 최적화가 자주 무의미해짐.
  해시 가드가 잡긴 하나 매번 전량 재파싱이면 축 4를 (c) 단독으로 단순화.
- **refresh 토큰이 회전하지 않음이 공식 확인됨** → 축 6을 (a)에서 (b) flock 갱신으로 승격,
  유휴 결손을 제거(완료 기준 1 여유 증가).
- **머신이 24/7 아니라 완료 기준 1을 uptime-상대 정의로도 못 맞춤** → 실행 형상을 원격 상주
  데몬(always-on 호스트)으로 이동(ROADMAP 보류 항목의 해제). 이때 SQLite는 그 호스트로 이전.
- **`message.id` 가 usage 라인에 결측되는 케이스 발견** → dedup 키를 `(source_id, uuid)`
  폴백으로 보강(uuid는 파일 내 유일 실측). 현 샘플에선 결측 0.
- **`five_hour`/`seven_day` 응답 키가 개명·구조 변경** → raw_json은 안전(I1), VIRTUAL 파생만
  `ALTER TABLE ADD COLUMN ... VIRTUAL` 로 새 경로 추가. 적재는 안 깨진다.
- **폴링 5분이 톱니 재현에 부족으로 판명**(리셋이 payload 값과 어긋남) → 리셋 근처 적응형
  조밀 폴링 도입(축 2 escalation).

## 되돌리기 비용

- **폴링 간격(5↔15↔1분):** 최저. cron 표현식 1줄. 과거 데이터 보존됨.
- **스냅샷 파생(VIRTUAL gencol ↔ 뷰/json_extract):** 낮음. raw_json 불변이라 파생만 재정의.
- **트랜스크립트 전략(tail+가드 ↔ 해시 단독):** 낮음~중. 부기 컬럼(`transcript_file`) 재해석,
  아카이브·usage_event는 유지.
- **토큰 (a)ride-along ↔ (b)flock 갱신:** 낮음(수집기 국소). 단 (b)로 갔다가 사고가 나면
  본체 인증 복구 비용이 큼 → 승격은 검증 게이트 통과 후에만.
- **실행 형상(cron ↔ 원격 상주):** 중. SQLite 파일 이전 + 배포 위치 변경. 스키마·수집 로직은 유지.
- **dedup 키(message.id):** 높음. 읽기 측 전 계층이 이 grain에 의존한다. 바꾸면 재적재 필요.
  그래서 실측으로 미리 못박았다.

## 출처 목록

- SQLite Generated Columns(공식): <https://www.sqlite.org/gencol.html>
  (VIRTUAL/STORED 정의, 인덱스 가능, STORED는 ALTER ADD 불가, PK 불가, NOT NULL/UNIQUE/CHECK 가능)
- SQLite JSON functions(공식): <https://www.sqlite.org/json1.html> (json_extract 누락경로→NULL)
- SQLite WAL(공식): <https://www.sqlite.org/wal.html>
- node:sqlite(공식): <https://nodejs.org/api/sqlite.html> (Node 24 내장, SQLite 3.53.0 실측)
- 실측 스크립트: `scratchpad/gc.mjs`(generated column 동작), `scratchpad/rid.py`(dedup grain)
- 환경 실측: `crontab -l`, `/etc/wsl.conf`, `aoe-web-boot.sh:65-75`,
  `runtime/cron/claude-weekly.sh`(cron/캐치업/텔레그램 패턴)
- 프로젝트 근거: `ROADMAP.md`(반증된 가설·완료 기준·M1~M12), `CLAUDE.md`(7개 규칙),
  `docs/decisions/001-stack.md`(승인 스택)
- 미확인(단정 안 함): refresh token rotation 여부, Claude Code의 자격증명 재읽기 여부,
  트랜스크립트 append-only 여부(강한 지지·미확정), `cleanupPeriodDays` 실동작
```

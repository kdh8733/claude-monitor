# 001. claude-monitor 개발 스택 선정

- 날짜: 2026-07-09 / 상태: **승인** (축 2는 리뷰에서 뒤집힘, 아래 참조)
- 작성: fullstack-dev / 리뷰·수정: 2026-07-09
- 대상 프로젝트: claude-monitor (Claude Code / Claude Max 사용량-한도 소진율 추적 대시보드, 개인용 + 포트폴리오)

---

## 배경·요구

### 목적
Claude Code / Claude Max 구독의 사용량과 한도 소진율을 지속 기록하고 시각화하는 개인용 대시보드. "Pro는 부족한데 Max 5x는 다 못 채워 쓰는 것 같다, 내 요금제를 잘 활용하고 있나?"에 답하는 것이 핵심 질문. 포트폴리오 겸용이라 UI 품질이 1급 요구사항.

### 데이터 소스 (실측 검증됨)
1. `GET https://api.anthropic.com/api/oauth/usage` (비공식/미문서화 OAuth 엔드포인트)
   - 스냅샷만 제공, 히스토리 없음 -> 폴링해서 시계열로 적재하는 것이 프로젝트의 핵심
   - accessToken ~8시간 만료 -> refreshToken 갱신 흐름을 데몬이 처리해야 함
   - 코드네임 필드(`tangelo`, `iguana_necktie` 등)가 null로 존재 -> 스키마 드리프트에 견디는 저장 설계 필요
2. Claude Code 트랜스크립트 JSONL: `~/.claude/projects/<slug>/<sessionId>.jsonl`
   - 현재 WSL 1,860 파일 / 22,565 usage 이벤트 / 316MB (2026-06-03 ~ )
   - 별도 소스 `/mnt/c/Users/kdh87/.claude/projects` (14파일, 2026-05-08 ~ , WSL보다 과거)
   - `cleanupPeriodDays` 미설정 -> 원본 소멸 위험이 적재 계층의 정당성
   - 비용 필드 없음 -> 모델별 단가표를 곱해 "API 환산가치" 계산, 단가표는 버전 관리 데이터로 두고 과거 데이터는 당시 단가로 계산 (소급 왜곡 방지)

### 제약 (사용자 확정)
- 수집 범위: WSL 로컬 우선. 단 소스 어댑터를 추상화해 나중에 다른 머신/원격을 붙일 수 있어야 함 (Windows 소스가 이미 존재 -> 2번째 어댑터로 즉시 검증). **이 추상화는 사용자가 명시 요청했으므로 "단일 사용 추상화 금지" 원칙의 예외.**
- 신선도: 배치 스냅샷 (cron 폴링). 실시간 스트리밍 불필요.
- 배포: GitHub 공개 레포. **실데이터(프롬프트 원문, 프로젝트명)는 절대 커밋 금지.** 코드만 공개, `data/`는 gitignore, 데모용 시드 픽스처 별도.
- UI: "모던하고 고급스러운" 수준. 포트폴리오 목적.
- 환경: Node v24.16.0, Python 3.9.18 (WSL). Vercel CLI + 플러그인/스킬 다수 보유.

### 운영 전제
1인 운영. 새 의존성/추상화/유연성은 정당화될 때만 추가. 단순성 우선.

### 배포 형상이 만드는 핵심 제약
같은 코드베이스가 두 컨텍스트에서 돌아야 한다.
- **로컬(실데이터)**: 데몬이 실데이터를 적재, 대시보드가 로컬에서 실데이터를 읽음. 절대 커밋 안 됨.
- **Vercel(데모)**: 시드 픽스처만 노출. 공개되어도 안전해야 함.
이 둘을 하나의 코드로 처리하는 방법이 축 2/3의 판단을 지배한다.

---

## 축 1. 수집기(collector) 런타임

폴링 데몬 + 토큰 갱신 + JSONL 스트리밍 파서.

| 항목 | Node/TS (권고) | Python 3.9 (차선 아님, 반대) | 출처 |
|---|---|---|---|
| 런타임 상태 | Node 24.16 LTS 계열, 활발 | **Python 3.9 EOL 2025-10-31, 보안 패치 종료** | [python devguide](https://devguide.python.org/versions/), [3.9.25 final](https://www.python.org/downloads/release/python-3925/) |
| 웹 스택과 언어 통일 | 예 (TS 단일) | 아니오 (이중 언어) | - |
| JSONL 스트리밍 파싱 | 표준 `readline`/스트림, 충분 | 표준 라이브러리로 가능 | - |
| 러닝코스트 (1인) | 낮음 (웹과 동일 언어) | 중 (컨텍스트 스위칭) | - |
| 셋업 복잡도 | 낮음 | 중 (3.9 EOL, 업그레이드 부담) | - |
| DuckDB 연동 | `@duckdb/node-api` 동일 프로세스 | 별도 프로세스/파일 경유 | [node-api](https://www.npmjs.com/package/@duckdb/node-api) |

정성 근거: Python 3.9는 이미 upstream EOL이고 WSL엔 3.9뿐이라, Python을 쓰려면 런타임 업그레이드부터 해야 한다. 이는 "단순성 우선"에 정면으로 반한다. 파싱 성능은 316MB / 22.5k 이벤트 규모에서 스트리밍이면 두 언어 모두 병목이 아니다 (배치 폴링이라 처리량 요건도 낮음). 결정적 이점은 **언어 통일**이다. 데몬-저장-웹이 전부 TS면 타입(응답 스키마, usage 이벤트 형태)을 한 번만 정의해 공유하고, 1인 운영의 컨텍스트 스위칭이 사라진다.

- **권고: Node/TS.** 웹 스택과 통일, 타입 공유, Python 3.9 EOL 회피.
- **차선: (Python 아님) Node/TS 유지 + 파서만 필요 시 worker_threads 분리.** 현 규모에선 불필요하므로 성능 문제가 실측될 때만.

---

## 축 2. 저장소

시계열(폴링 스냅샷) + 귀속(프로젝트/모델별 집계). 워크로드 특성: **쓰기는 저빈도 배치(cron), 읽기는 분석형 집계(대시보드)**. 로컬 전용이 기본, 데이터는 커밋 안 함, 데모는 시드만.

> **[리뷰 수정 2026-07-09] 최초 권고(DuckDB)는 기각됐다.**
> 최초 비교표는 **다중 프로세스 동시성**을 평가 항목에 넣지 않았고, 그 결과 축 3의 권고
> (수집 데몬이 쓰는 동안 Next.js 서버가 같은 파일을 읽음)와 모순됐다.
> 아래 표는 그 항목을 추가하고 실측으로 재작성한 것이다.

### 결정적 제약: 수집 데몬(쓰기)과 대시보드 서버(읽기)는 별도 프로세스다

DuckDB 공식 문서 (<https://duckdb.org/docs/current/connect/concurrency.html>):

> "In in-process mode, DuckDB offers two concurrency options: **read-write mode (one process reads and writes)**
> and **read-only mode (multiple processes read, but no writing is allowed)**."

즉 인프로세스 DuckDB는 "쓰는 프로세스 1개" 또는 "읽기만 하는 여러 프로세스" 중 하나만 된다.
우리가 필요한 "쓰는 프로세스 1개 + 읽는 프로세스 1개"는 지원되지 않는다.
우회하려면 Quack 원격 프로토콜이나 DuckLake + PostgreSQL 카탈로그가 필요한데,
5분마다 한 행을 쓰는 개인 대시보드에 클라이언트-서버 DB를 도입하는 것은 명백한 과설계다.

같은 DuckDB 문서가 SQLite는 그 패턴을 지원한다고 명시한다
(<https://duckdb.org/docs/current/core_extensions/sqlite.html>):

> "DuckDB supports concurrent read and write operations on SQLite databases.
> Multiple threads or processes can read simultaneously, but only one can write at a time."

### 규모 재검토

컬럼 엔진의 이점은 규모에서 나온다. 이 프로젝트의 규모는:

- 폴링 스냅샷: 5분 간격 = **연 105,120행**
- 트랜스크립트 usage 이벤트: 5주치 **22,565건** (누적해도 연 20만 건 수준)

이 규모에서 DuckDB의 벡터화 이점은 측정되지 않는다. 최초 표는 워크로드의 *성격*(분석형)만
보고 *규모*를 보지 않았다.

### 재작성한 비교표

| 항목 | node:sqlite (권고) | better-sqlite3 | DuckDB | Postgres/Neon | Parquet 단독 |
|---|---|---|---|---|---|
| **다중 프로세스 쓰기1+읽기N** | **예 (WAL, 실측 확인)** | 예 (WAL) | **아니오 (인프로세스)** | 예 | 아니오 |
| 의존성 | **0 (Node 24 내장)** | 네이티브 컴파일 1개 | prebuilt 바이너리 1개 | 클라이언트 + 서버 | 엔진 별도 필요 |
| Node 24 안정성 | 내장 (`DatabaseSync`, `StatementSync`, `Session`, `backup`) | 컴파일/self-register 이슈 이력 | 높음 | 높음 | - |
| 집계 성능 (연 ~20만 행) | 충분 (인덱스) | 충분 | 최상 (무의미한 우위) | 충분 | 엔진 의존 |
| 스키마 드리프트 | **`json_extract` 내장 (실측 확인)** | JSON1 동일 | JSON 타입 | JSONB | 스키마 고정 |
| JSONL 직접 쿼리 | 아니오 (파서 직접) | 아니오 | 예 (`read_json_auto`) | 아니오 | 아니오 |
| Parquet 내보내기 | 아니오 (필요 시 DuckDB CLI로 ATTACH) | 아니오 | 네이티브 | 별도 | 네이티브 |
| 운영부담 (1인) | 최저 (단일 파일) | 낮음 | 낮음 | **높음 (서버/시크릿/마이그레이션)** | 낮음 |

실측 (Node v24.16.0, 별도 프로세스 writer/reader 동시 실행):

```
reader: 40 successful reads, 0 errors, last count=42   # 라이터가 쓰는 도중 읽음
writer: 200 rows inserted
journal_mode: wal
json_extract 동작: {"u":0}
```

정성 근거:
- **Postgres/Neon 탈락**: 로컬 전용 배치 대시보드에 서버형 DB는 과설계다. 실데이터를 클라우드 DB에 넣으면 "데이터 커밋 금지" 정신과도 어긋난다.
- **Parquet 단독 탈락**: 포맷일 뿐 쿼리 엔진이 아니다.
- **DuckDB 탈락**: 위 동시성 제약. 다만 **버릴 필요는 없다.** DuckDB CLI로 SQLite 파일을 `ATTACH` 해 애드혹 분석과 Parquet 내보내기를 할 수 있다. 시스템 오브 레코드는 SQLite, 분석은 필요할 때 DuckDB. 런타임 의존성은 늘지 않는다.
- **better-sqlite3 탈락**: `node:sqlite`가 내장으로 같은 일을 한다. 의존성이 0인 쪽이 이긴다 (글로벌 규칙: 새 의존성 추가는 피할 수 있으면 금지).
- 스키마 드리프트: 원본 JSON을 raw 컬럼에 그대로 저장하고, 조회 컬럼은 `json_extract` 로 파생시킨다. 파싱 실패가 적재 실패가 되지 않는다.

- **권고: `node:sqlite` (Node 24 내장, WAL).** raw 스냅샷 테이블 + 파생 집계 + 버전 관리 단가표. 의존성 0.
- **차선: `better-sqlite3`.** `node:sqlite` API가 부족하면(예: 커스텀 함수, 확장 로딩) 교체. 전환 비용 낮음 (SQL 동일).
- **애드혹 분석: DuckDB CLI + `ATTACH`.** 런타임 의존성 아님.

---

## 축 3. 웹 프레임워크 + 렌더링

핵심 요건: **하나의 코드베이스로 로컬 실데이터 구동 + Vercel 데모(시드)를 처리.** 실데이터는 클라이언트로 새지 않아야 한다.

> **[리뷰 수정 2026-07-09]** 이 절의 표와 서술에 나오는 "DuckDB"는 전부 **`node:sqlite`(읽기 전용 핸들)** 로 읽는다.
> 결론(Next.js App Router 권고)은 바뀌지 않는다. DuckDB-WASM 데모 경로는 폐기하고,
> 데모는 시드 픽스처에서 빌드타임에 계산한 정적 페이지로 굽는다 (더 단순하고, 노출할 쿼리 엔진이 없다).

| 항목 | Next.js App Router (권고) | Vite + React SPA + DuckDB-WASM (차선) | 순수 정적 SSG (예: Astro) | 출처 |
|---|---|---|---|---|
| 버전/요건 | 16.2.x, **Node 20+ (Node 24 OK)** | Vite 안정 | - | [next 16](https://nextjs.org/blog/next-16), [npm next](https://www.npmjs.com/package/next) |
| 서버 데이터 접근 (실데이터 비노출) | RSC/서버에서 DuckDB 직접 읽음, 클라 미노출 | 브라우저가 Parquet 로드 (시드만 노출 가능) | 빌드타임만 | - |
| 로컬 실데이터 구동 | `next start` (Node 서버가 로컬 DuckDB 읽기) | dev 서버 + 로컬 Parquet | 빌드 재실행 필요 | - |
| Vercel 데모 배포 | `output: export` 정적(시드 baked) 또는 서버 배포 | 완전 정적 (Parquet + WASM) | 완전 정적 | - |
| 포트폴리오 임팩트 | 높음 (업계 표준 프레임워크 서사) | 높음 (로컬-퍼스트 분석 서사) | 중 | - |
| 셋업 복잡도 | 중 | 중 (WASM 번들/COOP-COEP 헤더) | 낮음 | - |
| Vercel 궁합 | 최상 (사용자 CLI/스킬 보유) | 양호 | 양호 | - |
| 운영부담 | 낮음 | 낮음 | 낮음 | - |

정성 근거: 신선도가 배치라 실시간 서버는 불필요하지만, RSC로 서버(로컬 Node)에서 DuckDB를 직접 읽으면 **실데이터를 클라이언트로 내보내지 않고** 집계 결과만 렌더할 수 있다. 이게 "데이터 비공개" 제약과 잘 맞는다. 데모는 `output: export`로 시드에서 계산한 정적 페이지를 굽는다. 즉 로컬은 동적 렌더(실데이터), 데모는 정적 export(시드) - 환경 변수로 데이터 어댑터만 스위칭하면 단일 코드베이스. 사용자가 Vercel 자산을 다수 보유해 채택 마찰도 낮다.

차선(Vite SPA + DuckDB-WASM)은 "브라우저에서 SQL을 돌리는 로컬-퍼스트 분석"이라는 더 참신한 포트폴리오 서사를 주고 백엔드가 0이라 배포가 가장 단순하다. 단점은 (1) 실데이터도 브라우저로 로드해야 하므로 로컬 모드에서 데이터가 클라이언트 메모리에 올라간다 (개인 로컬 사용이라 유출은 아니지만 RSC만큼 깔끔하진 않음), (2) 프레임워크 서사(라우팅/RSC/서버액션)가 약해 포트폴리오에서 "Next.js 다룰 줄 안다" 신호가 덜하다. DuckDB-WASM 경로는 **데모 배포 한정 기법으로 Next.js 안에 흡수**하는 것을 권한다 (데모=정적 Parquet+WASM, 로컬=RSC+node-api).

- **권고: Next.js App Router.** 로컬은 RSC가 DuckDB 직접 읽기, 데모는 `output: export` + 시드. 데이터 어댑터를 env로 스위칭.
- **차선: Vite + React SPA + DuckDB-WASM.** 백엔드 0, 배포 최단. 프레임워크 서사보다 로컬-퍼스트 분석 데모 임팩트를 우선한다면.

---

## 축 4. 차트/시각화

필요 차트: 게이지(소진율), 시계열(추이), 스택 바(프로젝트별 귀속), 히트맵(시간대별). 요건: 고급스러운 커스텀 UI, 접근성, 다크모드.

| 항목 | visx (권고) | Recharts (차선) | ECharts | Observable Plot | 출처 |
|---|---|---|---|---|---|
| npm 주간 다운로드 | @visx/shape ~1.26M | ~46.6M | ~3.16M | 미확인 (수치 미확보) | [npmtrends](https://npmtrends.com/@visx/scale-vs-chart.js-vs-echarts-vs-highcharts-vs-recharts-vs-vis) |
| GitHub 스타 | ~20.8k (airbnb/visx) | ~27.2k | ~66.5k | 미확인 | [visx](https://github.com/airbnb/visx), [recharts](https://github.com/recharts/recharts), [echarts](https://github.com/apache/echarts) |
| 렌더 방식 | SVG (React 원소) | SVG | Canvas | SVG | - |
| 게이지 | 직접 조립 (arc) | 직접 조립 | OOB | 직접 조립 | - |
| 히트맵 | 예제/프리미티브 제공 | 약함 (직접) | OOB (캘린더 히트맵) | OOB (cell mark) | - |
| 시계열/스택 바 | 프리미티브 조립 | OOB 쉬움 | OOB | OOB (간결) | - |
| 커스텀/디자인 제어 | 최상 (D3 프리미티브) | 중 | 중 (테마 필요) | 중 | - |
| 접근성/다크모드 | 최상 (직접 제어, Tailwind 테마) | 양호 | 약함 (Canvas, a11y 제한) | 양호 | - |
| 러닝코스트/코드량 | 높음 (조립) | 낮음 | 중 | 낮음 (문법 간결, React는 imperative useEffect) | - |
| 의존성 | @visx/* 다패키지 | 단일 | 단일(무거움) | 단일 | - |

정성 근거: "고급스러운 UI, 포트폴리오"가 명시된 1급 요건이라 디자인 제어력을 높게 둔다.
- **Recharts**는 시계열/스택 바를 가장 빨리 그리지만 게이지/히트맵이 약해 결국 커스텀이 필요하고, 룩이 흔해 차별화가 어렵다.
- **ECharts**는 게이지+캘린더 히트맵까지 전부 OOB지만 Canvas라 CSS/디자인 시스템 결합과 접근성이 약하고, 기본 룩이 "제너릭한 대시보드" 느낌이라 프리미엄 커스텀에 역행한다.
- **Observable Plot**은 문법이 간결하나 React에선 useEffect로 명령형 삽입이라 인터랙션 폴리시가 약하고 정량 생태계 근거(다운로드)를 이번 조사로 확정 못 했다 (미확인).
- **visx**는 D3 프리미티브를 React SVG로 노출해 게이지/히트맵/시계열을 원하는 대로 조립할 수 있고, Tailwind 토큰으로 다크모드/색을 직접 제어하며 SVG라 접근성 마크업을 직접 넣을 수 있다. 대가는 코드량이다. 포트폴리오에서 "차트를 직접 설계했다"는 신호가 가장 강하다.

주의: visx는 "단순성 우선/의존성 최소화"와 긴장한다. 다만 포트폴리오 품질이 사용자가 명시한 1급 요건이므로 그 대가를 정당화한다. 이 트레이드오프는 사용자가 눈으로 보고 골라야 한다.

- **권고: visx.** 게이지/히트맵/시계열을 디자인 시스템에 맞춰 직접 조립, 최고 제어력과 포트폴리오 임팩트. 대가는 코드량.
- **차선: Recharts.** 일정이 빡빡하면 시계열/스택 바를 즉시 그리고 게이지만 커스텀 SVG로 보완. 리스크 최저. (게이지/히트맵 OOB 리치함이 커스텀 룩보다 중요하다면 ECharts가 3순위 대안.)

---

## 축 5. UI 시스템

| 항목 | shadcn/ui + Tailwind v4 (권고) | Mantine (차선) | MUI | Radix Primitives 직접 + Tailwind | 출처 |
|---|---|---|---|---|---|
| 소유 모델 | 소스 복붙(코드 소유) | npm 패키지 | npm 패키지 | 프리미티브 + 직접 스타일 | [shadcn tw v4](https://ui.shadcn.com/docs/tailwind-v4) |
| Tailwind v4 | 네이티브 지원, OKLCH, data-slot | 자체 스타일 엔진 | emotion | Tailwind | [shadcn tw v4](https://ui.shadcn.com/docs/tailwind-v4) |
| 커스텀/차별화 | 최상 (코드 직접 수정) | 중 (테마 API) | 중 (theme override) | 최상 | - |
| 접근성 | Radix 기반 내장 | 양호 | 양호 | Radix 내장 | - |
| 다크모드 | CSS 변수/토큰 | 내장 | 내장 | 직접 | - |
| 배터리 (폼/훅/날짜) | 최소 (필요 시 추가) | 풍부 | 풍부 | 없음 | - |
| Vercel/생태계 궁합 | 최상 (사용자 shadcn 스킬 보유) | 중 | 중 | 중 | - |
| 러닝코스트 | 낮음 (사용자 자산 보유) | 중 | 중 | 높음 | - |

정성 근거: shadcn/ui는 컴포넌트를 프로젝트에 복붙해 소유하므로 포트폴리오 차별화를 위해 자유롭게 뜯어고칠 수 있고, Radix 기반이라 접근성이 기본 확보되며, Tailwind v4를 네이티브 지원(OKLCH 색, data-slot 스타일 훅)한다. 사용자가 shadcn 스킬을 보유해 채택 마찰이 없다. Mantine은 폼/훅/차트까지 배터리가 풍부해 빠르지만 룩이 다소 정형화돼 차별화가 덜하다. MUI는 머티리얼 색이 강해 "제너릭 AI 룩" 위험. Radix 직접은 최고 제어지만 shadcn이 이미 그 위 얇은 층이라 굳이 맨바닥일 이유가 없다.

포트폴리오 차별화를 위해 커스텀할 지점 (권고): (1) 디자인 토큰(색/타이포/간격)을 shadcn 기본에서 벗어난 자체 팔레트로, (2) 대시보드 셸(사이드바/그리드/카드) 레이아웃을 bespoke하게, (3) 차트 테마를 UI 토큰과 한 시스템으로 묶어 라이트/다크 일관. 나머지 표준 컴포넌트(버튼/다이얼로그 등)는 shadcn 기본을 그대로 써 시간을 아낀다.

- **권고: shadcn/ui + Tailwind v4.** 코드 소유로 커스텀 자유, Radix 접근성, 사용자 자산 활용.
- **차선: Mantine.** 폼/훅/날짜 유틸 배터리가 개발 속도를 크게 올림. 차별화보다 완성 속도를 우선한다면.

---

## 권고 조합 (한 문단, 리뷰 반영판)

**수집기 Node/TS 단일 언어**로 데몬(폴링 + refreshToken 갱신 + 소스 어댑터: WSL/Windows JSONL)과 파서를 짜고, **저장은 `node:sqlite` 단일 파일(WAL)** 에 원본 raw 스냅샷 + 파생 집계 테이블 + 버전 관리되는 모델 단가표를 두어 스키마 드리프트와 소급 왜곡을 방어한다. 런타임 의존성은 0이고, 데몬이 쓰는 동안 대시보드가 읽는 것이 실측으로 확인됐다. **웹은 Next.js App Router**로 로컬에선 RSC가 SQLite를 읽기 전용으로 열어 집계 결과만 렌더하고(실데이터가 클라이언트로 나가지 않음), Vercel 데모는 `output: export`로 시드 픽스처에서 계산한 정적 페이지를 구워 실데이터 커밋/유출을 원천 차단한다. **차트는 visx**로 게이지/시계열/스택 바/히트맵을 디자인 시스템에 맞춰 직접 조립하고, **UI는 shadcn/ui + Tailwind v4**를 코드 소유해 자체 팔레트와 bespoke 대시보드 셸로 포트폴리오 차별화를 낸다. 애드혹 분석과 Parquet 내보내기가 필요하면 DuckDB CLI로 SQLite 파일을 `ATTACH` 한다 (런타임 의존성 아님). 전 계층 TypeScript로 응답/이벤트 스키마 타입을 공유한다.

## 반증 조건 (이 조합이 틀릴 수 있는 경우)

- **`node:sqlite` API 부족**: 커스텀 SQL 함수나 확장 로딩이 필요해지면 -> `better-sqlite3` 로 교체 (SQL 동일, 전환 비용 낮음).
- **visx 코드량이 일정을 압박**: 게이지/히트맵 커스텀 조립이 1인 일정에 과하면 -> 차트를 **Recharts(+커스텀 게이지)** 로 내리거나 히트맵/게이지 OOB가 절실하면 ECharts.
- **RSC 데이터 접근이 과하다고 판명**: 로컬 대시보드가 순수 클라이언트로 충분하고 프레임워크 서사가 불필요하다면 -> **Vite SPA** 로 단순화 (백엔드 0).
- **JSONL 파싱이 실측 병목**: 316MB/22.5k가 커져 Node 스트리밍이 느려지면 -> worker_threads 분리 (언어를 Python으로 바꾸는 것은 3.9 EOL 때문에 여전히 부적절).
- **Windows 어댑터가 예상보다 복잡**: 소스 추상화가 두 어댑터로 검증되지 않으면 추상화 경계를 재설계 (인터페이스는 최소로).
- **데이터가 예상보다 훨씬 커짐**: 연 20만 행 가정이 깨져 SQLite 집계가 느려지면 -> 그때 컬럼 엔진(DuckDB, 단 별도 read 프로세스 구조 재설계 필요)을 재검토. 지금 도입할 근거는 없다.

---

## 영향·후속

- 상태 **승인**. 축 2만 리뷰에서 뒤집혔고(DuckDB -> `node:sqlite`), 나머지 4개 축은 원안대로다.
- 후속: `data/`, `*.sqlite`, `.credentials` 류를 `.gitignore`에 확정 (완료) / 시드 픽스처 생성 파이프라인 / 소스 어댑터 인터페이스 정의(WSL, Windows) / 모델 단가표를 `effective_from` 을 갖는 버전 관리 데이터로 스키마화.
- 되돌리기 비용: 저장(`node:sqlite` <-> `better-sqlite3`)과 차트(visx <-> Recharts)는 국소 교체로 낮음. 웹 프레임워크(Next.js <-> Vite)는 렌더링 계층 재작성이라 중간. 언어(Node/TS)는 전 계층에 걸쳐 되돌리기 비용 높음 -> 이 결정이 가장 되돌리기 어려우나, Python 3.9 EOL 때문에 방향은 명확.

### 리뷰에서 배운 것 (방법론)

최초 문서는 워크로드의 **성격**(분석형 집계)만 보고 **규모**(연 20만 행)와 **배포 형상**(별도 프로세스)을 표의 항목으로 넣지 않았다. 그 결과 축 2의 권고가 축 3의 권고와 모순됐다. 스택 비교표에는 성능 축뿐 아니라 **프로세스 경계와 동시성 모델**이 항목으로 들어가야 한다.

### 출처 목록
- Next.js 16 / 버전: <https://nextjs.org/blog/next-16>, <https://www.npmjs.com/package/next>, <https://endoflife.date/nextjs>
- Python 3.9 EOL: <https://devguide.python.org/versions/>, <https://www.python.org/downloads/release/python-3925/>
- DuckDB Node.js (Neo) node-api: <https://www.npmjs.com/package/@duckdb/node-api>, <https://duckdb.org/docs/current/clients/node_neo/overview>
- DuckDB-WASM: <https://github.com/duckdb/duckdb-wasm>
- better-sqlite3: <https://www.npmjs.com/package/better-sqlite3>, <https://github.com/WiseLibs/better-sqlite3/issues/1376>
- 차트 생태계 규모: <https://npmtrends.com/@visx/scale-vs-chart.js-vs-echarts-vs-highcharts-vs-recharts-vs-vis>, <https://github.com/airbnb/visx>, <https://github.com/recharts/recharts>, <https://github.com/apache/echarts>
- Observable Plot: <https://github.com/observablehq/plot>, <https://www.npmjs.com/package/@observablehq/plot>
- shadcn/ui + Tailwind v4: <https://ui.shadcn.com/docs/tailwind-v4>

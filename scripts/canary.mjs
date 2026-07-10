// 완료 기준 6 의 기계적 수문장.
//
// 이 프로젝트에서 "실데이터가 빌드에 안 들어간다"는 여러 번 사람이 눈으로 확인했다.
// 사람은 잊는다. 데이터 접근 코드를 누가 건드리면 조용히 깨진다. 그래서 기계가 지킨다.
//
// 두 가지를 검사한다.
//   1. 빌드 산출물에 실데이터의 지문이 없다.
//   2. git 이 추적하는 파일에 데이터 파일이 없다.
//
// 의존성 0. `node scripts/canary.mjs [outDir]`
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, extname } from 'node:path';

const outDir = process.argv[2] ?? 'web/out';

// 실데이터의 지문. 데모 시드에는 절대 나올 수 없는 것들이다.
const FORBIDDEN = [
  { re: /\/root\/workspace\//, why: '실 파일시스템 경로' },
  { re: /\/mnt\/c\/Users\//, why: 'Windows 사용자 경로' },
  { re: /[A-Za-z]:\\+Users\\+/, why: 'Windows 절대경로 (projectLabel 이 놓친 적 있다)' },
  { re: /\/home\/[a-z]/i, why: '홈 디렉터리 경로' },
  { re: /sk-ant-/, why: 'Anthropic API 키 접두사' },
  { re: /"accessToken"\s*:/, why: '자격증명 필드' },
  { re: /"refreshToken"\s*:/, why: '자격증명 필드' },
  { re: /SQLite format 3/, why: 'SQLite 파일이 산출물에 들어갔다' },
];

// 데모 시드에 실재해야 하는 것. 없으면 카나리가 빈 페이지를 통과시킨 것이다.
const REQUIRED = ['aurora-api', '버려진 헤드룸', '실제 청구액'];

const TEXTLIKE = new Set(['.html', '.js', '.css', '.json', '.txt', '.map', '.svg', '']);

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

let failures = 0;
let scanned = 0;
let corpus = '';

for (const f of walk(outDir)) {
  scanned++;
  if (extname(f) === '.sqlite' || f.endsWith('.sqlite-wal') || f.endsWith('.sqlite-shm')) {
    console.error(`FAIL  sqlite 파일이 산출물에 있다: ${f}`);
    failures++;
    continue;
  }
  const isText = TEXTLIKE.has(extname(f));
  if (!isText && statSync(f).size > 4_000_000) continue; // 큰 바이너리(폰트 등)는 건너뛴다
  // 금지 패턴은 전부 ASCII 라 latin1 로도 잡힌다. 필수 문자열은 한글이라 utf8 이어야 한다.
  const body = readFileSync(f, isText ? 'utf8' : 'latin1');
  for (const { re, why } of FORBIDDEN) {
    if (re.test(body)) {
      console.error(`FAIL  ${f}: ${why} (${re})`);
      failures++;
    }
  }
  // 필수 문자열은 사람이 보는 문서에서만 찾는다. RSC 페이로드(.txt)까지 포함하면
  // index.html 이 비어도 통과한다 (변이 테스트로 확인).
  if (f === join(outDir, 'index.html')) corpus = body;
}

for (const need of REQUIRED) {
  if (!corpus.includes(need)) {
    console.error(`FAIL  index.html 에 "${need}" 가 없다. 빈 페이지를 통과시키고 있다.`);
    failures++;
  }
}

// git 이 데이터 파일을 추적하고 있지 않은지.
const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n');
const dataLike = tracked.filter((p) =>
  /^data\//.test(p) || /\.(sqlite|sqlite-wal|sqlite-shm|duckdb|parquet)$/.test(p) || /\.credentials\.json$/.test(p));
if (dataLike.length > 0) {
  console.error(`FAIL  git 이 데이터 파일을 추적한다: ${dataLike.join(', ')}`);
  failures++;
}

console.log(`카나리: ${scanned} 파일 검사, 금지 패턴 ${FORBIDDEN.length}종, 필수 문자열 ${REQUIRED.length}종`);
if (failures > 0) {
  console.error(`\n실패 ${failures}건. 완료 기준 6 위반.`);
  process.exit(1);
}
console.log('통과: 산출물에 실데이터 지문 없음, git 에 데이터 파일 없음.');

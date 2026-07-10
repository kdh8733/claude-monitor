# 접근성 감사 (완료 기준 7 / M12)

- 날짜: 2026-07-10
- 도구: Lighthouse 13.4.0, Chrome headless (`--headless=new`)
- 대상: `npm run build` 의 정적 산출물 (`web/out/`, 데모 모드)
- 감사 명령: `lighthouse http://localhost:4321/ --only-categories=accessibility`

## 결과

| 테마 | 점수 | 실패 감사 |
|---|---|---|
| 라이트 | **100** | 없음 |
| 다크 | **100** | 없음 |

기준은 90+ 이다. 두 테마 모두 통과.

다크 테마 감사 방법: 헤드리스 Chrome 은 `prefers-color-scheme: light` 로 뜬다.
산출물 사본의 `<head>` 에 `localStorage.setItem('cm-theme','dark')` 를 주입해 감사했고,
`--dump-dom` 으로 실제 DOM 이 `<html lang="ko" data-theme="dark">` 임을 확인한 뒤 점수를 읽었다.
(주입만 하고 라이트로 렌더된 것을 다크라고 보고하지 않기 위한 확인이다.)

## 첫 감사에서 잡힌 실 결함 3건

첫 감사 점수는 92 였다. 기준은 이미 넘었지만 실패 감사 3건은 진짜 결함이라 고쳤다.

1. **`aria-prohibited-attr` (32건)** - `<rect>` 에 `role` 없이 `aria-label` 을 달았다.
   role 없는 `rect` 에서 `aria-label` 은 **무시된다.** 스크린 리더 사용자에게 스택 바와
   히트맵의 모든 셀이 이름 없는 도형이었다. `role="img"` 추가.

2. **`color-contrast` (31건)** - `--mute: #898781` 이 페이지 배경 대비 **3.4:1** 이었다
   (11px 텍스트는 AA 4.5:1 필요). `--accent: #2a78d6` 도 4.28:1 로 미달.
   `CLAUDE.md` 6항이 요구한 "뮤트 타이포"는 **흐리게**이지 **읽을 수 없게**가 아니다.
   `--mute: #6f6e68`, `--accent: #2064b4` 로 조정. 차트 마크 색(`--series-*`)은 건드리지 않았다.
   텍스트 대비 규칙과 마크 대비 규칙은 다르다.

3. **`label-content-name-mismatch` (1건)** - 테마 토글의 보이는 글자가 "DARK" 인데
   접근 가능한 이름이 "다크 테마로 전환" 이었다. 음성 제어 사용자는 보이는 대로 말하므로
   이름에 보이는 글자가 포함되어야 한다. `aria-label="DARK 테마로 전환"` 으로 수정.

## 재현

```sh
npm run build
node scripts/serve-out.mjs   # 또는 임의의 정적 서버로 web/out 서빙
npx lighthouse http://localhost:4321/ --only-categories=accessibility \
  --output=json --output-path=lh.json --chrome-flags="--headless=new --no-sandbox"
```

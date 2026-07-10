// 데이터 모드 (003 축 3):
//   기본값 = 데모. 커밋된 합성 시드만으로 정적 export 를 굽는다 - 실데이터가 빌드에
//   섞이는 것을 구조적으로 막는다 (완료 기준 6). live 는 명시적 opt-in 이다.
//   CLAUDE_MONITOR_MODE=live 일 때만 서버 렌더(export 없음) + data/usage.sqlite 읽기 전용.
import type { NextConfig } from 'next';

const live = process.env.CLAUDE_MONITOR_MODE === 'live';

const nextConfig: NextConfig = {
  // 데모 = 정적 export. 요청 시점 데이터 접근 자체가 없다 (003 축 3의 2차 방벽).
  ...(live ? {} : { output: 'export' as const }),
};

export default nextConfig;

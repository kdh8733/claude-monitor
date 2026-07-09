// 트랜스크립트 소스 정의. 평범한 배열 - 어댑터 인터페이스는 M6 범위.
// 루트가 없는 소스는 archiveOnce가 조용히 건너뛴다 (Windows 소스가 없는 머신도 있다).
// 공개 레포다. 사용자명을 코드에 굳히지 않는다 - WSL 마운트에서 찾아낸다.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function windowsProjectsRoot(): string | null {
  const override = process.env.CLAUDE_MONITOR_WINDOWS_PROJECTS;
  if (override) return override;

  const users = '/mnt/c/Users';
  try {
    for (const name of readdirSync(users)) {
      const candidate = join(users, name, '.claude', 'projects');
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // WSL 마운트가 없는 머신
  }
  return null;
}

const windows = windowsProjectsRoot();

export const SOURCES = [
  { id: 'wsl', root: join(homedir(), '.claude', 'projects') },
  ...(windows === null ? [] : [{ id: 'windows', root: windows }]),
];

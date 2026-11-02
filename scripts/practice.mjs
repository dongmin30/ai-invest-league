// `npm run practice`: `npm run dev` with ENV_OVERLAY=.env.practice (sim prices, always-open
// markets, separate DATA_DIR). A node launcher so it works the same in Git Bash, PowerShell and cmd.
import { spawn } from 'node:child_process';

console.log('[practice] 연습 모드: 가상 시세 · 상시 개장 · 데이터는 server/data/practice');
const child = spawn('npm run dev', {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, ENV_OVERLAY: '.env.practice' },
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

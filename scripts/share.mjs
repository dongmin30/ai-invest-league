// `npm run share`: build the web app, start the server (실제 시세, server/data 의 DB) with
// ENV_OVERLAY=.env.share, then open a Cloudflare quick tunnel so teammates can join from anywhere.
// The server itself still listens on localhost only; the tunnel is the one way in.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const PORT = 8787;
const LOCAL = `http://localhost:${PORT}`;

function findCloudflared() {
  const candidates = [
    process.env.CLOUDFLARED,
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const probe = spawnSync('cloudflared', ['--version'], { stdio: 'ignore', shell: true });
  return probe.status === 0 ? 'cloudflared' : null;
}

const cloudflared = findCloudflared();
if (!cloudflared) {
  console.error('[share] cloudflared 가 없습니다. 설치: winget install --id Cloudflare.cloudflared');
  process.exit(1);
}

try {
  const res = await fetch(`${LOCAL}/api/health`);
  if (res.ok) {
    console.error(`[share] ${PORT} 포트에서 이미 서버가 돌고 있습니다 (npm run dev?). 끄고 다시 실행해 주세요.`);
    process.exit(1);
  }
} catch {
  // Nothing listening: expected.
}

console.log('[share] 웹 빌드 중…');
const build = spawnSync('npm run build', { stdio: 'inherit', shell: true });
if (build.status !== 0) process.exit(build.status ?? 1);

const children = [];
let stopping = false;
function killChildren() {
  for (const c of children) {
    if (c.exitCode !== null) continue;
    // shell: true wraps npm in cmd.exe on Windows; kill the whole tree.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  killChildren();
  process.exit(code);
}
// SIGHUP: the console window was closed; SIGBREAK: Ctrl+Break on Windows.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(signal, () => stop(0));
// Last resort for any other exit path (spawnSync is allowed inside an exit handler).
process.on('exit', killChildren);

const server = spawn('npm start', {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, ENV_OVERLAY: '.env.share' },
});
children.push(server);
server.on('exit', (code) => {
  if (!stopping) console.error(`[share] 서버가 종료되었습니다 (code ${code}).`);
  stop(code ?? 1);
});

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${LOCAL}/api/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

if (!(await waitForServer())) {
  console.error('[share] 서버가 60초 안에 뜨지 않았습니다.');
  stop(1);
}

const tunnel = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--url', LOCAL], { stdio: ['ignore', 'pipe', 'pipe'] });
children.push(tunnel);
let announced = false;
const onTunnelOutput = (chunk) => {
  const text = chunk.toString();
  // Skip api.trycloudflare.com, which appears in cloudflared's own error lines.
  const match = text.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
  if (match && !announced) {
    announced = true;
    const line = '='.repeat(64);
    console.log(`\n${line}\n  외부 접속 주소: ${match[0]}\n  이 PC: ${LOCAL}\n  종료: Ctrl+C (주소는 실행할 때마다 바뀝니다)\n${line}\n`);
  }
  if (/\b(ERR|error)\b/.test(text) && !/ERR Cannot determine default origin certificate/.test(text)) {
    process.stderr.write(`[tunnel] ${text}`);
  }
};
tunnel.stdout.on('data', onTunnelOutput);
tunnel.stderr.on('data', onTunnelOutput);
tunnel.on('exit', (code) => {
  if (!stopping) console.error(`[share] 터널이 종료되었습니다 (code ${code}).`);
  stop(code ?? 1);
});

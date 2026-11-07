// `npm run share`: build the web app, start the server (실제 시세, server/data 의 DB) with
// ENV_OVERLAY=.env.share, then open a Cloudflare quick tunnel so teammates can join from anywhere.
// The server itself still listens on localhost only; the tunnel is the one way in.
// Registering needs a signup code (입장코드): SIGNUP_CODE from the env files, or a fresh one per run.
import { spawn, spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

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

/** SIGNUP_CODE as the server will see it: shell, then .env, server/.env, .env.share (later files win). */
function configuredSignupCode() {
  let value = process.env.SIGNUP_CODE;
  for (const file of ['.env', 'server/.env', '.env.share']) {
    if (!fs.existsSync(file)) continue;
    const parsed = dotenv.parse(fs.readFileSync(file));
    if (file === '.env.share' && parsed.SIGNUP_CODE?.trim()) {
      console.error('[share] .env.share 는 git 에 올라가는 파일입니다. SIGNUP_CODE 는 .env 에 넣어 주세요.');
      process.exit(1);
    }
    if ('SIGNUP_CODE' in parsed) value = parsed.SIGNUP_CODE;
  }
  return value?.trim() || null;
}

// No ambiguous characters (0/O, 1/I/L); 31^8 ≈ 8.5×10^11 codes against 10 tries per minute per IP.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateSignupCode() {
  const chars = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

let signupCode = configuredSignupCode();
let overlay = '.env.share';
if (!signupCode) {
  // An env file may set SIGNUP_CODE= (empty), which would override a shell variable, so the
  // generated code goes into an overlay (loaded last, with override) next to the DB instead.
  signupCode = generateSignupCode();
  overlay = path.join('server', 'data', 'share.env');
  fs.mkdirSync(path.dirname(overlay), { recursive: true });
  fs.writeFileSync(overlay, `${fs.readFileSync('.env.share', 'utf8')}\nSIGNUP_CODE=${signupCode}\n`);
}

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
  env: { ...process.env, ENV_OVERLAY: overlay },
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

// Fail closed: never open the tunnel unless the server really demands the code (an ENV_OVERLAY line
// in .env, for example, would make it skip the overlay that carries SIGNUP_CODE).
const options = await fetch(`${LOCAL}/api/auth/signup-options`)
  .then((r) => r.json())
  .catch(() => null);
if (options?.signup_code_required !== true) {
  console.error('[share] 서버가 입장코드를 요구하지 않아 외부 공개를 중단합니다. .env 의 ENV_OVERLAY/SIGNUP_CODE 를 확인해 주세요.');
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
    console.log(
      [
        '',
        line,
        `  외부 접속 주소: ${match[0]}`,
        `  입장코드(회원가입): ${signupCode}`,
        `  가입 링크(코드 포함): ${match[0]}/register?code=${encodeURIComponent(signupCode)}`,
        `  이 PC: ${LOCAL}`,
        '  이미 가입한 사람은 코드 없이 로그인합니다.',
        '  종료: Ctrl+C (주소는 실행할 때마다 바뀝니다)',
        line,
        '',
      ].join('\n'),
    );
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

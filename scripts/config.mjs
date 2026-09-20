// chatgpt-web · 机器级绑定（用哪个浏览器 + 哪个已登录的 Chrome profile）
//
// 为什么必须有这一层（都有实测依据，见 REVIEW.md）：
//   1) ChatGPT 登录态**无法程序化迁移**：Chrome 127+ 的 cookie 是 app-bound 加密，
//      解密迁入新 profile 后登录态依然不生效（本仓库 macOS 端 48 个 cookie 实测失败）。
//   2) 同一账号在多处重复登录容易触发风控，所以正确做法是**复用用户已有的登录 profile**，
//      而不是每次都新建一个 profile 让用户重新登录。
//   3) 运行中的 Chrome 无法事后开启 CDP；同一个 user-data-dir 被占用时，再启动一个 chrome.exe
//      只会把请求交给已有实例 —— 拿不到调试端口。所以"用哪个 profile"必须是显式绑定，不能靠猜。
//
// 放在哪里：`~/.chatgpt-web/config.json`
//   - 机器专属，**不在 skill 仓库内** → 不进 git，也不会被 skill 重新安装 / git pull 覆盖；
//   - 所有宿主（dsh / claude / codex / trae）共用同一份绑定，因为一台机器只有一个"已登录的浏览器"。
//
// 优先级：环境变量 > config.json > skill 默认值。
// skill 默认值只给端口与实例名 —— **绝不给浏览器与 profile 路径**：
// 猜错 profile 的代价是让用户重复登录、甚至触发风控，这比报错严重得多。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_FILE = process.env.CHATGPT_CONFIG
  || path.join(os.homedir(), '.chatgpt-web', 'config.json');

// 绑定键 → 环境变量名（环境变量优先级最高，便于临时覆盖与 CI）
export const BINDING_ENV = {
  browserPath: 'CHATGPT_CHROME',
  userDataDir: 'CHATGPT_PROFILE',
  profileDirectory: 'CHATGPT_PROFILE_DIRECTORY',
  cdpPort: 'CHATGPT_CDP_PORT',
  agent: 'CHATGPT_AGENT',
};

export const BINDING_HINT = {
  browserPath: '浏览器可执行文件绝对路径，如 C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  userDataDir: '**已经登录过 ChatGPT** 的 Chrome user-data-dir，如 D:\\ChromeProfiles\\GPT',
  profileDirectory: 'user-data-dir 内的 Chrome profile 名（Default / Profile 1 …），不填就是 Default',
  cdpPort: '调试端口，默认 9444（多实例时按 agent 名偏移）',
  agent: '实例名：不同宿主用它隔离 profile 目录名/端口/锁文件',
};

export function readConfig(file = CONFIG_FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { file, data: {}, exists: true, error: 'config 必须是 JSON 对象' };
    }
    return { file, data, exists: true, error: null };
  } catch (e) {
    if (e.code === 'ENOENT') return { file, data: {}, exists: false, error: null };
    return { file, data: {}, exists: true, error: e.message };
  }
}

export function writeConfig(patch, file = CONFIG_FILE) {
  const cur = readConfig(file);
  if (cur.error) throw new Error(`现有 config 解析失败，先修好它再写入：${file}（${cur.error}）`);
  const next = { ...cur.data, ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return { file, data: next };
}

// 宿主级实例名：`<skill>/.env.agent`（由 install.sh / install.mjs 的 --agent 写入）。
// 只影响 AGENT（→ profile 目录名 / 端口 / 锁的隔离），不参与"用哪个浏览器与 profile"的绑定；
// 放 skill 目录是因为每个宿主有自己的 skill 目录，写进机器级 config 会互相覆盖。
export function readHostAgent(skillDir) {
  try {
    const txt = fs.readFileSync(path.join(skillDir, '.env.agent'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*CHATGPT_AGENT\s*=\s*(.+?)\s*$/);
      if (m) return m[1];
    }
  } catch { /* 没有这个文件是正常情况 */ }
  return null;
}

export function resolveBinding({ env = process.env, file = CONFIG_FILE, skillDir = null } = {}) {
  const cfg = readConfig(file);
  const keys = {};
  const sources = {};
  for (const [key, envKey] of Object.entries(BINDING_ENV)) {
    const e = env[envKey];
    if (e !== undefined && e !== '') { keys[key] = e; sources[key] = `env:${envKey}`; continue; }
    if (key === 'agent' && skillDir) {
      const host = readHostAgent(skillDir);
      if (host) { keys[key] = host; sources[key] = '.env.agent'; continue; }
    }
    const c = cfg.data[key];
    if (c !== undefined && c !== null && c !== '') { keys[key] = c; sources[key] = 'config'; continue; }
    keys[key] = undefined;
    sources[key] = 'default';
  }
  return {
    file: cfg.file, fileExists: cfg.exists, fileError: cfg.error, keys, sources,
  };
}

// 给 doctor / config 用的可读摘要：只暴露"实际会用什么"，并标注来源
export function describeBinding(binding) {
  const { keys, sources } = binding;
  return Object.keys(BINDING_ENV).map((k) => ({
    key: k,
    value: keys[k] ?? null,
    source: sources[k],
    hint: BINDING_HINT[k],
  }));
}

// ---------- profile 探测（只为"帮用户认出哪个 profile 登录过 GPT"）----------
// 只读扫描 Cookies 文件里的**域名**（SQLite 里 host_key 是明文，值才是加密的），
// 不解密、不导出、不保存任何凭证 —— 判断依据只有"有没有 chatgpt.com 这个域"。
function cookieFileIn(dir) {
  for (const rel of ['Network/Cookies', 'Cookies']) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function defaultUserDataDirs({ env = process.env } = {}) {
  const out = [];
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    out.push(path.join(env.LOCALAPPDATA, 'Google/Chrome/User Data'));
    out.push(path.join(env.LOCALAPPDATA, 'Microsoft/Edge/User Data'));
  }
  if (process.platform === 'darwin') {
    out.push(path.join(os.homedir(), 'Library/Application Support/Google/Chrome'));
  }
  if (process.platform === 'linux') {
    out.push(path.join(os.homedir(), '.config/google-chrome'));
    out.push(path.join(os.homedir(), '.config/chromium'));
  }
  return out;
}

export function listProfilesIn(userDataDir) {
  const out = [];
  const own = cookieFileIn(userDataDir);
  if (own) out.push({ userDataDir, profileDirectory: null, cookies: own });
  let subs = [];
  try {
    subs = fs.readdirSync(userDataDir, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return out; }
  for (const s of subs) {
    const dir = path.join(userDataDir, s);
    const c = cookieFileIn(dir);
    if (c) out.push({ userDataDir, profileDirectory: s, cookies: c });
  }
  return out;
}

export function cookieHasDomain(cookiesPath, domain = 'chatgpt.com') {
  try { return fs.readFileSync(cookiesPath).includes(Buffer.from(domain)); } catch { return null; }
}

// Chrome 136+ 拒绝用**默认** user-data-dir 开远程调试端口，绑到它等于绑一个永远连不上的目录。
export function isDefaultUserDataDir(userDataDir, { env = process.env } = {}) {
  if (!userDataDir) return false;
  const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
  return defaultUserDataDirs({ env }).some((d) => norm(d) === norm(userDataDir));
}

// 不依赖"打开被占用的文件"的痕迹 —— Chrome 运行时会独占 Cookies，
// 但 IndexedDB 目录名与 Local Storage 内容里都有明文 origin（2026-09-20 实测）。
function lockFreeTrace(profileDir) {
  try {
    const idb = path.join(profileDir, 'IndexedDB');
    for (const d of fs.readdirSync(idb)) {
      if (/chatgpt\.com/i.test(d)) return path.join(idb, d);
    }
  } catch { /* 没有就算了 */ }
  try {
    const ls = path.join(profileDir, 'Local Storage', 'leveldb');
    for (const f of fs.readdirSync(ls)) {
      const p = path.join(ls, f);
      try {
        if (fs.statSync(p).size <= 8 * 1024 * 1024 && fs.readFileSync(p).includes(Buffer.from('chatgpt.com'))) return p;
      } catch { /* 单个文件读不了就跳过 */ }
    }
  } catch { /* 没有就算了 */ }
  return null;
}

// 这个 profile 里有没有 ChatGPT 的使用痕迹？
// value: true / false / null（null = 读不到、无法判断，**不许**当成 false）
export function profileHasChatgpt(profileDir) {
  const cookies = cookieFileIn(profileDir);
  if (cookies) {
    const v = cookieHasDomain(cookies);
    if (v === true) return { value: true, evidence: cookies, cookiesLocked: false };
    const trace = lockFreeTrace(profileDir);
    if (v === false) {
      return trace
        ? { value: true, evidence: trace, cookiesLocked: false }
        : { value: false, evidence: cookies, cookiesLocked: false };
    }
    // Cookies 读不了（Chrome 正在用）→ 用无锁痕迹判断
    return trace
      ? { value: true, evidence: trace, cookiesLocked: true }
      : { value: null, evidence: null, cookiesLocked: true };
  }
  const trace = lockFreeTrace(profileDir);
  return trace
    ? { value: true, evidence: trace, cookiesLocked: false }
    : { value: null, evidence: null, cookiesLocked: false };
}

// extraDirs 通常来自"当前正在运行的浏览器进程的 --user-data-dir"——
// 用户日常那个开着 ChatGPT 的 Chrome 往往就在里面。
export function detectProfiles({ extraDirs = [], env = process.env } = {}) {
  const roots = [...new Set([...extraDirs, ...defaultUserDataDirs({ env })].filter(Boolean))];
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const p of listProfilesIn(root)) {
      const key = `${path.resolve(p.userDataDir).toLowerCase()}#${(p.profileDirectory || '').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dir = p.profileDirectory ? path.join(p.userDataDir, p.profileDirectory) : p.userDataDir;
      const has = profileHasChatgpt(dir);
      out.push({
        ...p,
        chatgptTrace: has.value,
        chatgptEvidence: has.evidence,
        cookiesLocked: has.cookiesLocked,
        defaultUserDataDir: isDefaultUserDataDir(p.userDataDir, { env }),
      });
    }
  }
  return out;
}

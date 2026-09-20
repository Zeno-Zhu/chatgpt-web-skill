// chatgpt-web · 生图任务：一张图 = 一个标签页（窗口）
//
// 设计依据全部来自 2026-09-20 Windows 实机取证（见 REVIEW.md）：
//   1) 生图**进行中**的后台标签页里，图片不会出现在 DOM 里：assistant 轮次是空的
//      （`conversation-turn-2` 内只有"编辑" + 空 div），只有 `image-gen-overlay-*` 空壳节点。
//      → 抓 DOM 会得到 0 张图，**不能**用 DOM 判"生完没"。
//   2) 可靠来源是 ChatGPT 自己的会话 JSON：`/backend-api/conversation/<id>`，
//      里面是 `image_asset_pointer`（`sediment://file_xxx`，带 mime/size/width/height）。
//   3) `/backend-api/*` 需要应用内 access token（`/api/auth/session` → `accessToken`）；
//      只用 cookie 会 404 `conversation_inaccessible`。
//   4) 下载链路：`/backend-api/files/<fileId>/download` → JSON `download_url` → GET 得 image/png 字节
//      （实测 791638 B，PNG 魔数 89504e470d0a1a0a）。
//
// 凭证纪律（与 SKILL.md 一致）：accessToken 只在内存里用于本次请求，**绝不打印、绝不落盘、绝不返回给上层**。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SELECTORS } from './compose.mjs';

export const STATE_DIR = path.join(os.homedir(), '.chatgpt-web');
export const JOB_FILE = path.join(STATE_DIR, 'image-jobs.json');
export const DEFAULT_MAX_IN_FLIGHT = 10;
const KEEP_DAYS = 14;

// ---------- 任务账本（机器状态，不在仓库里）----------
export function loadJobs() {
  try {
    const j = JSON.parse(fs.readFileSync(JOB_FILE, 'utf8'));
    return Array.isArray(j.jobs) ? j : { jobs: [] };
  } catch { return { jobs: [] }; }
}

export function saveJobs(store) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  store.jobs = (store.jobs || [])
    .filter((j) => !j.createdAt || Date.parse(j.createdAt) > cutoff)
    .slice(-200);
  fs.writeFileSync(JOB_FILE, `${JSON.stringify(store, null, 2)}\n`);
}

export const ACTIVE_STATES = new Set(['pending', 'generating']);
export const inFlight = (store) => (store.jobs || []).filter((j) => ACTIVE_STATES.has(j.state));
export const findJob = (store, id) => (store.jobs || []).find((j) => j.jobId === id || j.conversationId === id) || null;

export function newJobId(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `img-${stamp}-${rand}`;
}

// 生图任务账本：**一个任务 = 一个 GPT 会话（新聊天窗口）**，不是浏览器标签页。
// 会话 URL 一稳定就记下来；图片靠会话 id 从后端取（不依赖当前标签页停在哪个会话——
// 实测后台/切走后的会话里 DOM 根本不渲染图片，见文件顶部说明）。

// ---------- 后端会话 JSON（图片的权威来源）----------
async function accessToken(page) {
  const r = await page.request.get('https://chatgpt.com/api/auth/session');
  if (!r.ok()) throw new Error(`session-http-${r.status()}`);
  const j = await r.json();
  if (!j.accessToken) throw new Error('no-access-token');
  return j.accessToken;
}

export async function fetchConversation(page, conversationId) {
  const token = await accessToken(page);
  const r = await page.request.get(
    `https://chatgpt.com/backend-api/conversation/${conversationId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (r.status() === 404) return { ok: false, error: 'conversation_inaccessible', httpStatus: 404 };
  if (!r.ok()) return { ok: false, error: `http-${r.status()}`, httpStatus: r.status() };
  return { ok: true, json: await r.json() };
}

// 递归收集 image_asset_pointer（content.parts 里可能是对象，也可能嵌在 metadata 里）
export function extractImageAssets(conv) {
  const found = new Map();
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node !== 'object') return;
    if (node.content_type === 'image_asset_pointer' && node.asset_pointer) {
      const pointer = String(node.asset_pointer);
      const fileId = pointer.includes('://') ? pointer.split('://')[1] : pointer;
      if (!found.has(fileId)) {
        found.set(fileId, {
          fileId, pointer,
          scheme: pointer.includes('://') ? pointer.split('://')[0] : null,
          mimeType: node.mime_type || null,
          sizeBytes: node.size_bytes ?? null,
          width: node.width ?? null,
          height: node.height ?? null,
        });
      }
    }
    for (const v of Object.values(node)) visit(v);
  };
  for (const n of Object.values(conv?.mapping || {})) visit(n?.message?.content);
  return [...found.values()];
}

// 会话里的纯文本回复（用于区分"模型回了文字/拒绝"与"还在生成"）
export function assistantTexts(conv) {
  const out = [];
  for (const n of Object.values(conv?.mapping || {})) {
    const m = n?.message;
    if (!m) continue;
    const role = m.author?.role;
    if (role !== 'assistant' && role !== 'tool') continue;
    const parts = m.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) if (typeof p === 'string' && p.trim()) out.push(p.trim());
  }
  return out;
}

// 任务状态：ready（有图）/ text_only（模型只回了文字）/ generating / failed / unknown
export async function jobStatus(page, job) {
  const res = await fetchConversation(page, job.conversationId);
  if (!res.ok) return { state: res.error === 'conversation_inaccessible' ? 'failed' : 'unknown', error: res.error };
  const assets = extractImageAssets(res.json);
  if (assets.length) return { state: 'ready', images: assets.length, assets, title: res.json.title || null };
  const texts = assistantTexts(res.json);
  const errored = texts.some((t) => /(生成.*(失败|出错)|failed to generate|can't generate|cannot generate|无法生成)/i.test(t));
  if (errored) return { state: 'failed', error: 'generation-failed', lastText: texts.slice(-1)[0]?.slice(0, 300) || null };
  if (texts.length) return { state: 'text_only', lastText: texts.slice(-1)[0]?.slice(0, 300) || null, title: res.json.title || null };
  return { state: 'generating', images: 0, title: res.json.title || null };
}

// ---------- 下载 ----------
function safeName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function extFromMime(mime) {
  if (!mime) return 'png';
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'png';
}

const MAGIC = [
  { ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] },
  { ext: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
];
export function sniffImage(buf) {
  for (const m of MAGIC) if (m.bytes.every((b, i) => buf[i] === b)) return m.ext;
  return null;
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// 一张图 → 一个文件（含字节数/魔数/SHA-256 记录，便于跨路径对比与复现）
function writeImageFile(jobDir, index, buf, meta = {}) {
  const sniffed = sniffImage(buf);
  if (!sniffed) return { error: 'not-an-image', bytes: buf.length };
  const base = safeName(meta.servedName ? path.basename(meta.servedName, path.extname(meta.servedName)) : '') || `${meta.fallbackName || 'image'}-${index + 1}`;
  const file = path.join(jobDir, `${index + 1}-${base}.${sniffed}`);
  fs.writeFileSync(file, buf);
  return {
    file, fileId: meta.fileId || null, bytes: buf.length, format: sniffed,
    sha256: sha256(buf), mode: meta.mode || null,
    mimeType: meta.mimeType || null, width: meta.width ?? null, height: meta.height ?? null,
    servedName: meta.servedName || null,
    verified: meta.sizeBytes ? buf.length === meta.sizeBytes : null,
  };
}

// 一张图 → 一个文件（同一任务的多张图按 1/2/3 编号，各自独立落盘）
export async function downloadAssets(page, job, assets, outDir) {
  const token = await accessToken(page);
  const jobDir = path.join(outDir, job.jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const saved = [];
  const errors = [];
  for (const [i, a] of assets.entries()) {
    try {
      const dl = await page.request.get(
        `https://chatgpt.com/backend-api/files/${a.fileId}/download`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!dl.ok()) { errors.push({ fileId: a.fileId, error: `files-download-${dl.status()}`, mode: 'api' }); continue; }
      const meta = await dl.json();
      if (!meta.download_url) { errors.push({ fileId: a.fileId, error: 'DOWNLOAD_URL_FAILED', mode: 'api' }); continue; }
      const bin = await page.request.get(meta.download_url, { headers: { Authorization: `Bearer ${token}` } });
      if (!bin.ok()) { errors.push({ fileId: a.fileId, error: `content-${bin.status()}`, mode: 'api' }); continue; }
      // 服务端 fn= 参数就是 GPT 给的图片名字（实测是中文描述），保留它更可读
      let served = '';
      try { served = decodeURIComponent(new URL(meta.download_url).searchParams.get('fn') || ''); } catch { /* ignore */ }
      const rec = writeImageFile(jobDir, i, await bin.body(), {
        fileId: a.fileId, mimeType: a.mimeType, width: a.width, height: a.height,
        sizeBytes: a.sizeBytes, servedName: served, mode: 'api', fallbackName: job.conversationId,
      });
      if (rec.error) { errors.push({ fileId: a.fileId, error: rec.error, bytes: rec.bytes, mode: 'api' }); continue; }
      saved.push(rec);
    } catch (e) {
      errors.push({ fileId: a.fileId, error: e.message.slice(0, 160), mode: 'api' });
    }
  }
  const meta = {
    jobId: job.jobId, conversationId: job.conversationId, url: job.url, mode: 'api',
    promptChars: job.promptChars ?? null, promptFile: job.promptFile ?? null,
    downloadedAt: new Date().toISOString(), count: saved.length, files: saved, errors,
  };
  fs.writeFileSync(path.join(jobDir, 'images.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return { jobDir, saved, errors, manifest: path.join(jobDir, 'images.json') };
}

// ---------- 兜底路径 1：DOM（前台渲染出的 estuary URL + 浏览器自己的 cookie）----------
// 实测（2026-09-20）：同一个 estuary URL 用 cookie 取、用 Bearer 取、走 /files/<id>/download 取，
// 三条路字节与 SHA-256 **完全相同**。代价：必须前台渲染，且冷加载要轮询最多 ~25s 才出现 <img>。
export async function downloadAssetsViaDom(page, job, assets, outDir, { timeoutMs = 60000 } = {}) {
  const jobDir = path.join(outDir, job.jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const saved = [];
  const errors = [];
  await page.bringToFront();
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (const [i, a] of assets.entries()) {
    let src = null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !src) {
      src = await page.evaluate((fid) => {
        const n = [...document.querySelectorAll('img')]
          .find((x) => (x.currentSrc || x.src || '').includes(fid));
        return n ? (n.currentSrc || n.src) : null;
      }, a.fileId).catch(() => null);
      if (!src) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!src) { errors.push({ fileId: a.fileId, error: 'IMAGE_ASSET_NOT_FOUND', mode: 'dom' }); continue; }
    try {
      const res = await page.request.get(src);            // 浏览器自己就是这么加载的 → 不带 token
      if (!res.ok()) { errors.push({ fileId: a.fileId, error: `content-${res.status()}`, mode: 'dom' }); continue; }
      let served = '';
      try { served = decodeURIComponent(new URL(src).searchParams.get('fn') || ''); } catch { /* ignore */ }
      const rec = writeImageFile(jobDir, i, await res.body(), {
        fileId: a.fileId, mimeType: a.mimeType, width: a.width, height: a.height,
        sizeBytes: a.sizeBytes, servedName: served, mode: 'dom', fallbackName: job.conversationId,
      });
      if (rec.error) { errors.push({ fileId: a.fileId, error: rec.error, bytes: rec.bytes, mode: 'dom' }); continue; }
      saved.push(rec);
    } catch (e) {
      errors.push({ fileId: a.fileId, error: e.message.slice(0, 160), mode: 'dom' });
    }
  }
  const meta = {
    jobId: job.jobId, conversationId: job.conversationId, url: job.url, mode: 'dom',
    downloadedAt: new Date().toISOString(), count: saved.length, files: saved, errors,
  };
  fs.writeFileSync(path.join(jobDir, 'images.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return { jobDir, saved, errors, manifest: path.join(jobDir, 'images.json') };
}

// ---------- 兜底路径 2：原生点击下载按钮 ----------
// 必须先监听 download 事件再点击（Playwright 官方推荐模式），并要求前台 + 独占浏览器。
// 当前 UI 没有图片下载按钮 → 如实返回 NATIVE_ACTION_UNAVAILABLE（不是 bug，是 UI 现状）。
export async function downloadAssetsViaNative(page, job, assets, outDir, { timeoutMs = 20000 } = {}) {
  const jobDir = path.join(outDir, job.jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const saved = [];
  const errors = [];
  await page.bringToFront();
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const btn = page.locator(SELECTORS.imageDownloadButton).first();
  if (!(await btn.count())) {
    for (const a of assets) {
      errors.push({
        fileId: a.fileId, error: 'NATIVE_ACTION_UNAVAILABLE', mode: 'native',
        hint: '当前网页版 UI 没有"图片下载"按钮（overlay 只有 编辑图片 / 分享此图片）。用 --mode api 或 --mode dom。',
      });
    }
    return { jobDir, saved, errors, manifest: null };
  }
  for (const [i, a] of assets.entries()) {
    try {
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: timeoutMs }),
        btn.click({ force: true }),
      ]);
      const target = path.join(jobDir, `${i + 1}-${safeName(dl.suggestedFilename()) || `${job.conversationId}-${i + 1}`}`);
      await dl.saveAs(target);
      const buf = fs.readFileSync(target);
      const rec = {
        file: target, fileId: a.fileId, bytes: buf.length, format: sniffImage(buf),
        sha256: sha256(buf), mode: 'native', servedName: dl.suggestedFilename(),
        mimeType: a.mimeType, width: a.width, height: a.height,
        verified: a.sizeBytes ? buf.length === a.sizeBytes : null,
      };
      if (!rec.format) { errors.push({ fileId: a.fileId, error: 'not-an-image', mode: 'native' }); continue; }
      saved.push(rec);
    } catch (e) {
      errors.push({ fileId: a.fileId, error: /Timeout/.test(e.message) ? 'DOWNLOAD_EVENT_TIMEOUT' : e.message.slice(0, 160), mode: 'native' });
    }
  }
  const meta = {
    jobId: job.jobId, conversationId: job.conversationId, url: job.url, mode: 'native',
    downloadedAt: new Date().toISOString(), count: saved.length, files: saved, errors,
  };
  fs.writeFileSync(path.join(jobDir, 'images.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return { jobDir, saved, errors, manifest: path.join(jobDir, 'images.json') };
}

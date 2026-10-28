// 新东西:官方发布的新功能。agentic 没有传统升级 —— 不推代码、不覆盖用户的应用,只发一条说明。
// 用户要了,agent 照着说明(和参考源码)在自己身上加;不要就跳过,不再提。
//
// 发布源是仓库里的 news/index.json:
//   { "items": [{ "id", "date", "title", "summary", "guide" }] }
//   guide 是写给 agent 的实现说明(相对 index.json 的路径),里面指向参考源码。
//
// 本机状态在 launcher/news.json:{ checkedAt, items: [...], status: { id: 'new' | 'added' | 'skipped' | 'included' } }
//   included:出厂就带着(seed 的 package.json 里 agentic.news 列出的),不用提
// 还没处理的(new)同时写一份到 workspace/.agentic/news.json,应用每轮读它,agent 就知道有新东西。
import fs from 'node:fs';
import path from 'node:path';

export const NEWS_URL = process.env.AGENTIC_NEWS_URL || 'https://raw.githubusercontent.com/yanglongyun/agentic/main/news/index.json';
export const CHECK_MS = 6 * 60 * 60_000;
const STATUSES = ['new', 'added', 'skipped', 'included'];

export function readNews(file) {
    try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { checkedAt: value.checkedAt || null, items: Array.isArray(value.items) ? value.items : [], status: value.status || {} };
    } catch { return { checkedAt: null, items: [], status: {} }; }
}

function writeNews(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(tmp, file);
}

const noticeFile = (workspace) => path.join(workspace, '.agentic', 'news.json');

/** 还没处理的新东西。 */
export function pendingNews(file) {
    const news = readNews(file);
    return news.items.filter((item) => news.status[item.id] === 'new');
}

/** 把还没处理的写进 workspace,没有就删掉。 */
export function writeNotice(file, workspace) {
    const pending = pendingNews(file);
    if (!pending.length) { fs.rmSync(noticeFile(workspace), { force: true }); return; }
    fs.mkdirSync(path.dirname(noticeFile(workspace)), { recursive: true });
    fs.writeFileSync(noticeFile(workspace), `${JSON.stringify(pending, null, 2)}\n`);
}

/** 播种时调:出厂就带着的新东西记为 included。 */
export function baseline(file, seedDir) {
    let ids = [];
    try { ids = JSON.parse(fs.readFileSync(path.join(seedDir, 'package.json'), 'utf8')).agentic?.news || []; } catch { /* 没写就没有 */ }
    const news = readNews(file);
    for (const id of ids) news.status[id] = 'included';
    writeNews(file, news);
}

function validItem(item) {
    return item && typeof item.id === 'string' && /^[\w.-]{1,80}$/.test(item.id)
        && typeof item.title === 'string' && item.title;
}

/** 拉一次发布源。返回这次新出现的条目。拉不到就抛错,状态不动。 */
export async function check(file, { url = NEWS_URL, fetchImpl = fetch } = {}) {
    const response = await fetchImpl(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`拉取新东西失败:${response.status}`);
    const body = await response.json();
    const items = (Array.isArray(body?.items) ? body.items : []).filter(validItem).map((item) => ({
        id: item.id,
        date: String(item.date || ''),
        title: String(item.title).slice(0, 200),
        summary: String(item.summary || '').slice(0, 2000),
        guide: typeof item.guide === 'string' ? item.guide : '',
    }));
    const news = readNews(file);
    const fresh = [];
    for (const item of items) {
        if (!news.status[item.id]) { news.status[item.id] = 'new'; fresh.push(item); }
    }
    news.items = items;
    news.checkedAt = new Date().toISOString();
    writeNews(file, news);
    return fresh;
}

/** 记下用户的决定:added(加上了)或 skipped(不要)。 */
export function mark(file, id, status) {
    if (!STATUSES.includes(status) || status === 'included') throw new Error('status 只能是 new、added 或 skipped');
    const news = readNews(file);
    if (!news.items.some((item) => item.id === id)) throw new Error(`没有这条新东西:${id}`);
    news.status[id] = status;
    writeNews(file, news);
}

/** 实现说明的地址:guide 相对发布源。 */
export function guideUrl(item, url = NEWS_URL) {
    return new URL(item.guide || `${item.id}.md`, url).href;
}

// launcher 的核心:一次启动的全过程。纯 Node,不 import Electron;窗口这些交给宿主(shell)。
//
//   1. 找到应用(workspace),第一次就从出厂 seed 播一份;之后 workspace 归用户,不再覆盖
//   2. 记账:启动前快照,连续起不来就回滚到 good —— 这是唯一的兜底
//   3. 把应用拉起成子进程(child.js 加载 workspace/main.js),等它报到 agentic.ready({ url })
//
// 应用跑在自己的进程里:它卡死、崩溃都拖不垮 launcher 和窗口;起不来由 launcher 记账回滚,
// 报到之后崩了由 launcher 重新拉起。应用通过 globalThis.agentic(child.js 装的)和 launcher 说话。
//
// 跟环境有关的事交给宿主(host):
//   host.whenReady()          宿主准备好了(Electron 的 app.whenReady)
//   host.openSurface(url, w)  打开应用界面(w 是窗口偏好),界面真的加载出来才 resolve
//   host.reloadSurfaces()     重载应用界面
//   host.relaunch()           整个进程重启
//   host.fatal(message)       连稳定版本都起不来:告诉用户,没有别的办法了
//
// 应用能叫 launcher 做的事(agentic.call(name, args)):launcher 自己的(restart / reload / history.* / news.* / browser.*)加上宿主给的 capabilities。
// 报到之后定时拉一次「新东西」(news.js),有新的就发 news 事件给应用。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import * as guardian from './guardian.js';
import * as seed from './seed.js';
import * as snap from './snapshot.js';
import * as news from './news.js';
import { writeShims } from './shims.js';
import { startControl } from './control.js';
import { startBrowser } from './browser.js';

/** 契约版本:CONTRACT.md 里的能力对应的版本号,launcher 加了新能力就升。应用在 package.json 的 agentic.contract 里写它需要的最低版本。 */
export const CONTRACT_VERSION = 1;
const READY_TIMEOUT_MS = Number(process.env.AGENTIC_READY_TIMEOUT_MS) || 120_000;
const EXIT_TIMEOUT_MS = 5_000;
const CHILD = path.join(import.meta.dirname, 'child.js');

export function createLog(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stream = fs.createWriteStream(file, { flags: 'a' });
    return (...parts) => {
        const line = `[launcher ${new Date().toISOString()}] ${parts.map((p) => (p instanceof Error ? p.stack : String(p))).join(' ')}`;
        console.log(line);
        stream.write(`${line}\n`);
    };
}

/**
 * opts: { host, paths, seedDir, version, contract, toolchain, execPath, cliPath, log, capabilities }
 * 返回 { start(), shutdown({ restarting }), state(), emit(name, data) }
 */
export function createLauncher({ host, paths, seedDir, version, contract, toolchain, execPath, cliPath, log, capabilities = {} }) {
    let readyTimer = null;
    let promoteTimer = null;
    let state = 'starting';   // starting → running → opening → ready | failed
    let child = null;
    let childExited = null;   // 子进程退出的 Promise
    let promoted = false;
    let closing = false;
    let browser = null;
    let newsTimer = null;

    /** launcher 自己的能力;宿主和能力层的放在 capabilities 里,同名时这里的优先。 */
    const builtin = {
        restart: async () => { setTimeout(restart, 300); return { ok: true, message: '马上重启' }; },
        reload: async () => { await host.reloadSurfaces(); return { ok: true, message: '窗口已重载' }; },
        /** 改动记录:应用的版本史,good 标出来。 */
        'history.list': async ({ limit = 50 } = {}) => {
            const good = await snap.resolve(paths.workspace, 'refs/tags/good');
            const entries = await snap.log(paths.workspace, Math.min(Math.max(Number(limit) || 50, 1), 200));
            return { entries: entries.map((entry) => ({ ...entry, good: entry.oid === good })) };
        },
        /** 退回到某个版本:当前样子留成 before-rollback-* 分支,然后重启。 */
        'history.rollback': async ({ oid } = {}) => {
            const target = typeof oid === 'string' ? await snap.resolve(paths.workspace, oid) : null;
            if (!target) throw new Error(`找不到版本:${oid}`);
            const saveAs = `before-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}`;
            await snap.resetHard(paths.workspace, target, { saveAs });
            log(`退回到 ${target.slice(0, 8)},原来的样子留在 ${saveAs}`);
            setTimeout(restart, 300);
            return { ok: true, oid: target, branch: saveAs };
        },
        'news.list': async () => {
            const state = news.readNews(paths.news);
            return { checkedAt: state.checkedAt, items: state.items.map((item) => ({ ...item, status: state.status[item.id] || 'new' })) };
        },
        'news.mark': async ({ id, status } = {}) => {
            news.mark(paths.news, String(id), status);
            news.writeNotice(paths.news, paths.workspace);
            return { ok: true };
        },
        'news.check': async () => {
            const fresh = await news.check(paths.news);
            news.writeNotice(paths.news, paths.workspace);
            if (fresh.length) emit('news', { items: fresh });
            return { items: fresh };
        },
    };

    /** 推一个事件给应用(快捷键按下、窗口关闭……)。应用没在跑就丢掉。 */
    function emit(name, data) {
        if (child?.connected) child.send({ type: 'event', name, data });
    }

    /** launcher 的一项能力。应用经 IPC 调,宿主和测试也能直接调。 */
    function call(name, args = {}) {
        const fn = builtin[name] || browser?.capabilities[name] || capabilities[name];
        if (!fn) return Promise.reject(new Error(`launcher 没有这个能力:${name}`));
        return Promise.resolve(fn(args));
    }

    async function handleCall(id, name, args) {
        let reply;
        try { reply = { type: 'result', id, value: await call(name, args || {}) }; }
        catch (error) { reply = { type: 'result', id, error: { message: String(error?.message || error), stack: error?.stack ? String(error.stack).slice(0, 4000) : undefined } }; }
        if (child?.connected) child.send(reply);
    }

    function onReady(info) {
        if (state !== 'running') return;
        if (!info?.url) { void fail(new Error('ready() 要带上界面地址 { url }')); return; }
        state = 'opening';
        Promise.resolve(host.openSurface(info.url, info.window || {}))
            .then(() => markReady())
            .catch((error) => void fail(error));
    }

    function markReady() {
        if (state !== 'running' && state !== 'opening') return;
        state = 'ready';
        clearTimeout(readyTimer);
        guardian.markReady({ ledgerFile: paths.ledger });
        log('应用已报到');
        promoteTimer = setTimeout(() => {
            void guardian.promote({ workspace: paths.workspace, ledgerFile: paths.ledger })
                .then((oid) => { if (oid) { promoted = true; log(`稳定运行,${oid.slice(0, 8)} 成为 good`); } });
        }, guardian.HEALTHY_MS);
        promoteTimer.unref?.();
        startNews();
    }

    /** 报到后拉一次新东西,之后每隔几小时再拉。拉不到(没网)就等下一次,不打扰用户。 */
    function startNews() {
        if (newsTimer || process.env.AGENTIC_NEWS === 'off') return;
        const tick = () => void builtin['news.check']().catch((error) => log('新东西这次没拉到:', error.message));
        tick();
        newsTimer = setInterval(tick, news.CHECK_MS);
        newsTimer.unref?.();
    }

    /** 让应用进程收尾并退出;不肯退就杀。 */
    async function stopChild({ restarting }) {
        if (!child) return;
        const proc = child;
        if (proc.connected) proc.send({ type: 'shutdown', restarting });
        const killer = setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, EXIT_TIMEOUT_MS);
        await childExited;
        clearTimeout(killer);
    }

    async function shutdown({ restarting = false } = {}) {
        closing = true;
        clearTimeout(readyTimer);
        clearTimeout(promoteTimer);
        clearInterval(newsTimer);
        await stopChild({ restarting });
        browser?.close();
    }

    let restarting = false;
    async function restart() {
        if (restarting) return;
        restarting = true;
        log('重启');
        await shutdown({ restarting: true });
        await host.relaunch();
    }

    function giveUp(reason) {
        state = 'failed';
        log('起不来,也没有更早的稳定版本可回:', reason);
        return host.fatal(`agentic 起不来了。\n\n${String(reason?.stack || reason || '').slice(0, 1500)}\n\n日志:${paths.log}`);
    }

    async function fail(error) {
        if (state === 'failed' || closing) return;
        clearTimeout(readyTimer);
        clearTimeout(promoteTimer);
        log('应用没起来:', error);
        state = 'failed';
        guardian.markFailed({ ledgerFile: paths.ledger }, error);
        if (await guardian.willRecover({ workspace: paths.workspace, ledgerFile: paths.ledger })) await restart();
        else await giveUp(error);
    }

    /** 应用进程退出了。什么时候退的,决定怎么处理。 */
    async function onExit(code, signal) {
        const reason = new Error(`应用进程退出(${signal || code})`);
        if (closing) return;
        if (state !== 'ready') { await fail(reason); return; }
        // 报到过但还没稳定到成为 good:算这次启动失败,交给记账去决定要不要回滚
        if (!promoted) { state = 'running'; await fail(reason); return; }
        // 稳定版本自己崩了:不算起不来,拉起来就是
        log('应用崩了,重新拉起:', reason);
        await restart();
    }

    function spawnChild(entry, env) {
        const stdio = fs.openSync(paths.log, 'a');
        child = spawn(execPath, [CHILD, entry], {
            cwd: paths.workspace,
            env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['ignore', stdio, stdio, 'ipc'],
        });
        fs.closeSync(stdio);
        childExited = new Promise((resolve) => child.once('exit', resolve));
        child.on('message', (message) => {
            if (!message || typeof message !== 'object') return;
            if (message.type === 'ready') onReady(message.info);
            else if (message.type === 'failed') void fail(Object.assign(new Error(message.error?.message || '应用报告启动失败'), { stack: message.error?.stack }));
            else if (message.type === 'call') void handleCall(message.id, message.name, message.args);
        });
        child.on('error', (error) => void fail(error));
        child.on('exit', (code, signal) => void onExit(code, signal));
        log(`应用进程 ${child.pid} 已拉起`);
    }

    /** 应用要求的契约版本比 launcher 高,起不了:装的 agentic 太旧。 */
    function checkContract() {
        let required = 0;
        try { required = Number(JSON.parse(fs.readFileSync(path.join(paths.workspace, 'package.json'), 'utf8')).agentic?.contract) || 0; } catch { /* 没写就不要求 */ }
        if (required > CONTRACT_VERSION) throw new Error(`这个应用需要契约版本 ${required},当前 launcher 只到 ${CONTRACT_VERSION}:请升级 agentic`);
    }

    async function prepareWorkspace() {
        const planted = await seed.plant({ seedDir, workspace: paths.workspace, version });
        if (planted) {
            news.baseline(paths.news, seedDir);
            guardian.writeLedger(paths.ledger, { ...guardian.readLedger(paths.ledger), seedVersion: version });
            log(`播种 v${version} → ${planted.slice(0, 8)}`);
        }
        news.writeNotice(paths.news, paths.workspace);
    }

    async function start() {
        fs.mkdirSync(paths.state, { recursive: true });
        fs.mkdirSync(paths.data, { recursive: true });
        const env = {
            AGENTIC_HOME: paths.base,
            AGENTIC_WORKSPACE: paths.workspace,
            AGENTIC_DATA: paths.data,
            AGENTIC_SEED: seedDir,
            AGENTIC_VERSION: version,
            AGENTIC_CONTRACT: contract,
            AGENTIC_CONTRACT_VERSION: String(CONTRACT_VERSION),
            AGENTIC_BIN: paths.bin,
            AGENTIC_TOOLCHAIN: toolchain,
        };
        writeShims({ binDir: paths.bin, execPath, cliPath, env });
        // agentic 命令和应用的子进程都要这些
        Object.assign(process.env, env);

        browser = startBrowser({ address: paths.browser, emit, log });

        await startControl({
            file: paths.control,
            routes: {
                'POST /restart': () => builtin.restart(),
                'POST /reload': () => builtin.reload(),
                'GET /status': () => ({ ok: true, state, version, pid: child?.pid || null }),
                'POST /status': () => ({ ok: true, state, version, pid: child?.pid || null }),
            },
        });

        try {
            await prepareWorkspace();
            checkContract();
        } catch (error) {
            await host.whenReady();
            return giveUp(error);
        }

        const decision = await guardian.beginBoot({ workspace: paths.workspace, ledgerFile: paths.ledger });
        if (decision.rolledBack) log(`回滚:${decision.rolledBack.from?.slice(0, 8)} → ${decision.rolledBack.to.slice(0, 8)},原版本留在 ${decision.rolledBack.branch}`);

        await host.whenReady();
        if (decision.action === 'give-up') return giveUp(decision.reason);

        state = 'running';
        readyTimer = setTimeout(() => void fail(new Error(`应用 ${READY_TIMEOUT_MS / 1000} 秒内没有报到`)), READY_TIMEOUT_MS);
        readyTimer.unref?.();
        const entry = path.join(paths.workspace, 'main.js');
        log(`加载应用 ${decision.commit?.slice(0, 8)}:${entry}`);
        if (!fs.existsSync(entry)) { await fail(new Error(`应用入口不存在:${entry}`)); return undefined; }
        spawnChild(entry, env);
        return undefined;
    }

    return { start, shutdown, state: () => state, emit, call };
}

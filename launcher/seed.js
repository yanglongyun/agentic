// 播种:出厂的应用(seed,也就是仓库里的 app/ 目录)怎么进到用户的 workspace 里。
//
// 只在第一次运行时做:把 seed 整个拷进 workspace,git init,打 seed-v<版本> 与 good。
// 之后 workspace 就是用户自己的,装了新安装包也不覆盖;新东西走「新东西」通知(news.js),由 agent 按用户的意思自己加。
import fs from 'node:fs';
import path from 'node:path';
import * as snap from './snapshot.js';

/**
 * 永远不进 workspace 的东西:git 元数据、系统垃圾、依赖目录、运行态数据。
 * .data 是单独跑 server 时的数据目录(可能有 API Key),test 是出厂代码自己的测试。
 */
const SKIP = /^(\.data|test)([\\/]|$)|(^|[\\/])(\.git|\.DS_Store|node_modules|[^\\/]+\.db(-wal|-shm)?|[^\\/]+\.log)$/;

export const GITIGNORE = `# 由 launcher 写入,可以改。
.agentic/
node_modules
.DS_Store
*.log
`;

export function readSeedVersion(seedDir, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(seedDir, 'package.json'), 'utf8')).version || fallback; } catch { return fallback; }
}

function copySeed(seedDir, workspace) {
    fs.mkdirSync(workspace, { recursive: true });
    fs.cpSync(seedDir, workspace, {
        recursive: true,
        force: true,
        verbatimSymlinks: true,
        filter: (src) => !SKIP.test(path.relative(seedDir, src) || '.'),
    });
    fs.writeFileSync(path.join(workspace, '.gitignore'), GITIGNORE);
}

export async function plant({ seedDir, workspace, version }) {
    if (fs.existsSync(path.join(workspace, '.git'))) return null;
    copySeed(seedDir, workspace);
    await snap.ensureRepo(workspace);
    const oid = await snap.commitAll(workspace, `播种 v${version}`);
    await snap.tag(workspace, `seed-v${version}`, oid);
    await snap.tag(workspace, 'good', oid);
    return oid;
}

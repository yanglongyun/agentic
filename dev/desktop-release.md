# 桌面正式发布

开发包使用 `npm run app:dist`。正式包使用 `electron-builder.release.json`，输出到 `release/production/`。版本号来自根目录 `package.json`。

## macOS · Apple Silicon

需要 Apple Silicon Mac、Node.js 22.23.1 或更高版本、Chuan Zhi 团队的 Developer ID Application 证书，以及同一团队的 notarytool 钥匙串凭据。团队 ID 为 `92696T726U`。凭据仅保存在本机钥匙串。

```bash
npm ci
npm --prefix ui ci
APPLE_KEYCHAIN_PROFILE=你的钥匙串凭据名 npm run app:release
```

发布脚本检查 TypeScript，构建 UI，携带独立 Node.js，签名所有可执行内容（包括 Node），由 electron-builder 完成 `.app` 公证和票据装订，再生成 DMG 与 ZIP。随后单独签名、公证并装订 DMG，验证 Gatekeeper 和公证票据。任一步失败都不发布。

- `agentic-版本-mac-arm64.dmg`：网站主下载。
- `agentic-版本-mac-arm64.zip`：包含已经公证并装订的应用。
- 支持 macOS 13 及以上，Apple Silicon。
- 当前不发布自动更新清单；DMG 公证会改变文件内容，构建阶段的 blockmap 会被移除。

## Windows · x64

在 Windows 构建机的独立目录中放入当前源码，使用 x64 Node.js。不要复制 `.git`、依赖、运行数据、密钥、macOS 的 `desktop/runtime` 或其他发布产物。

```powershell
npm ci
npm --prefix ui ci
npm run app:release
```

输出 `agentic-版本-win-x64.exe`。NSIS 支持选择安装目录、当前用户安装和桌面快捷方式。当前没有配置 Windows 代码签名，发布页需如实说明。

构建机需要访问 Node.js 官方许可证和 Electron GitHub Releases。网络不可用时，可从官方源下载对应版本文件，核对 Electron 官方 `SHASUMS256.txt` 后传到构建机。使用 electron-builder 的 `--config.electronDist=下载文件路径` 指定经过校验的 Electron ZIP，不替换依赖版本。

## 校验、上传、部署

把 Windows 安装包取回 `release/production/`，与 macOS 的 DMG、ZIP 放在一起：

```bash
node desktop/checksums.js
```

脚本生成安装包目录和官网 `site/public/` 中的 `checksums.txt`。必须在 DMG 装订完成后生成校验值。

使用 Cloudflare 已登录账号上传至 R2。`CLOUDFLARE_ACCOUNT_ID` 在本机环境设置，`VERSION` 使用本次版本号：

```bash
VERSION=0.6.0
cd site
npm ci
npx wrangler r2 object put "iimos-releases/agentic/mac-arm64/agentic-$VERSION-mac-arm64.dmg" --file "../release/production/agentic-$VERSION-mac-arm64.dmg" --content-type application/x-apple-diskimage --remote
npx wrangler r2 object put "iimos-releases/agentic/mac-arm64/agentic-$VERSION-mac-arm64.zip" --file "../release/production/agentic-$VERSION-mac-arm64.zip" --content-type application/zip --remote
npx wrangler r2 object put "iimos-releases/agentic/win-x64/agentic-$VERSION-win-x64.exe" --file "../release/production/agentic-$VERSION-win-x64.exe" --content-type application/octet-stream --remote
```

新版本使用新文件名，不覆盖已发布安装包。验证公共下载文件与本地哈希一致后，再修改首页版本和下载链接并部署官网，详见 [site/README.md](../site/README.md)。不把本机 Cloudflare 配置、钥匙串凭据或构建机密码提交到仓库。

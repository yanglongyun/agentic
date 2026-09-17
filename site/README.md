# agentic 产品官网

产品定位：带浏览器的本地 AI Agent 客户端。展示本地执行、浏览器操作、远程对话，提供桌面客户端下载。

- 官网：<https://agentic.iimos.ai>
- Cloudflare Worker：`agentic-site`
- 安装包：R2 的 `iimos-releases` 桶，`agentic/` 前缀，对外使用 `https://r2.iimos.ai`
- 远程对话中继是另一个 Worker `agentic`，与官网独立。

`public/` 是直接发布的静态文件，HTML、CSS、JavaScript 分开维护，没有构建框架。首页工作区是交互示意，不包含用户数据。`social.svg` 是分享图源文件，导出到 `public/social.png`。

## 本地预览

```bash
cd site
npm ci
cp wrangler.example.jsonc wrangler.jsonc
# 填写自己的 account_id 和域名
npm run dev
```

`wrangler.jsonc`、`.env*` 和 `.dev.vars*` 都被忽略，只提交配置示例，不在静态目录保存任何密钥。

## 发布

先按照 [桌面发布说明](../dev/desktop-release.md) 生成、验证和上传安装包，再修改首页版本与下载链接，生成 `public/checksums.txt`，最后部署：

```bash
cd site
npm ci
npm run deploy
```

每次发布检查首页、404、手机布局、演示切换、下载文件大小和 SHA-256。官网下载链接只指向已经上传并验证的版本。

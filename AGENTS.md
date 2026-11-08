# AGENTS.md

## 构建与验证

- 改过 `web/src/` 后运行 `pnpm -F @osm/web build`。`http://127.0.0.1:8787` 通过 `server/src/index.ts` 的 `express.static(web/dist)` 提供页面，服务的是预构建包；只改源码不重建，浏览器里看不到改动。Vite dev（`:5174`）仅用于本地热更，不替代这一步。
- 改过 `server/src/` 后运行 `pnpm -F @osm/server build`，运行时入口是 `server/dist/index.js`。

## 提交

- 按逻辑拆分提交，提交完成后直接 push（长期约定）。

## 安全

- 不要把 `~/.qoder/settings.json`、`.qoder/mcp-router.json` 等含令牌/apiKey 的内容写进仓库文件或提交。

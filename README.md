# ASTI Local Monitor

本项目是 `https://adult-sex-type-indicator.netlify.app/` 的本地静态副本，并额外加入本机答题记录后台。

用于本人阴暗地视奸朋友(bushi

## Vercel 部署

Vercel 不适合直接运行本地的双端口 `server.js`，部署时会使用：

- `public/index.html`：测试页
- `public/monitor.html`：后台页，访问路径 `/monitor`
- `api/records.js`：记录接口
- Upstash Redis：云端持久化记录

### 需要的环境变量

在 Vercel 项目里添加：

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `MONITOR_PASSWORD`
- `MAX_RECORDS` 可选，默认 `1000`

`UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN` 可以在 Upstash Redis 数据库的 REST API 页面复制。

### 部署步骤

1. 把本目录推到 GitHub。
2. 在 Vercel 新建项目，选择这个 GitHub 仓库。
3. Framework Preset 选择 `Other`。
4. Build Command 留空或填 `npm install`。
5. Output Directory 留空。
6. 添加上面的环境变量。
7. Deploy。

部署后：

- 测试页：`https://~.vercel.app/`
- 后台页：`https://~.vercel.app/monitor`

后台输入 `MONITOR_PASSWORD` 才能读取或清空记录,朋友什么都不知道,十分之阴暗

当然也可以用来视奸其他的那个...好了不多说了

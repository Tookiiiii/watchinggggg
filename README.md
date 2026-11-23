# Watching — 通用静态测试/问卷托管与自动统计工具

将任意下载的静态测试或问卷网页直接丢进 `quizzes/` 目录，系统即可**自动发现并挂载路由**、**无侵入自动注入通用采集脚本**，在保持原测试页与最终结果展示完全不受影响的前提下，实时记录访客每道题的具体选项明细与最终测试结论。

---

## 核心特性

- **“懒人”零侵入投放**：把单文件 `.html` 或带静态资源的完整网页目录直接放进 `quizzes/`，无需修改原网页代码、无需重启服务，自动挂载 `/q/<slug>/`。
- **通用前端自动采集引擎（`src/collector/collector.js`）**：
  - **原生表单全兼容**：自动识别 `radio` 单选、`checkbox` 多选、`select` 下拉、`range` 滑块、`text`/`textarea` 填空，以及隐藏 `<input>` + `<label>` 的现代样式表单。
  - **自定义按钮 / SPA 单题切屏兼容**：在 DOM 捕获阶段拦截点击，即使点完选项立刻同步切换下一题也能准确抓到原题干与所选选项；自动过滤“开始测试 / 上一题 / 下一题 / 复制分享”等按钮，并记录返回“上一题”修改答案的变更。
  - **多页静态测试 & 断点防丢**：同一会话通过 `sessionStorage` + `sessionId` 在后端幂等合并（upsert），中途关闭页面也会通过 `sendBeacon` 兜底保留已答明细。
  - **结果页自动嗅探**：结合提交信号、`MutationObserver` 与被动 `alert` 拦截，自动提取最终结果标题/类型码、分数、维度指标条、标签及完整摘要文本。
- **统一监控统计后台（`/monitor/`）**：
  - 本地自托管与 Vercel 共用同一套后台，支持按测试筛选、一键复制分享链接、按“已完成 / 作答中”与关键词搜索、单条删除/按测试清空、**JSON / CSV 导出**。
  - 自动兼容升级原有 ASTI 历史记录（本地 JSONL 与 Upstash Redis `asti:records`）。
- **双部署形态统一代码源**：支持自有服务器/本机零依赖直接运行（本地 JSONL 原子持久化），也支持一键部署到 Vercel + Upstash Redis。

---

## 项目目录结构

```text
├── quizzes/                         # 【懒人投放区】任意静态测试页直接扔这里（热发现，免重启）
│   ├── README.md                    # 投放规范与可选 quiz.config.json 说明
│   └── asti/                        # 已内置的 ASTI 测试（纯静态原页，零侵入代码）
│       └── index.html
├── src/
│   ├── collector/
│   │   └── collector.js             # 零依赖通用前端自动采集 SDK
│   ├── server/                      # 后端核心（本地自托管 & Vercel 共用，无重复代码）
│   │   ├── index.js                 # Node HTTP 服务启动入口
│   │   ├── app.js                   # 统一路由分发器
│   │   ├── config.js                # 环境变量与路径配置（支持自动加载 .env）
│   │   ├── auth.js                  # 后台密码鉴权（timing-safe）
│   │   ├── services/
│   │   │   ├── quiz-registry.js     # quizzes/ 目录动态扫描（支持单文件 & 文件夹）
│   │   │   ├── html-injector.js     # HTML 无侵入脚本注入 + SPA 根路径资源重写
│   │   │   └── record-normalizer.js # 通用 v2 记录标准化 + 旧 ASTI 历史数据兼容
│   │   ├── storage/
│   │   │   ├── index.js             # 存储工厂（自动切换本地 JSONL / Upstash Redis）
│   │   │   ├── file-storage.js      # 本地原子 JSONL 持久化（按会话 upsert）
│   │   │   └── redis-storage.js     # Upstash Redis 云端持久化
│   │   ├── routes/                  # API 与静态测试挂载路由
│   │   └── utils/http.js            # HTTP / MIME / 路径安全工具
│   └── web/                         # 系统自带前端页面（前后端彻底分离）
│       ├── portal/index.html        # 测试导航入口页（不暴露后台入口）
│       └── monitor/                 # 统一监控统计后台（index.html / monitor.css / monitor.js）
├── api/index.js                     # Vercel Serverless 薄适配层（直接复用 src/server）
├── scripts/deploy-vercel.ps1        # Vercel 一键部署脚本
├── tests/                           # 自动化测试套件（含真实无头 Chrome 端到端测试）
├── .env.example                     # 环境变量配置模板
└── vercel.json                      # Vercel 路由与打包配置
```

---

## 快速开始（自托管服务器 / 本地运行）

要求：Node.js >= 20（本地文件存储模式**零外部运行依赖**，无需安装数据库；如需云端 Redis 持久化则执行 `npm install`）。

```bash
# 1. 安装依赖（本地文件存储可省略；使用 Upstash Redis 或 Vercel 时需要）
npm install

# 2. 按需创建环境配置（公网部署时强烈建议设置 MONITOR_PASSWORD）
cp .env.example .env

# 3. 启动服务
npm start
```

默认访问地址：

- 测试入口页：`http://127.0.0.1:3000/`（若在 `.env` 配置 `DEFAULT_QUIZ=asti`，访问 `/` 会自动进入该测试）
- 自动挂载测试页：`http://127.0.0.1:3000/q/<slug>/`（例如 `/q/asti/`）
- 统一监控后台：`http://127.0.0.1:3000/monitor/`

---

## “懒人”新增测试页用法

把任意新下载的静态测试网页放进 `quizzes/` 目录即可，**无需改原网页代码，无需重启服务**：

1. **单文件 HTML**（例如浏览器 SingleFile 插件保存的网页）：
   放入 `quizzes/mbti.html` → 立即挂载为 `/q/mbti/`
2. **完整网页目录**（带 CSS / JS / 图片等静态资源）：
   放入 `quizzes/bdsm/index.html` → 立即挂载为 `/q/bdsm/`
3. **可选微调配置**（极少数结构极其特殊的页面按需使用）：
   在同目录放一个 `quiz.config.json`（单文件则用 `<slug>.config.json`），支持自定义标题、隐藏首页入口、或指定 DOM 选择器，详见 [quizzes/README.md](quizzes/README.md)。

---

## 环境变量说明

可参考 [.env.example](.env.example)：

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址，公网自托管可设为 `0.0.0.0` |
| `PORT` | `3000` | 主服务端口（同时提供测试页与 `/monitor/`） |
| `MONITOR_PORT` | 空 | 可选，若希望额外单独开一个仅提供后台的端口可填写（如 `3002`） |
| `MONITOR_PASSWORD` | 空 | 监控后台密码；留空时免密访问，公网部署强烈建议设置 |
| `DEFAULT_QUIZ` | 空 | 填写 `quizzes/` 下的 slug（如 `asti`）后，访问 `/` 直接跳转至该测试 |
| `MAX_RECORDS` | `1000` | 最大保留答题记录条数 |
| `STORAGE_DRIVER` | `auto` | `auto` / `file` / `redis`；配置下方 Redis 变量后自动切换云端存储 |
| `UPSTASH_REDIS_REST_URL` | 空 | Upstash Redis REST API 地址 |
| `UPSTASH_REDIS_REST_TOKEN` | 空 | Upstash Redis REST API Token |

---

## Vercel 云端部署

项目保留完整 Vercel 兼容，所有路由经由 `api/index.js` 复用 `src/server/` 同一套后端代码，自动打包 `quizzes/` 并使用 Upstash Redis 持久化：

1. 将仓库推送到 GitHub。
2. 在 Vercel 导入该仓库：Framework Preset 选 `Other`，Build Command 与 Output Directory 留空即可。
3. 在项目环境变量中配置 `UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`、`MONITOR_PASSWORD`（可选 `DEFAULT_QUIZ`、`MAX_RECORDS`）。
4. Deploy 完成后即可访问：
   - 测试页：`https://<your-app>.vercel.app/` 或 `https://<your-app>.vercel.app/q/<slug>/`
   - 后台页：`https://<your-app>.vercel.app/monitor/`

也可以直接使用仓库中的 PowerShell 脚本 [scripts/deploy-vercel.ps1](scripts/deploy-vercel.ps1) 一键配置并部署。

---

## 运行自动化测试

```bash
npm test
```

测试套件使用 Node 原生 `node:test`，覆盖目录热发现、HTML 注入与资产重写、存储 upsert 与旧版兼容、HTTP 路由安全防护，以及真实无头 Chrome 端到端采集验证。

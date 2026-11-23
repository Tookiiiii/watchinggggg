# 静态测试/问卷投放目录 (`quizzes/`)

将任意下载的静态测试或问卷网页直接放入本目录即可，**无需修改原网页代码，无需重启服务**，系统会自动扫描挂载路由并自动注入通用前端采集脚本。

## 支持的两种投放方式

### 1. 文件夹形式（推荐，适合带 CSS/JS/图片等资源的完整网页）

```text
quizzes/
└── my-mbti/
    ├── index.html          # 入口页（未指定配置时自动优先 index.html，其次任意首个 .html）
    ├── style.css
    ├── app.js
    └── quiz.config.json    # 可选，不写也能自动运行
```

挂载路径：`/q/my-mbti/`

### 2. 单文件 HTML 形式（适合 SingleFile 或单页自包含 HTML）

```text
quizzes/
├── love-language.html
└── love-language.config.json   # 可选
```

挂载路径：`/q/love-language/`（同时兼容 `/q/love-language.html`）

## 可选配置文件 (`quiz.config.json` 或 `<slug>.config.json`)

绝大部分页面**零配置**即可自动识别题目、选项与结果页。如果遇到极其特殊的 DOM 结构，可按需放置可选配置做精细微调：

```json
{
  "title": "自定义显示名称",
  "description": "简介说明",
  "entry": "index.html",
  "hidden": false,
  "collector": {
    "enabled": true,
    "questionSelector": ".q-text",
    "optionSelector": ".opt-btn",
    "resultSelector": "#result-card",
    "submitSelector": "#btn-submit",
    "ignoreSelector": ".ad-banner"
  }
}
```

- `hidden: true`：不在首页导航展示，但仍可通过 `/q/<slug>/` 直接访问，后台也会正常统计。
- `collector.enabled: false`：对该测试禁用自动注入采集脚本。

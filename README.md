# dsh-search-fusion

**多引擎搜索融合 · 能省则省，需要时才融合**

DeepSeek Harness 的搜索插件。把 Bing / DuckDuckGo / SearXNG / AnySearch 等多个后端统一包装成一个 `ctx.web` search provider（`fusion`），并提供**按需融合**与**查询缓存**——因为免费引擎的额度是有限资源。

## 和 `dsh-search-router` 的区别

| | dsh-search-router | dsh-search-fusion |
| --- | --- | --- |
| 多引擎配置 | ✅ | ✅ |
| 失败自动 fallback | ✅ | ✅ |
| **部分结果合并** | ❌ 前一个引擎的结果被丢弃 | ✅ 合并去重、跨引擎一致性加权 |
| **按需融合** | ❌ | ✅ 默认只在结果不足时才多查 |
| **查询缓存** | ❌ | ✅ 重复查询零请求 |
| **成本可见** | ❌ | ✅ 结果里说明查了几个引擎、几次命中缓存 |
| 动态切换 | ✅ 即时切换 | ✅ 工具切换 |

router 回答的是「**用哪个引擎**」；fusion 回答的是「**怎么用最少的请求拿到够用的结果**」。

## 成本模型（这是插件的核心）

免费引擎有额度，所以默认路径只发一个请求：

| 策略 | 行为 | 请求数 |
| --- | --- | --- |
| `sequential` | 依次尝试，第一个成功就停 | 1（成功时） |
| **`fusion`（默认）** | 同上，但结果**少于 `minResults`** 或为空时才继续查 | 通常 1，不足时才 2+ |
| `always-fuse` | 并行查完链路里所有引擎再合并 | N（显式 opt-in） |

外加**查询缓存**（默认 10 分钟）：同一 query 的重复搜索零请求。

每次搜索的结果都带一行报告，写明实际开销：

```
Fusion: 2 engine(s) queried (bing, ddg); answered: bing, ddg.
Merged 12 unique sources, showing top 10.
Cross-engine agreement: 2 source(s) returned by 2+ engines.
Elapsed 812 ms.
```

## 融合的排序逻辑

```
score = 引擎权重 + 跨引擎一致性×1.5 + 有标题 + 有摘要
```

**跨引擎一致性**是这里唯一有意思的项：同一个 URL 被两个独立引擎都返回，比只被一个引擎返回更可能是真答案。权重设成能压过略重的引擎，但不会让单个引擎的头条被埋掉。

URL 去重会规范化：去掉 `#fragment`、尾部 `/`、`utm_*` 等追踪参数，域名小写、路径保持大小写敏感。

## 安装

```bash
dsh plugin --profile desktop add dsh-search-fusion
```

或在 profile 的 `package.json` 里：

```jsonc
{
  "dependencies": { "dsh-search-fusion": "link:C:/Data/Project/dsh-forks/dsh-search-fusion" },
  "dsh": { "profile": { "bundles": [ /* …, */ "dsh-search-fusion" ] } }
}
```

装完重启 DSH。

## 配置

设置页：**设置 → 插件 → Search fusion**。或直接写 `~/.dsh/settings.yaml` 的 `search-fusion:` 段。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `primary` | `bing` | 首选引擎 |
| `fallback` | `["ddg","searxng"]` | 主引擎失败或结果不足时依次尝试 |
| `strategy` | `fusion` | `sequential` / `fusion` / `always-fuse` |
| `maxResults` | `10` | 最终保留的结果数 |
| `minResults` | `5` | `fusion` 策略下，低于此数才继续查下一个引擎 |
| `cacheEnabled` | `true` | 查询缓存开关 |
| `cacheTtlMs` | `600000` | 缓存有效期 |
| `engineTimeoutMs` | `12000` | 单引擎超时 |
| `locale` | `zh-CN` | 传给支持地区参数的引擎 |
| `searxngInstances` | `[]` | 自定义 SearXNG 实例，留空用内置顺序 |
| `anysearchApiKeyEnv` | `ANYSEARCH_API_KEY` | AnySearch 的凭据**引用**（环境变量名，不是值） |
| `engineWeights` | `{}` | 手动调权，未列出的引擎权重为 1 |

### 代理（中国大陆必读）

DuckDuckGo 和 SextXNG 在本网络需要走代理才能访问；Bing 的 `cn.bing.com` 可直连。

Node 的全局 `fetch` **不读取** `HTTP_PROXY` / `HTTPS_PROXY`，所以插件自带了一个最小代理客户端（`lib/proxy.js`，走 HTTP CONNECT 隧道）。配置：

```jsonc
// ~/.dsh/settings.yaml
search-fusion:
  proxy: "http://127.0.0.1:7897"
```

留空则直连（适合有直接出网能力的环境）。

## 工具

| 工具 | 用途 |
| --- | --- |
| `search_fusion_status` | 当前引擎、回退链、策略、缓存统计、上次搜索结果 |
| `search_fusion_switch` | 切换主引擎/回退链，下一次搜索即生效 |

## 开发

```bash
npm test          # 离线测试（13 + 7 + 14 项断言）
npm run check     # 语法检查 + 离线测试
npm run test:live -- <proxy?>   # 真实引擎冒烟（需要网络/代理）
npm run test:proxy -- http://127.0.0.1:7897   # 代理客户端 + 全引擎验证
npm run fixtures -- <proxy?>    # 重新抓取 HTML 夹具
```

### 测试夹具

`tests/fixtures/*.html` 是从真实引擎抓下来的响应原文。解析器测试跑在这些**真实字节**上，因为手写的示例 HTML 会漏掉真实世界的坑——已经踩中三个：

1. DuckDuckGo 的结果容器是**多个 class**（`"result results_links results_links_deep web-result"`），锚定 `class="result"` 会静默解析出 0 条；
2. DuckDuckGo Lite 用**单引号**属性，而且 `href` 在 `class` **之前**；
3. Bing 的 `www.bing.com` 会 302 到 `cn.bing.com`。

### 一个已知的静默失败

DuckDuckGo 的 HTML 端点如果在 URL **和** POST body 里都给 `q`，它不报错，而是返回一个**空结果页**。0 结果而不是错误——排查时注意。

## 兼容性

- DSH `>=0.2.1-rc.1 <0.3.0-0`
- Node `^22.19.0 || >=24.0.0`
- 宿主 peer：`@deepseek-ai/dsh-web`、`dsh-tools`、`dsh-credentials`、`dsh-settings`（由宿主提供）

## License

MIT

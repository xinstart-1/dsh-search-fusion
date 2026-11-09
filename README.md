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

使用 `link:` 开发时，插件目录通常在 profile 之外。Node ESM 按 **realpath** 解析裸包名，因此**不能静态 import 宿主私有包 `@deepseek-ai/*`**：即使宿主能使用这些服务，插件目录也未必能解析它们。本插件采用零宿主静态依赖、纯对象工具定义，以及 `ctx.get()` 动态获取凭据等能力。改回静态 import 会导致模块加载失败，进而出现 `configured web provider "fusion" is not registered`。

### 验证是否生效

重启 DSH 后：
1. **设置 → 左侧导航 → 搜索融合** 应出现独立入口（由 client 半端的 `settings.section` 注册）；
2. 页面上改配置、点「+ 添加引擎」加一条自定义引擎并保存；
3. `search_fusion_status` 工具应显示 `custom engines:` 列出新引擎；
4. 调用 `web_search` 的结果应带 `Fusion: ...` 报告行。

`search_fusion_switch` 可切换主引擎和回退链，下一次搜索立即生效；自定义引擎的 id 也会出现在它的可用列表里。

## 设置页在哪

**设置 → 侧边导航 → 搜索融合**（本插件注册的独立设置页）。

本插件带 **client 半端**（`lib/client.js`，`dsh.client` 声明），通过宿主的 `settings.section` slot 注册一个真正的设置页，因此它会像「通用设置」「模型」「内置插件」一样出现在设置左侧导航里——而不是只落在「内置插件」页那张**只读**的 `plugins.bundle.config` 展示区（那里点不动，是宿主的插件清单卡片，不是配置表单）。

页面上可以直接改主引擎、回退链、策略、结果数、代理，以及**增删自定义搜索引擎**。数据经由 host 半端的 `/plugins/dsh-search-fusion/config` 路由读写。

> 保存后宿主把值合并进 profile 的 `cordis.patch.yml`，**需要重启 DSH** 才重建插件实例、让新的引擎列表生效（密钥轮换不需要重启）。

## 自定义搜索引擎（填地址 + Key 就行）

设置页里点 **「+ 添加引擎」**，然后：

1. **粘贴 API 地址** —— 引擎名和全部技术参数自动跟着地址走
2. **粘贴 API Key** —— 保存时写进 DSH 凭据

没有「引擎类型」这种下拉。**地址就是身份**：粘 `https://api.tavily.com/search` 就自动叫 Tavily，并自动填好 POST、`Authorization: Bearer`、请求体 `{query, max_results}`、结果取 `results[].{url,title,content}`；粘任意别的域名，就用域名当名字（`search.acme.io` → `Acme`）。

**名字可以改**：卡片顶部就是名称输入框，直接改；改过之后它就不再跟着地址变了（只填过地址、名字还是自动的，才会随地址更新）。这也顺带解决了一个实际需求——同一个 Tavily 换个网关地址，名字还叫 Tavily 就行。

### 自动识别的依据

匹配只看**主机名**，不看路径：

| 地址 | 识别结果 |
| --- | --- |
| `api.tavily.com`（含 `eu.api.tavily.com` 等子域） | Tavily（REST 预设） |
| `mcp.tavily.com` | Tavily（MCP 预设） |
| 其它域名 | 取域名主体首字母大写，如 `Acme` |

识别到预设时会同时补上 `apiKeyEnv`；该引用被别的行占用时不会抢，而是留空、由保存时按 id 派生。

### MCP

地址含 `/mcp/` 或命中 `mcp.tavily.com` 时按 MCP 协议走：

```
initialize                -> 拿 protocolVersion + mcp-session-id
notifications/initialized
tools/call                -> { name: "tavily_search", arguments: { query, max_results } }
```

响应支持 JSON 和 SSE（`text/event-stream`）两种帧；工具返回的文本若本身是 JSON，就用和 REST 完全相同的 `resultsPath` / 字段映射解析，两种传输共用一条结果管线。会话一次性（每次搜索新开、用完即丢），换 Key 立即生效。

### API Key 存哪

Key 输入框是密码框，保存时前端把值放在 `secrets: {<engine id>: <key>}` 里发给 host，host 调用 DSH 凭据服务（`ctx.get("credentials").set(ref, value)`）写入 `~/.dsh/.credentials.yaml`，**然后从 patch 里删掉明文**——落进 profile 的 `cordis.patch.yml` 的只有引用名。

- 引用名优先用该行识别出的 `apiKeyEnv`；没有就自动派生（`tavily` → `TAVILY_API_KEY`，其它 id → `DSH_SEARCH_<ID>_KEY`）。
- 已保存的 Key 在页面上显示为一段掩码（`••••••••`），不是空框——空框会让人以为 Key 丢了。掩码只是占位，**不会被当成密钥回写**；只有你重新输入的值才会被保存。
- 保存时若不重新输入，该引擎的 Key 保持不动（mask 不会被当作新值）。
- 没有 credentials 服务的环境会直接报错，而不是静默丢 Key。

搜索时解析顺序：`ctx.get("credentials")` → `launchEnvironment` → `process.env`。每次搜索重新解析，轮换 Key 无需重启（**新增/删除引擎**仍需重启）。

### 整体收起

引擎列表可以整体折叠：卡片多了以后页面会很长，标题栏右侧有「收起 / 展开」按钮，标题下面那行会直接给出摘要（如 `2 个引擎：Tavily、Acme`，缺 Key 的会标「缺 Key」）。

首次进入页面时，**已有引擎就默认收起**（配置一次之后就很少改）；点「+ 添加引擎」会自动展开。

### 每张卡片可单独收起

每张卡片标题左侧有 ▾/▸ 折叠标记，点它只折叠这一张。收起后显示一行摘要（`地址 · 已存 Key` / `MCP · 缺 Key`）。

默认状态：**从配置里读出来的卡片收起**（已经配好了），**本次新增的卡片展开**（正在填）。编辑时会自动保持展开，不会在输入过程中突然收起。

### MCP 用配置文件，不是填空

MCP 服务器都是按 `mcpServers` 片段分发的，所以这一行是个 **JSON 文本域**，直接粘贴整段即可：

```json
{
  "mcpServers": {
    "tavily": {
      "url": "https://mcp.tavily.com/mcp/"
    }
  }
}
```

支持几种写法：

| 粘贴内容 | 行为 |
| --- | --- |
| `mcpServers` 片段 | 取第一个服务器的 url / name / headers |
| `{ "url": "..." }` | 单个服务器，不包一层 |
| 直接粘到「API 地址」框 | 自动识别为 MCP，转成文本域 |

- `headers` 里的 `Authorization: Bearer xxx` 会转成 `Authorization: Bearer {key}`，真实 Key 仍由 Key 框存进凭据。
- `command`/`args` 的 stdio 服务器**不支持**（本插件只走 HTTP/SSE），会给出提示而不是静默失败。
- 粘贴后名称按地址自动识别（`mcp.tavily.com` → `Tavily (MCP)`），id 撞号时自动避让成 `tavily-mcp`。

### 可以加多个

- 每个引擎一行、一个 Key。
- 同类型多行**不会复用同一个凭据引用**，否则保存时会互相覆盖，会自动派生 `DSH_SEARCH_<ID>_KEY`。
- 卡片徽标标出它在链路里的身份：**主引擎 / 回退 / 未启用**；标「未启用」的行旁边有「加入回退链」按钮。
- 删除主引擎时主引擎自动顺延到下一个自定义引擎（没有则回到 `bing`）。

### 高级字段（一般不用改）

折叠在「高级」里：`id`、`连接方式`（REST/MCP）、方法、`Key 引用`、认证头模板、结果数组路径、URL/标题/摘要字段、请求体模板、MCP 工具名与参数名。这些值默认由地址识别得出，只有在源站返回格式特殊时才需要动。

**等价 YAML**（不用 GUI 时直接写 profile 的 `cordis.patch.yml`）：

```yaml
- id: dsh-search-fusion
  config:
    primary: tavily
    fallback: [bing]
    customEngines:
      - id: tavily
        preset: tavily          # 其余技术字段由预设补齐
        url: https://api.tavily.com/search
        apiKeyEnv: TAVILY_API_KEY   # 值放 DSH 凭据/环境变量，别写这里
```

保存 → 重启 DSH → `search_fusion_status` 的 `custom engines:` 一行应列出该引擎，`search_fusion_switch` 的可用引擎里也会出现它。

**不用 GUI 也可以**：直接在 profile 的 `cordis.patch.yml` 写 `customEngines:`（格式同上），或在插件自带的 `cordis.patch.yml` 的 `config:` 里写。临时切换用 `search_fusion_switch` 工具（重启后恢复持久配置）。

插件包自带的 patch 只把 `searchProvider` 设为 `fusion`，不修改 `fetchProvider`。

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
| `customEngines` | `[]` | 用户自定义 JSON 搜索引擎，见上节 |
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
npm test          # 离线测试（融合、解析器、provider、宿主加载契约、自定义引擎本地 HTTP 端到端）
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
- 宿主包均为 optional peer，无静态宿主依赖；schemastery 与 dsh-web 仅动态尝试加载，缺失时降级。

## License

MIT

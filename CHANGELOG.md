# Changelog

## 0.2.0

### 新增

- 设置页纳入插件自带的 **搜索融合** 分区（`settings.section`），不再只靠改 profile 配置。
- 自定义搜索引擎：粘贴 API 地址即自动识别名称与技术参数（请求方法、请求体模板、结果路径、字段映射、MCP 工具名），Key 存进 DSH 凭据，配置文件只留引用名。
- 引擎卡片可单独收起；MCP 服务器以 `mcpServers` JSON 片段粘贴接入。
- 页面就地校验：未知引擎 id、重复 id、内置引擎保留名、数字越界都会在对应输入框下说明，而不是等保存失败。
- 保存立即生效，并维护一份本地恢复副本（`dsh-search-fusion.state.json`），profile 配置被清空时可恢复。

### 变更

- **内置引擎收敛为无需 Key、零配置的四个**：`bing`、`ddg`、`ddg-lite`、`searxng`。需要凭据的引擎不再出现在内置列表里，避免「能选却无处填 Key」。
- **AnySearch 改为可添加引擎**：粘贴 `https://api.anysearch.com/v1/search` 自动套用预设（POST，结果取 `data.results`）。旧配置里若仍以 `anysearch` 作为主引擎/回退引擎，加载时会自动补一条预设引擎。

### 修复

- 修复每次重启后设置页出现「检测到 profile 配置里缺少：自定义搜索引擎、主引擎、回退链」横幅：Config 字段声明为 `.volatile()`，加载器传入的是引用对象，插件此前直接读取导致回落默认值，只能靠恢复副本补齐。现在读取前先解引用，启动、保存、快照三条路径一致。
- 修复插件自带的 bundle patch 每次启动覆盖用户配置：insert 行不再携带 `config`。
- 修复新增引擎时 id 跟随 URL/名称变化却不同步 `primary` / `fallback`，导致保存被拒（`主引擎 "engine" 不可用`）。
- 修复删除引擎时只在它是主引擎的情况下清理回退链，留下悬空 id。
- 修复自动推导的 id 可能撞上内置保留名（如 `anysearch`）或与已有引擎重复。
- 修复 AnySearch 预设的域名/方法/结果路径（`api.anysearch.ai` 无法解析；正确为 `api.anysearch.com` + POST + `data.results`）。
- 保存成功后不再提示「重启后生效」——改动是立即生效的。

## 0.1.2

- 多引擎搜索融合 provider、按需融合策略（`sequential` / `fusion` / `always-fuse`）、失败自动 fallback、查询缓存与成本报告。

## 0.1.1

- 首次发布。

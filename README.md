---

# ☁️ EdgeOne Edge Function AI API Proxy

基于腾讯云 EdgeOne 边缘函数构建的轻量级、无服务器 AI API 中转站。支持聚合多个 AI 提供商（OpenAI、Anthropic、DeepSeek 等），对外提供**统一的 OpenAI 兼容 API 接口**。

## ✨ 核心特性

- 🌐 **多提供商聚合**：通过 JSON 配置轻松添加任意数量的 AI 提供商，支持 OpenAI 和 Anthropic 原生格式。
- 🔄 **格式自动转换**：自动将 OpenAI 格式的请求转换为 Anthropic 格式，并将响应（包含流式 SSE）无缝转回 OpenAI 格式。
- 🔍 **自动模型发现**：自动请求提供商的 `/models` 端点获取最新模型列表，无需手动维护模型字典。
- 🔐 **灵活的密钥管理**：支持自定义用户 API Key（数量无限制），可配置速率限制和提供商访问白名单。
- 🎯 **显式路由**：支持 `provider_id:model_name` 语法，精准指定请求路由到的提供商，解决模型重名问题。
- 🚀 **全球边缘加速**：依托腾讯云 EdgeOne 全球边缘节点网络，低延迟、高并发、免运维。

---

## 🚀 快速部署

### 前置准备

1. 登录 [腾讯云 EdgeOne 控制台](https://console.cloud.tencent.com/edgeone)。
2. 确保已接入至少一个站点（域名），且套餐支持边缘函数功能。

### 部署步骤

1. 进入站点详情 → 左侧菜单选择 **边缘函数** → 点击 **创建函数**。
2. 填写函数名称（如 `ai-api-proxy`），选择运行时环境（推荐 **Edge Routine** / **V8 Isolate**）。
3. 在代码编辑器中，将 `edge-function.js` 中的代码全部复制并粘贴进去。
4. 点击 **保存** 完成代码部署。
5. 进入该函数的 **函数配置** → **环境变量** 页签，按照下方 [环境变量配置](#-环境变量配置) 添加 `PROVIDERS` 和 `USER_KEYS` 变量。
6. 返回边缘函数列表，点击 **触发器配置**，添加路径匹配规则：
   - 匹配路径：`/*` 或 `/v1/*`（根据实际需求配置）
   - 优先级：按需设置
7. 点击 **发布** 使函数生效。

> 💡 **提示**：修改环境变量或代码后，需要重新 **发布** 函数才能生效。

---

## ⚙️ 环境变量配置

本项目依赖两个核心环境变量，均使用 **JSON 格式**。
> ⚠️ **安全提示**：由于包含 API Key，强烈建议在 EdgeOne 控制台中将这两个变量设置为 **加密变量 (Secret)** 类型，避免明文暴露。

### 1. `PROVIDERS` (提供商配置)

定义上游 AI 提供商的连接信息。

```json
[
  {
    "id": "openai",
    "name": "OpenAI Official",
    "format": "openai",
    "baseURL": "https://api.openai.com/v1",
    "apiKey": "sk-xxxxxxxxxxxxxxxx",
    "models": null
  },
  {
    "id": "anthropic",
    "name": "Anthropic Official",
    "format": "anthropic",
    "baseURL": "https://api.anthropic.com/v1",
    "apiKey": "sk-ant-xxxxxxxxxxxxxxxx",
    "models": null
  },
  {
    "id": "deepseek",
    "name": "DeepSeek",
    "format": "openai",
    "baseURL": "https://api.deepseek.com/v1",
    "apiKey": "sk-xxxxxxxxxxxxxxxx",
    "models": ["deepseek-chat", "deepseek-coder"]
  }
]
```

**字段说明：**
| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `id` | String | ✅ | 提供商标识（唯一，英文，用于显式路由） |
| `name` | String | ✅ | 提供商名称（仅用于显示和日志） |
| `format` | String | ✅ | API 格式：`openai` 或 `anthropic` |
| `baseURL` | String | ✅ | 提供商的 API 基础地址（**不要**以 `/` 结尾） |
| `apiKey` | String | ✅ | 提供商的 API 密钥 |
| `models` | Array/Null | ❌ | 手动指定模型列表。设为 `null` 则自动请求 `/models` 端点获取 |

### 2. `USER_KEYS` (用户密钥配置)

定义允许访问此中转站的用户密钥及权限。您可以无限制地添加用户。

```json
[
  {
    "key": "sk-my-proxy-alice-001",
    "name": "Alice",
    "enabled": true,
    "rateLimit": 60,
    "allowedProviders": null
  },
  {
    "key": "sk-my-proxy-bob-002",
    "name": "Bob (Restricted)",
    "enabled": true,
    "rateLimit": 10,
    "allowedProviders": ["deepseek"]
  }
]
```

**字段说明：**
| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `key` | String | ✅ | 用户使用的 API 密钥（自定义，无格式限制） |
| `name` | String | ✅ | 用户名称/备注 |
| `enabled` | Bool | ❌ | 是否启用该密钥（设为 `false` 即可禁用，默认 `true`） |
| `rateLimit` | Number | ❌ | 每分钟请求上限（设为 `0` 或 `null` 表示不限制） |
| `allowedProviders`| Array/Null| ❌ | 允许使用的提供商 `id` 列表。设为 `null` 表示允许全部 |

---

## 📖 API 使用指南

部署完成后，您的 EdgeOne 加速域名（如 `https://api.your-domain.com`）即为统一的 BaseURL。

### 1. 获取模型列表
自动聚合所有提供商的可用模型。

```bash
curl https://api.your-domain.com/v1/models \
  -H "Authorization: Bearer sk-my-proxy-alice-001"
```

### 2. 标准对话补全 (自动路由)
系统会自动遍历提供商，寻找匹配 `model` 名称的提供商进行转发。

```bash
curl https://api.your-domain.com/v1/chat/completions \
  -H "Authorization: Bearer sk-my-proxy-alice-001" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "写一首关于边缘计算的诗"}],
    "stream": false
  }'
```

### 3. 流式对话补全 (SSE)
完全兼容 OpenAI 的流式输出格式，即使底层调用的是 Anthropic。

```bash
curl https://api.your-domain.com/v1/chat/completions \
  -H "Authorization: Bearer sk-my-proxy-alice-001" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### 4. 显式指定提供商 (推荐)
当不同提供商有同名模型，或为了跳过自动匹配提升速度时，使用 `provider_id:model_name` 格式。

```bash
# 强制使用 deepseek 提供商
curl https://api.your-domain.com/v1/chat/completions \
  -H "Authorization: Bearer sk-my-proxy-alice-001" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek:deepseek-chat",
    "messages": [{"role": "user", "content": "解释量子计算"}]
  }'
```

---

## 🧠 工作原理

1. **鉴权与路由**：边缘函数拦截请求，验证 `USER_KEYS`，并根据 `model` 参数解析目标 `PROVIDERS`。
2. **格式转换 (OpenAI ↔ Anthropic)**：
   - 如果目标是 Anthropic，函数会将 OpenAI 的 `messages` 数组拆分为 `system` 和 `messages`，并转换多模态图片格式。
   - 响应时，将 Anthropic 的 `content_block_delta` 流式事件实时重组为 OpenAI 的 `chat.completion.chunk` 格式。
3. **模型发现与缓存**：
   - 首次请求或缓存过期（10分钟）时，函数会向提供商发起 `GET /models` 请求。
   - 结果缓存在边缘函数实例的内存中（V8 Isolate），大幅减少后续请求的延迟。

---

## ⚠️ 注意事项与限制

1. **EdgeOne 边缘函数限制**：
   - **执行时长**：单次请求的最大 CPU 执行时间取决于您的 EdgeOne 套餐版本。基础版通常限制为 50ms~100ms CPU 时间，企业版可支持更长执行时间。对于简单的 API 转发通常足够，但复杂的流式数据转换可能消耗较多 CPU 时间。
   - **内存限制**：单个函数实例的可用内存通常为 128MB~256MB（视套餐而定），请避免在内存中存储过大的数据。
   - **子请求**：边缘函数内发起的 `fetch()` 子请求受套餐的子请求次数限制，请注意 `/models` 自动发现产生的额外请求开销。建议对常用提供商手动配置 `models` 字段以减少子请求。
2. **流式响应 (SSE) 超时**：
   - EdgeOne 对空闲连接有空闲超时策略。如果 AI 模型思考时间过长（长时间未输出任何 token），连接可能会被边缘节点主动断开。建议客户端实现重试机制。
3. **内存缓存的非持久性**：
   - 模型列表缓存在边缘函数实例内存中。由于 V8 Isolate 实例会动态分配和回收，缓存可能在不同节点或实例重启后失效，这是正常现象，系统会自动重新获取。
4. **速率限制的局限性**：
   - 代码内置的速率限制基于单实例内存，属于 **best-effort** 限流，无法跨实例精确计数。如需精确的全局限流，建议使用 EdgeOne 控制台自带的 **频率限制 (Rate Limiting)** 功能，或对接外部 Redis 服务。
5. **不支持的功能**：
   - 当前版本专注于 `Chat Completions`。不支持 `Assistants API`、`Fine-tuning` 或 `Image Generation` 等非标准对话端点。
6. **环境变量读取兼容性**：
   - 代码中对环境变量的读取做了多重兼容处理（`edgeone.env` / `process.env` / `ENV`）。如果部署后发现无法读取配置，请查阅您所使用的 EdgeOne 运行时版本的官方文档，确认环境变量的正确访问方式。

---

## 📄 License

MIT License. 自由使用、修改和分发。

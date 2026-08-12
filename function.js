// ============================================================
// EdgeOne Edge Function - AI API 中转站
// ============================================================
// 部署方式：
//   1. 登录腾讯云 EdgeOne 控制台
//   2. 进入站点 → 边缘函数 → 创建函数
//   3. 将此代码粘贴到函数编辑器中
//   4. 在函数"环境变量"配置中设置 PROVIDERS 和 USER_KEYS
//
// 触发规则：配置路径匹配 /* 或 /v1/*
// ============================================================

// ------------------------------------------------------------
// 1. 提供商配置 (通过 EdgeOne 边缘函数的环境变量 PROVIDERS 存储, JSON 格式)
//    在 EdgeOne 控制台 → 边缘函数 → 函数配置 → 环境变量 中设置
//
//    变量名: PROVIDERS
//    变量值示例 (JSON):
//    [
//      {
//        "id": "openai",
//        "name": "OpenAI",
//        "format": "openai",
//        "baseURL": "https://api.openai.com/v1",
//        "apiKey": "sk-xxxx",
//        "models": null
//      },
//      {
//        "id": "anthropic",
//        "name": "Anthropic",
//        "format": "anthropic",
//        "baseURL": "https://api.anthropic.com/v1",
//        "apiKey": "sk-ant-xxxx",
//        "models": null
//      },
//      {
//        "id": "deepseek",
//        "name": "DeepSeek",
//        "format": "openai",
//        "baseURL": "https://api.deepseek.com/v1",
//        "apiKey": "sk-xxxx",
//        "models": null
//      },
//      {
//        "id": "groq",
//        "name": "Groq",
//        "format": "openai",
//        "baseURL": "https://api.groq.com/openai/v1",
//        "apiKey": "gsk_xxxx",
//        "models": null
//      }
//    ]
//
//    字段说明:
//    - id:       提供商标识 (唯一, 英文)
//    - name:     提供商名称 (显示用)
//    - format:   API格式, 可选 "openai" 或 "anthropic"
//    - baseURL:  提供商的API基础地址 (不含末尾斜杠)
//    - apiKey:   提供商的API密钥
//    - models:   手动指定模型列表(可选), 为 null 则自动从提供商获取
//
// ------------------------------------------------------------

// ------------------------------------------------------------
// 2. 用户密钥配置 (通过 EdgeOne 边缘函数的环境变量 USER_KEYS 存储, JSON 格式)
//    在 EdgeOne 控制台 → 边缘函数 → 函数配置 → 环境变量 中设置
//    (建议使用加密/Secret 类型环境变量)
//
//    变量名: USER_KEYS
//    变量值示例 (JSON):
//    [
//      {
//        "key": "sk-my-proxy-key-001",
//        "name": "用户A",
//        "enabled": true,
//        "rateLimit": 60,
//        "allowedProviders": null
//      },
//      {
//        "key": "sk-my-proxy-key-002",
//        "name": "用户B",
//        "enabled": true,
//        "rateLimit": 30,
//        "allowedProviders": ["openai", "deepseek"]
//      }
//    ]
//
//    字段说明:
//    - key:              用户使用的API密钥 (自定义, 无格式限制)
//    - name:             用户名称/备注
//    - enabled:          是否启用
//    - rateLimit:        每分钟请求上限 (0 = 不限制)
//    - allowedProviders: 允许使用的提供商列表, null = 全部允许
//
// ------------------------------------------------------------

// ============================================================
// EdgeOne 环境变量读取
// ============================================================

/**
 * 获取 EdgeOne 环境变量
 * EdgeOne 边缘函数通过全局对象 edgeone 或 process.env 读取环境变量
 * 不同版本的运行时可能略有差异，此处做兼容处理
 */
function getEnvVar(name) {
  // EdgeOne 运行时可能通过以下方式暴露环境变量:
  // 1. 全局 edgeone.env (较新运行时)
  // 2. 全局 process.env
  // 3. 全局 ENV 对象 (自定义约定)
  if (typeof edgeone !== 'undefined' && edgeone.env && edgeone.env[name] !== undefined) {
    return edgeone.env[name];
  }
  if (typeof process !== 'undefined' && process.env && process.env[name] !== undefined) {
    return process.env[name];
  }
  if (typeof ENV !== 'undefined' && ENV[name] !== undefined) {
    return ENV[name];
  }
  return undefined;
}

// ============================================================
// 核心逻辑
// ============================================================

/**
 * 解析环境变量中的 JSON 配置
 */
function parseEnvJSON(envVar, fallback) {
  if (!envVar) return fallback;
  try {
    return typeof envVar === 'string' ? JSON.parse(envVar) : envVar;
  } catch (e) {
    console.error('JSON 解析失败:', e.message);
    return fallback;
  }
}

/**
 * 加载并验证提供商配置
 */
function loadProviders() {
  return parseEnvJSON(getEnvVar('PROVIDERS'), []);
}

/**
 * 加载并验证用户密钥配置
 */
function loadUserKeys() {
  return parseEnvJSON(getEnvVar('USER_KEYS'), []);
}

/**
 * 验证用户 API Key，返回匹配的用户配置
 */
function authenticateUser(request, userKeys) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.substring(7).trim();
  return userKeys.find(u => u.key === token && u.enabled !== false) || null;
}

/**
 * 根据模型名称查找对应的提供商
 * 策略: 遍历所有提供商，检查模型是否在其可用模型列表中
 * 也支持通过 model 名称前缀匹配 (如 "openai:gpt-4" 显式指定提供商)
 */
async function resolveProvider(model, providers) {
  // 支持显式指定: "provider_id:model_name"
  if (model && model.includes(':')) {
    const [providerId, ...rest] = model.split(':');
    const actualModel = rest.join(':');
    const provider = providers.find(p => p.id === providerId);
    if (provider) {
      return { provider, actualModel };
    }
  }

  // 自动匹配: 遍历提供商查找模型
  for (const provider of providers) {
    const models = await getProviderModels(provider);
    if (models.includes(model)) {
      return { provider, actualModel: model };
    }
  }

  // 未找到匹配，默认使用第一个提供商
  if (providers.length > 0) {
    return { provider: providers[0], actualModel: model };
  }

  return null;
}

/**
 * 获取提供商的可用模型列表
 * 优先使用手动配置，否则自动请求提供商 /models 端点
 * 结果缓存在内存中
 */
const modelCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10分钟缓存

async function getProviderModels(provider) {
  // 如果手动指定了模型列表，直接使用
  if (provider.models && Array.isArray(provider.models) && provider.models.length > 0) {
    return provider.models;
  }

  // 检查缓存
  const cacheKey = provider.id;
  const cached = modelCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.models;
  }

  // 自动从提供商获取模型列表
  try {
    const models = await fetchModelsFromProvider(provider);
    modelCache.set(cacheKey, { models, timestamp: Date.now() });
    return models;
  } catch (e) {
    console.error(`获取 ${provider.id} 模型列表失败:`, e.message);
    // 返回缓存或空列表
    return cached ? cached.models : [];
  }
}

/**
 * 从提供商 API 获取模型列表
 */
async function fetchModelsFromProvider(provider) {
  const headers = {};

  if (provider.format === 'anthropic') {
    headers['x-api-key'] = provider.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    // OpenAI 兼容格式
    headers['Authorization'] = `Bearer ${provider.apiKey}`;
  }

  const url = `${provider.baseURL}/models`;

  const response = await fetch(url, {
    method: 'GET',
    headers
    // 注意: EdgeOne 不支持 Cloudflare 的 cf 选项 (如 cacheTtl)
  });

  if (!response.ok) {
    console.warn(`${provider.id} /models 请求失败: ${response.status}`);
    return [];
  }

  const data = await response.json();
  const models = [];

  if (data.data && Array.isArray(data.data)) {
    // OpenAI 格式: { data: [{ id: "gpt-4", ... }] }
    for (const m of data.data) {
      if (m.id) models.push(m.id);
    }
  }

  return models;
}

/**
 * 聚合所有提供商的模型列表 (用于 /v1/models 端点)
 */
async function getAggregatedModels(providers) {
  const allModels = [];

  for (const provider of providers) {
    const models = await getProviderModels(provider);
    for (const modelId of models) {
      allModels.push({
        id: modelId,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: provider.id,
        permission: [],
        root: modelId,
        parent: null
      });
    }
  }

  return allModels;
}

/**
 * 构建转发给 OpenAI 兼容提供商的请求
 */
function buildOpenAIRequest(provider, actualModel, body) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.apiKey}`
  };

  // 修改模型名称
  const modifiedBody = { ...body, model: actualModel };

  const url = `${provider.baseURL}/chat/completions`;

  return { url, headers, body: modifiedBody };
}

/**
 * 构建转发给 Anthropic 提供商的请求
 * 将 OpenAI 格式转换为 Anthropic 格式
 */
function buildAnthropicRequest(provider, actualModel, body) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': provider.apiKey,
    'anthropic-version': '2023-06-01'
  };

  // OpenAI → Anthropic 格式转换
  const anthropicBody = openAIToAnthropic(body, actualModel);

  const url = `${provider.baseURL}/messages`;

  return { url, headers, body: anthropicBody };
}

/**
 * OpenAI 请求格式 → Anthropic 请求格式
 */
function openAIToAnthropic(openAIBody, model) {
  const messages = openAIBody.messages || [];
  let system = '';
  const convertedMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n' : '') + (typeof msg.content === 'string' ? msg.content : msg.content.map(c => c.text || '').join('\n'));
    } else {
      const converted = {
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      };

      // 处理多模态内容
      if (Array.isArray(msg.content)) {
        converted.content = msg.content.map(part => {
          if (part.type === 'text') {
            return { type: 'text', text: part.text };
          } else if (part.type === 'image_url') {
            // 转换 image_url 为 Anthropic 的 image 格式
            const url = part.image_url?.url || '';
            if (url.startsWith('data:')) {
              const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
              if (match) {
                return {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: match[1],
                    data: match[2]
                  }
                };
              }
            }
            return { type: 'text', text: '[image]' };
          }
          return part;
        });
      }

      convertedMessages.push(converted);
    }
  }

  const result = {
    model: model,
    messages: convertedMessages,
    max_tokens: openAIBody.max_tokens || openAIBody.max_completion_tokens || 4096
  };

  if (system) result.system = system;
  if (openAIBody.temperature !== undefined) result.temperature = openAIBody.temperature;
  if (openAIBody.top_p !== undefined) result.top_p = openAIBody.top_p;
  if (openAIBody.stream) result.stream = true;
  if (openAIBody.stop) result.stop_sequences = Array.isArray(openAIBody.stop) ? openAIBody.stop : [openAIBody.stop];

  return result;
}

/**
 * Anthropic 响应 → OpenAI 响应格式 (非流式)
 */
function anthropicToOpenAI(anthropicResponse, model) {
  let textContent = '';

  for (const block of anthropicResponse.content || []) {
    if (block.type === 'text') {
      textContent += block.text;
    }
  }

  return {
    id: `chatcmpl-${anthropicResponse.id || crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: textContent
      },
      finish_reason: mapAnthropicStopReason(anthropicResponse.stop_reason)
    }],
    usage: {
      prompt_tokens: anthropicResponse.usage?.input_tokens || 0,
      completion_tokens: anthropicResponse.usage?.output_tokens || 0,
      total_tokens: (anthropicResponse.usage?.input_tokens || 0) + (anthropicResponse.usage?.output_tokens || 0)
    }
  };
}

/**
 * Anthropic 流式响应 → OpenAI 流式格式
 */
async function* convertAnthropicStream(response, model) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  let promptTokens = 0;
  let completionTokens = 0;

  // 发送初始 chunk
  yield `data: ${JSON.stringify({
    id: completionId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
  })}\n\n`;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.substring(6);
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);

          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const text = event.delta.text;
            completionTokens += Math.ceil(text.length / 4); // 粗略估算

            yield `data: ${JSON.stringify({
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{
                index: 0,
                delta: { content: text },
                finish_reason: null
              }]
            })}\n\n`;
          }

          if (event.type === 'message_start' && event.message?.usage) {
            promptTokens = event.message.usage.input_tokens || 0;
          }

          if (event.type === 'message_delta' && event.usage) {
            completionTokens = event.usage.output_tokens || completionTokens;
          }

          if (event.type === 'message_stop') {
            yield `data: ${JSON.stringify({
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: 'stop'
              }]
            })}\n\n`;
          }
        } catch (e) {
          // 跳过无法解析的行
        }
      }
    }
  } finally {
    yield `data: [DONE]\n\n`;
  }
}

/**
 * 映射 Anthropic 停止原因到 OpenAI 格式
 */
function mapAnthropicStopReason(reason) {
  switch (reason) {
    case 'end_turn': return 'stop';
    case 'max_tokens': return 'length';
    case 'stop_sequence': return 'stop';
    case 'tool_use': return 'tool_calls';
    default: return 'stop';
  }
}

/**
 * 处理流式转发 (OpenAI 兼容提供商直接透传)
 */
function handleStreamPassthrough(response) {
  return new Response(response.body, {
    status: response.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}

/**
 * 处理 Anthropic 流式响应的格式转换
 */
async function handleAnthropicStream(response, model) {
  const generator = convertAnthropicStream(response, model);

  const stream = new ReadableStream({
    async pull(controller) {
      const { value, done } = await generator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(value));
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}

/**
 * 简单的速率限制 (基于内存, 边缘函数实例级别)
 * 注意: EdgeOne 边缘函数实例可能会频繁冷启动，
 *       此速率限制仅为尽力而为(best-effort)，不是精确的全局限流。
 *       如需精确限流，建议使用 EdgeOne 的速率限制功能或外部 Redis。
 */
const rateLimitMap = new Map();

function checkRateLimit(userId, limit) {
  if (!limit || limit <= 0) return true;

  const now = Date.now();
  const windowMs = 60 * 1000; // 1分钟窗口

  if (!rateLimitMap.has(userId)) {
    rateLimitMap.set(userId, []);
  }

  const timestamps = rateLimitMap.get(userId);

  // 清理过期记录
  while (timestamps.length > 0 && now - timestamps[0] > windowMs) {
    timestamps.shift();
  }

  if (timestamps.length >= limit) {
    return false;
  }

  timestamps.push(now);
  return true;
}

/**
 * 错误响应生成器
 */
function errorResponse(message, statusCode = 400, type = 'invalid_request_error') {
  return new Response(JSON.stringify({
    error: {
      message,
      type,
      code: statusCode
    }
  }), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ============================================================
// 路由处理
// ============================================================

async function handleModelsRequest(providers) {
  const models = await getAggregatedModels(providers);
  return new Response(JSON.stringify({
    object: 'list',
    data: models
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleChatCompletionsRequest(request, providers, user) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return errorResponse('请求体 JSON 解析失败');
  }

  const model = body.model;
  if (!model) {
    return errorResponse('缺少 model 参数');
  }

  // 解析提供商
  const resolved = await resolveProvider(model, providers);
  if (!resolved) {
    return errorResponse('无法找到匹配的提供商，请检查 PROVIDERS 配置', 500, 'server_error');
  }

  const { provider, actualModel } = resolved;

  // 检查用户是否有权使用该提供商
  if (user.allowedProviders && !user.allowedProviders.includes(provider.id)) {
    return errorResponse(`您的密钥无权使用提供商: ${provider.id}`, 403, 'forbidden');
  }

  // 速率限制
  if (!checkRateLimit(user.key, user.rateLimit || 0)) {
    return errorResponse('请求过于频繁，请稍后再试', 429, 'rate_limit_exceeded');
  }

  const isStream = body.stream === true;

  // 根据提供商格式构建请求
  let reqConfig;
  if (provider.format === 'anthropic') {
    reqConfig = buildAnthropicRequest(provider, actualModel, body);
  } else {
    reqConfig = buildOpenAIRequest(provider, actualModel, body);
  }

  // 转发请求
  let providerResponse;
  try {
    providerResponse = await fetch(reqConfig.url, {
      method: 'POST',
      headers: reqConfig.headers,
      body: JSON.stringify(reqConfig.body)
    });
  } catch (e) {
    return errorResponse(`请求提供商 ${provider.id} 失败: ${e.message}`, 502, 'upstream_error');
  }

  // 处理错误响应
  if (!providerResponse.ok) {
    const errorBody = await providerResponse.text();
    return new Response(errorBody, {
      status: providerResponse.status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 处理流式响应
  if (isStream) {
    if (provider.format === 'anthropic') {
      return handleAnthropicStream(providerResponse, model);
    } else {
      return handleStreamPassthrough(providerResponse);
    }
  }

  // 处理非流式响应
  if (provider.format === 'anthropic') {
    const anthropicData = await providerResponse.json();
    const openAIResponse = anthropicToOpenAI(anthropicData, model);
    return new Response(JSON.stringify(openAIResponse), {
      headers: { 'Content-Type': 'application/json' }
    });
  } else {
    // OpenAI 格式直接透传
    const data = await providerResponse.text();
    return new Response(data, {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ============================================================
// 主入口 - EdgeOne 边缘函数事件监听模式
// ============================================================

async function handleRequest(event) {
  const request = event.request;

  // CORS 预检
  if (request.method === 'OPTIONS') {
    return event.respondWith(new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400'
      }
    }));
  }

  const url = new URL(request.url);
  const pathname = url.pathname;

  // 添加 CORS 头的辅助函数
  function withCORS(response) {
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Access-Control-Allow-Origin', '*');
    newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return newResponse;
  }

  // 根路径信息
  if (pathname === '/' || pathname === '') {
    return withCORS(new Response(JSON.stringify({
      name: 'AI API Proxy (EdgeOne)',
      version: '1.0.0',
      platform: 'Tencent Cloud EdgeOne Edge Functions',
      endpoints: {
        models: '/v1/models',
        chat_completions: '/v1/chat/completions'
      },
      usage: {
        '获取模型列表': 'GET /v1/models',
        '对话补全': 'POST /v1/chat/completions',
        '显式指定提供商': '在 model 参数中使用 "provider_id:model_name" 格式'
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  // 加载配置
  const providers = loadProviders();
  const userKeys = loadUserKeys();

  // 验证配置
  if (providers.length === 0) {
    return withCORS(errorResponse('未配置任何提供商，请检查 PROVIDERS 环境变量', 500, 'server_error'));
  }

  // 验证用户密钥
  const user = authenticateUser(request, userKeys);
  if (!user) {
    return withCORS(errorResponse('无效的 API Key，请检查 Authorization 头', 401, 'authentication_error'));
  }

  // 路由分发
  // GET /v1/models - 获取模型列表
  if (pathname === '/v1/models' && request.method === 'GET') {
    const response = await handleModelsRequest(providers);
    return withCORS(response);
  }

  // POST /v1/chat/completions - 对话补全
  if (pathname === '/v1/chat/completions' && request.method === 'POST') {
    const response = await handleChatCompletionsRequest(request, providers, user);
    return withCORS(response);
  }

  // 未匹配的路由
  return withCORS(errorResponse('未找到该端点', 404, 'not_found'));
}

// EdgeOne 边缘函数入口：使用 addEventListener 监听 fetch 事件
addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event));
});

import { Context } from 'hono'
import {
  getProviders,
  getProvider,
  addProvider,
  updateProvider,
  deleteProvider,
  getProxyKeys,
  addProxyKey,
  updateProxyKey,
  deleteProxyKey,
  getModelGroups,
  getModelGroup,
  saveModelGroup,
  deleteModelGroup,
  testProviderStatus,
  setProviderStatus,
} from './storage'
import { testModelConnection } from './proxy'
import { fetchOpenCodeModels, isOpenCodeProvider, resolveOpenCodeUrls, testOpenCodeModel } from './opencode'
import { PROXY_KEY_PREFIX, EXPIRY_OPTIONS, OPENCODE_DEFAULT_URL } from './config'
import type {
  Env,
  ApiResponse,
  Provider,
  CreateProviderRequest,
  UpdateProviderRequest,
  CreateProxyKeyRequest,
  TestModelRequest,
  ModelGroup,
} from './types'

// ===== 系统状态 =====

/**
 * 将 string[] 或正规对象数组统一转换为正规对象数组
 * 例: ["k1","k2"] → [{key:"k1",enabled:true},{key:"k2",enabled:true}]
 */
function normalizeArray<T>(
  items: unknown,
  mapFn: (val: string) => T
): T[] {
  if (!Array.isArray(items)) return []
  if (items.length === 0 || typeof items[0] === 'string') {
    return (items as string[]).map(mapFn)
  }
  return items as T[]
}

export async function handleStatus(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  const proxyKeys = await getProxyKeys(c.env)

  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0)
  const enabledModels = providers.reduce(
    (sum, p) => sum + p.models.filter((m) => m.enabled).length,
    0
  )

  return c.json<ApiResponse>({
    success: true,
    data: {
      providersCount: providers.length,
      enabledProvidersCount: providers.filter((p) => p.enabled).length,
      modelsCount: totalModels,
      enabledModelsCount: enabledModels,
      proxyKeysCount: proxyKeys.filter((k) => k.enabled).length,
      adminConfigured: !!(c.env.ADMIN_USERNAME && c.env.ADMIN_PASSWORD),
      baseUrl: new URL(c.req.url).origin,
    },
  })
}

// ===== 提供商 CRUD =====

export async function handleGetProviders(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  return c.json<ApiResponse<Provider[]>>({ success: true, data: providers })
}

export async function handleCreateProvider(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<CreateProviderRequest>()
  // opencode 未传地址时自动填充
  if (body.id === 'opencode' && !body.baseUrl) {
    body.baseUrl = OPENCODE_DEFAULT_URL
  }

  if (!body.id || !body.name || !body.baseUrl) {
    return c.json<ApiResponse>({ success: false, message: 'id、name、baseUrl 为必填项' }, 400)
  }

  const providers = await getProviders(c.env)
  if (providers.some((p) => p.id === body.id)) {
    return c.json<ApiResponse>({ success: false, message: `提供商 id "${body.id}" 已存在` }, 409)
  }

  const now = new Date().toISOString()
  const provider: Provider = {
    id: body.id,
    name: body.name,
    baseUrl: body.baseUrl.replace(/\/$/, ''),
    apiType: body.apiType || 'openai',
apiKeys: normalizeArray(body.apiKeys, (k) => ({ key: k, enabled: true })),
    models: body.models
      ? normalizeArray(body.models, (m) => ({ id: m, enabled: true }))
      : [],
    enabled: body.enabled !== undefined ? body.enabled : true,
    status: body.status || 'pending',
    createdAt: now,
    updatedAt: now,
  }

  await addProvider(c.env, provider)

  // 处理梯队分配
  if (body.groupId) {
    const group = await getModelGroup(c.env, body.groupId)
    if (group) {
      // 统一获取第一个模型 ID（兼容 string[] 和对象数组两种格式）
      const modelArray = body.models
        ? normalizeArray(body.models, (m) => (typeof m === 'string' ? m : m.id))
        : []
      const firstModel = modelArray[0]
      const firstModelId = typeof firstModel === 'string' ? firstModel : (firstModel && (firstModel as { id?: string }).id)
      const memberId = firstModelId ? `${body.id}/${firstModelId}` : null
      if (memberId) {
        if (body.tier === 'primary') {
          // 一梯队：直接加入指定 group 的 members
          if (!group.members.includes(memberId)) {
            group.members.push(memberId)
            await saveModelGroup(c.env, group)
          }
        } else if (body.tier === 'backup') {
          // 二梯队：加入对应 backup group 的 members
          // 自动推断 backup group ID：auto-task ↔ auto-task-backup（双向映射）
          const backupGroupId = body.groupId === 'auto-task' ? 'auto-task-backup' : (body.groupId === 'auto-task-backup' ? 'auto-task' : null)
          if (!backupGroupId) {
            // groupId 不是标准 group，跳过 backup 写入
            return c.json<ApiResponse>({ success: false, message: `不支持的 groupId "${body.groupId}" 与 tier=backup 组合` }, 400)
          }
          const backupGroup = await getModelGroup(c.env, backupGroupId)
          if (backupGroup) {
            if (!backupGroup.members.includes(memberId)) {
              backupGroup.members.push(memberId)
              await saveModelGroup(c.env, backupGroup)
            }
          }
        }
      }
    }
  }

  return c.json<ApiResponse<Provider>>({ success: true, data: provider }, 201)
}

export async function handleUpdateProvider(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<UpdateProviderRequest>()

  const updates: Partial<Provider> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.baseUrl !== undefined) updates.baseUrl = body.baseUrl.replace(/\/$/, '')
  if (body.apiType !== undefined) updates.apiType = body.apiType
if (body.apiKeys !== undefined) {
    updates.apiKeys = normalizeArray(body.apiKeys, (k) => ({ key: k, enabled: true }))
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled
  if (body.status !== undefined) updates.status = body.status
  if (body.statusReason !== undefined) updates.statusReason = body.statusReason
  if (body.models !== undefined) {
    updates.models = normalizeArray(body.models, (m) => ({ id: m, enabled: true }))
  }

  const updated = await updateProvider(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }

  return c.json<ApiResponse<Provider>>({ success: true, data: updated })
}

export async function handleDeleteProvider(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)

  // 先从所有 group 中清理引用，再删除 provider
  const groups = await getModelGroups(c.env)
  for (const group of groups) {
    const newMembers = group.members.filter((m) => {
      // 解析 member 引用，检查是否属于此 provider
      const memberToCheck = m.startsWith('group/') ? m.substring(6) : m
      const slashIdx = memberToCheck.indexOf('/')
      if (slashIdx === -1) return true
      const providerId = memberToCheck.substring(0, slashIdx)
      return providerId !== id
    })
    if (newMembers.length !== group.members.length) {
      group.members = newMembers
      await saveModelGroup(c.env, group)
    }
  }

  const deleted = await deleteProvider(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, message: '提供商已删除' })
}

export async function handleTestModel(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const { modelId } = await c.req.json<TestModelRequest>()

  if (!modelId) {
    return c.json<ApiResponse>({ success: false, message: 'modelId 为必填项' }, 400)
  }

  const provider = await getProvider(c.env, id)
  if (!provider) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }

  const modelConfig = provider.models.find((m) => m.id === modelId)
  if (!modelConfig) {
    return c.json<ApiResponse>({ success: false, message: `模型 "${modelId}" 不存在于提供商 "${provider.name}"` }, 404)
  }

  const enabledKeys = provider.apiKeys.filter(k => k.enabled)
  if (!isOpenCodeProvider(provider.id) && enabledKeys.length === 0) {
    return c.json<ApiResponse>({ success: false, message: '该提供商未配置可用的 API Key' }, 400)
  }

  const result = isOpenCodeProvider(provider.id)
    ? await testOpenCodeModel(provider.baseUrl, enabledKeys, modelId, resolveOpenCodeUrls(c.env))
    : await testModelConnection(provider.baseUrl, enabledKeys[0].key, modelId, provider.apiType)

  return c.json<ApiResponse>({
    success: true,
    data: result,
  })
}

// ===== Key / 模型连通性测试（通过服务端代理，避免 CORS） =====

function buildAuthHeaders(apiKey: string, apiType?: string): Record<string, string> {
  if (apiType === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  }
  return { 'Authorization': `Bearer ${apiKey}` }
}

export async function handleTestKeyNew(c: Context<{ Bindings: Env }>) {
  const { url, apiKey, apiType, providerId } = await c.req.json<{
    url: string
    apiKey: string
    apiType?: string
    providerId?: string
  }>()
  if (!url || (!apiKey && !(providerId && isOpenCodeProvider(providerId)))) {
    return c.json<ApiResponse>({ success: false, message: 'url 和 apiKey 为必填项' }, 400)
  }

  if (providerId && isOpenCodeProvider(providerId)) {
    // 没填 key 时检查是否配了镜像，避免迷惑性报错
    if (!apiKey) {
      const mirrors = resolveOpenCodeUrls(c.env)
      if (mirrors.length === 0) {
        return c.json<ApiResponse>({
          success: true,
          data: { success: false, statusCode: 0, message: '请先填写 API Key 或配置 OPENCODE_MIRRORS_URL 环境变量' },
        })
      }
    }
    const result = await fetchOpenCodeModels(url, [{ key: apiKey, enabled: true }], resolveOpenCodeUrls(c.env))
    return c.json<ApiResponse>({
      success: true,
      data: {
        success: result.success,
        statusCode: result.statusCode || 0,
        message: result.message,
        data: result.data,
      },
    })
  }

  const cleanBase = url.replace(/\/$/, '')
  try {
    const response = await fetch(`${cleanBase}/models`, {
      method: 'GET', headers: buildAuthHeaders(apiKey, apiType), signal: AbortSignal.timeout(15000),
    })

    let data: unknown = null
    if (response.ok) {
      try { data = await response.json() } catch { /* ignore */ }
    }

    return c.json<ApiResponse>({
      success: true,
      data: { success: response.ok, statusCode: response.status, data },
    })
  } catch (err) {
    return c.json<ApiResponse>({
      success: true,
      data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' },
    })
  }
}

export async function handleTestModelNew(c: Context<{ Bindings: Env }>) {
  const { url, apiKey, apiType, model, providerId } = await c.req.json<{
    url: string
    apiKey: string
    apiType?: string
    model: string
    providerId?: string
  }>()
  if (!url || !model || (!apiKey && !isOpenCodeProvider(providerId || ''))) {
    return c.json<ApiResponse>({ success: false, message: 'url、apiKey、model 为必填项' }, 400)
  }

  if (providerId && isOpenCodeProvider(providerId)) {
    const apiKeys = apiKey ? [{ key: apiKey, enabled: true }] : []
    const result = await testOpenCodeModel(url, apiKeys, model, resolveOpenCodeUrls(c.env))
    return c.json<ApiResponse>({
      success: true,
      data: { success: result.success, statusCode: result.statusCode || 0, message: result.message },
    })
  }

  const cleanBase = url.replace(/\/$/, '')
  const endpoint = apiType === 'anthropic' ? 'messages' : 'chat/completions'

  try {
    const response = await fetch(`${cleanBase}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(apiKey, apiType) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15000),
    })

    return c.json<ApiResponse>({
      success: true,
      data: { success: response.ok, statusCode: response.status },
    })
  } catch (err) {
    return c.json<ApiResponse>({
      success: true,
      data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' },
    })
  }
}

// ===== 转发 Key 管理 =====

export async function handleGetProxyKeys(c: Context<{ Bindings: Env }>) {
  const keys = await getProxyKeys(c.env)
  const maskedKeys = keys.map((k) => ({
    ...k,
    key: k.key.length > 12
      ? k.key.substring(0, 8) + '****' + k.key.substring(k.key.length - 4)
      : k.key,
  }))
  return c.json<ApiResponse>({ success: true, data: maskedKeys })
}

export async function handleCreateProxyKey(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<CreateProxyKeyRequest>()
  const id = crypto.randomUUID()
  const randomPart = crypto.randomUUID().replace(/-/g, '')
  const key = `${PROXY_KEY_PREFIX}${randomPart}`

  // 计算过期时间
  let expiresAt: string | null = null
  if (body.expiresIn && body.expiresIn !== 'forever') {
    const ttl = EXPIRY_OPTIONS[body.expiresIn]
    if (ttl) {
      expiresAt = new Date(Date.now() + ttl * 1000).toISOString()
    }
  }

  const proxyKey = {
    id,
    key,
    name: body.name || `Key-${new Date().toLocaleDateString()}`,
    enabled: true,
    createdAt: new Date().toISOString(),
    expiresAt,
  }

  await addProxyKey(c.env, proxyKey)
  return c.json<ApiResponse>({
    success: true,
    data: proxyKey,
    message: '请立即保存此 Key，关闭后将不再显示',
  }, 201)
}

export async function handleDeleteProxyKey(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = await deleteProxyKey(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '转发 Key 不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, message: '转发 Key 已删除' })
}

export async function handleUpdateProxyKey(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<{ enabled?: boolean }>()
  const updates: Partial<import('./types').ProxyKey> = {}
  if (body.enabled !== undefined) updates.enabled = body.enabled
  const updated = await updateProxyKey(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '转发 Key 不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, data: updated })
}

// ===== 模型组管理 =====

export async function handleGetModelGroups(c: Context<{ Bindings: Env }>) {
  const groups = await getModelGroups(c.env)
  return c.json<ApiResponse>({ success: true, data: groups })
}

export async function handleCreateModelGroup(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<Partial<ModelGroup>>()
  if (!body.id || !Array.isArray(body.members) || body.members.length === 0) {
    return c.json<ApiResponse>({ success: false, message: 'id 和 members（至少一个）为必填' }, 400)
  }
  const group: ModelGroup = {
    id: body.id,
    name: body.name || body.id,
    enabled: true,
    members: body.members,
  }
  await saveModelGroup(c.env, group)
  return c.json<ApiResponse>({ success: true, data: group, message: '模型组已创建' }, 201)
}

export async function handleUpdateModelGroup(c: Context<{ Bindings: Env }>) {
  const groupId = c.req.param('id')
  if (!groupId) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const existing = await getModelGroup(c.env, groupId)
  if (!existing) {
    return c.json<ApiResponse>({ success: false, message: '模型组不存在' }, 404)
  }
  const body = await c.req.json<Partial<ModelGroup>>()
  const updated: ModelGroup = { ...existing, ...body, id: existing.id }
  await saveModelGroup(c.env, updated)
  return c.json<ApiResponse>({ success: true, data: updated, message: '模型组已更新' })
}

export async function handleDeleteModelGroup(c: Context<{ Bindings: Env }>) {
  const groupId = c.req.param('id')
  if (!groupId) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const existing = await getModelGroup(c.env, groupId)
  if (!existing) {
    return c.json<ApiResponse>({ success: false, message: '模型组不存在' }, 404)
  }
  await deleteModelGroup(c.env, groupId)
  return c.json<ApiResponse>({ success: true, message: '模型组已删除' })
}

// ===== Provider 状态管理端点 =====

export async function handleTestProviderStatus(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) {
    return c.json({ error: { message: '缺少 provider id' } }, 400)
  }

  const result = await testProviderStatus(c.env, id)

  if (result.success) {
    await setProviderStatus(c.env, id, 'active', '验证通过')
    return c.json({
      success: true,
      data: { status: 'active', reason: '' },
      message: 'Provider 验证通过，状态已更新为 active',
    })
  } else {
    await setProviderStatus(c.env, id, 'pending', result.reason)
    return c.json({
      success: false,
      data: { status: 'pending', reason: result.reason },
      message: 'Provider 验证失败，保持 pending 状态',
    }, 400)
  }
}

export async function handleSetProviderStatus(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  const { status, reason } = await c.req.json()

  if (!id || !status) {
    return c.json({ error: { message: '缺少必要参数' } }, 400)
  }

  if (!['pending', 'active', 'disabled'].includes(status)) {
    return c.json({ error: { message: '无效的状态值' } }, 400)
  }

  const provider = await setProviderStatus(c.env, id, status, reason)
  if (!provider) {
    return c.json({ error: { message: 'Provider not found' } }, 404)
  }

  return c.json({
    success: true,
    data: provider,
    message: `Provider 状态已更新为 ${status}`,
  })
}

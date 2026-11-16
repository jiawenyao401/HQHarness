import { once } from 'node:events'
import { realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'

const prefix = '/papi/openapi'
const paths = {
  authorize: ['GET', '/oauth2/authorize'],
  token: ['POST', '/oauth2/access_token'],
  person: ['POST', '/api/hrm/restful/queryEmployee'],
  todo: ['POST', '/api/workflow/list/paService/v1/getToDoWorkflowRequestList'],
  detail: ['GET', '/api/fna/workflow/core/paService/v1/getWorkflowRequest']
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('Fixture request exceeds body limit')
    chunks.push(chunk)
  }
  if (!size) return {}
  // Preserve decimal OA identifiers above JavaScript's safe integer range.
  return JSON.parse(Buffer.concat(chunks).toString('utf8'), (_key, value, context) => (
    typeof value === 'number' ? context.source : value
  ))
}

export async function createHuaqingOaFixture(directory) {
  const root = await realpath(directory)
  const configPath = join(root, 'config.json')
  const profile = 'oa-test'
  const operatorId = '9007199254740993123'
  const operatorName = 'Synthetic Employee'
  const requestId = '9007199254740993999'
  const corpId = 'SYNTHETIC_CORP'
  const appKey = 'SYNTHETIC_KEY'
  const appSecret = 'SYNTHETIC_SECRET'
  const code = 'SYNTHETIC_CODE'
  const access = 'SYNTHETIC_ACCESS'
  const appKeyPath = join(root, 'oa-test.key')
  const appSecretPath = join(root, 'oa-test.secret')
  const masterKeyPath = join(root, 'oa-test.master-key')
  const requests = []

  async function handle(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1')
    const body = await readBody(request)
    const route = Object.keys(paths).find(name => url.pathname === prefix + paths[name][1])
    const operator = route === 'person' ? body.ids?.[0] : body.userid ?? url.searchParams.get('userid')
    const send = (status, payload = { errcode: 1 }) => {
      requests.push({ route, path: url.pathname, method: request.method, operator: operator ?? null, status })
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    if (!route || request.method !== paths[route][0]) return send(404)
    if (route === 'authorize') {
      if (url.searchParams.get('corpid') !== corpId || url.searchParams.get('response_type') !== 'code') return send(401)
      return send(200, { errcode: 0, code })
    }
    if (route === 'token') {
      if (body.app_key !== appKey || body.app_secret !== appSecret || body.code !== code || body.grant_type !== 'authorization_code') return send(401)
      return send(200, { errcode: 0, accessToken: access, refreshToken: 'SYNTHETIC_REFRESH', expires_in: 7200 })
    }
    if (url.searchParams.get('access_token') !== access) return send(401)
    if (route === 'person') {
      const matched = operator === operatorId || body.nameLikeList?.includes(operatorName)
      const current = Number(body.current ?? 1)
      const rows = matched && current === 1 ? [{ id: operatorId, user_id: '99', username: operatorName }] : []
      return send(200, { errcode: 0, data: { current, pageSize: Number(body.pageSize ?? 100), total: matched ? 1 : 0, data: rows } })
    }
    if (operator !== operatorId) return send(403)
    if (route === 'todo') {
      const items = Number(body.pageNo ?? 1) === 1 ? [{ requestid: JSON.rawJSON(requestId), requestname: 'Synthetic expense draft', workflowid: 17 }] : []
      return send(200, { errcode: 0, data: items })
    }
    if (url.searchParams.get('requestId') !== requestId) return send(404)
    return send(200, { errcode: 0, data: { workflowBaseInfo: {
      requestId: JSON.rawJSON(requestId), workflowId: 17, requestName: 'Synthetic expense draft', flowStatus: { code: 0, desc: 'Draft' }
    } } })
  }

  const server = createServer({ requestTimeout: 5_000, headersTimeout: 5_000 }, (request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500).end()
      else response.destroy()
    })
  })
  function close() {
    const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections()
    return stopped
  }

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const config = {
      schemaVersion: 1,
      defaultProfile: profile,
      profiles: { [profile]: { connections: { oa: profile } } },
      connections: { [profile]: {
        provider: 'oa', environment: 'test', baseUrl: `http://127.0.0.1:${server.address().port}${prefix}`,
        tenantKey: 'synthetic-tenant', corpId, operatorId,
        appKeyRef: `file:${appKeyPath}`, appSecretRef: `file:${appSecretPath}`
      } }
    }
    const privateFile = { flag: 'wx', mode: 0o600 }
    await writeFile(appKeyPath, appKey, privateFile)
    await writeFile(appSecretPath, appSecret, privateFile)
    await writeFile(masterKeyPath, Buffer.alloc(32, 119).toString('base64'), privateFile)
    await writeFile(configPath, JSON.stringify(config), privateFile)
    const env = {
      HUAQING_CONFIG_HOME: root,
      HUAQING_PROFILE: profile,
      HUAQING_STATE_HOME: join(root, 'state'),
      HUAQING_CREDENTIAL_STORE: 'encrypted-file',
      HUAQING_CREDENTIAL_MASTER_KEY: undefined,
      HUAQING_CREDENTIAL_MASTER_KEY_FILE: masterKeyPath
    }
    return { configPath, env, profile, operatorId, operatorName, requestId, requests, close }
  } catch (error) {
    await close()
    throw error
  }
}

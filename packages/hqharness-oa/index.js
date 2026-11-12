import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { parse } from 'yaml'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { markTrustedOaDefinition, OA_TOOL_NAME } from 'hqharness-automation/oa-routing'

export const name = 'hqharness-oa'
export const inject = ['tools', 'skills', 'systemPrompt', 'agents']

const INPUT_FIELDS = {
  'oa-travel-expense': 'travelerName, reason, destination, dateStart, dateEnd, days (one record per date), payment; optional applicationDate, subsidy, title.',
  'oa-home-travel-expense': 'travelerName, reason, trips, payment; optional applicationDate, title.',
  'oa-business-travel-application': 'apply_date, reason, entries (start_date, end_date, headcount, city); optional trip_days, itinerary, companions, request_name, security_level. Use real city names with province if needed.',
  'oa-reception-expense': 'travelerName, reason, payment, lines (the executor can construct a single line from one valid invoice); optional applicationDate, title. For multiple invoices, each line needs a distinct materialIndex pointing to the 1-based position in the submitted materials array.'
}
const WORKFLOWS = Object.keys(INPUT_FIELDS)
const REVISION_FIELDS = {
  'oa-travel-expense': '收款信息 payment（payee、bank、account）',
  'oa-home-travel-expense': '收款信息 payment（payee、bank、account）或居住地 home',
  'oa-business-travel-application': '指定行程段的目的地 city（index 从 1 开始、name 为城市名）',
  'oa-reception-expense': '收款信息 payment（payee、bank、account）'
}
const referenceName = /^[a-z0-9][a-z0-9-]*\.(?:md|json)$/u
const ordinaryFileMention = /(?:^|\s)@(?:"[^"\r\n]+\.(?:pdf|jpe?g|png|ofd|xml|docx|xlsx|txt)"|[^\s"]+\.(?:pdf|jpe?g|png|ofd|xml|docx|xlsx|txt)(?=\s|$))/iu

function desktopInstructions(workflow, references) {
  return `## 华擎桌面客户端执行

当前接入 OA TEST。在「设置 → 内置插件 → OA 业务」配置并核验操作人；凭据只能在设置中输入。

1. 调用 ${OA_TOOL_NAME}，workflow 使用 \`${workflow}\`。action=reference 可读取此技能的参考。需要的 intake 字段为 ${INPUT_FIELDS[workflow]}
2. 请用户通过「添加 OA 原件」提供需要使用的文件。用 action=check 离线核对 intake 和原件文字。materials 按本批原件的顺序填写（index 从 1 开始），kind 为 invoice 或 attachment。check 未指定 materials 时读取整批原件。会话中先前发送的原件若还未用本技能核对，须先 check 再保存。核对整批后会返回 originalsReceipt 和带序号的文件名。在本会话补齐文字信息后，使用同一 workflow 和这份 originalsReceipt 继续核对或保存；保存时必须按序号逐件分类。新发送的原件替换旧批次，应用重启后需重新附加并核对。发票、人员、金额与收款信息必须有可核实来源，缺项直接反馈。
3. 仅在用户要求办理草稿时，以同一 workflow 及已核对的 intake 和材料分类调用 action=draft。桌面会显示 OA TEST 草稿确认。操作人、环境、远端表单 ID、已有草稿编号、附件路径均由客户端控制。
4. 只有 ok、verified、oaSaved 均为 true 且返回 requestId 才报告已保存。用户明确要求补写本会话原未提交草稿时，用 action=revise 传入当前用户明确提供的 ${REVISION_FIELDS[workflow]}，由用户在桌面弹窗复核具体值。补写使用原草稿与原件，不传新附件或单号。
5. 结果不明时只使用 action=readback 核验同一草稿，停止重复写入。办理另一张同类草稿时开启新会话。OA 草稿不会流转审批。

把事实依据和额外备注记录在会话中。sourceEvidence 和 specialInstructions 不传入 intake。${workflow === 'oa-home-travel-expense'
    ? '报销人、居住城市或收款信息有多个冲突候选时，请用户说明准确值及依据，并把冲突留为待确认。不能根据操作人推断报销人，也不能复用未经确认的收款信息。' : ''}

可读取的参考文件为 ${references.join('、')}。本节为桌面端调用方式；参考中的终端、Hermes、MCP 入口仅用于理解业务规则。不得用其他工具重放 OA 写操作。
`
}

async function readReferences(root, prefix = '') {
  return (await readdir(root, { withFileTypes: true }))
    .filter(file => file.isFile() && referenceName.test(file.name))
    .map(file => [`${prefix}${file.name}`, join(root, file.name)])
    .sort(([left], [right]) => left.localeCompare(right))
}

async function skillCatalog(root) {
  const shared = ['oa-shared', 'oa-expense-common', 'oa-invoice', 'oa-person', 'oa-workflow']
  const common = (await Promise.all(shared.map(async skill => {
    const dir = join(root, 'common', skill)
    return [[`common/${skill}/SKILL.md`, join(dir, 'SKILL.md')],
      ...await readReferences(join(dir, 'references'), `common/${skill}/references/`)]
  }))).flat()
  const catalog = await Promise.all(WORKFLOWS.map(async workflow => {
    const directory = join(root, 'oa', workflow)
    const markdown = await readFile(join(directory, 'SKILL.md'), 'utf8')
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/u.exec(markdown)
    const meta = match && parse(match[1])
    const start = match?.[2].indexOf('## 执行步骤')
    const end = start === undefined || start < 0 ? -1 : match[2].indexOf('\n## ', start + 8)
    if (meta?.name !== workflow || typeof meta.description !== 'string' || end < 0) {
      throw new Error(`Invalid packaged xasp skill ${workflow}`)
    }
    const files = await readReferences(join(directory, 'references'))
    const title = match[2].split(/\r?\n/u).find(line => line.startsWith('# '))
    return {
      candidate: {
        name: workflow, description: meta.description, provider: name, source: 'bundled', rank: BUNDLED_SKILL_RANK,
        invocation: { modelInvocable: true, userInvocable: true }, locator: workflow,
        resourceBase: { kind: 'directory', path: directory }
      },
      references: new Map([...files, ...common]),
      content: `${title ?? `# ${workflow}`}\n\n${desktopInstructions(workflow, [
        ...files.map(([key]) => key), ...shared.map(skill => `common/${skill}/SKILL.md`)
      ])}${match[2].slice(end)}`
    }
  }))
  return new Map(catalog.map(entry => [entry.candidate.name, entry]))
}

function selectMaterials(args, attachments) {
  const requested = args.materials ?? (args.action === 'check' ? attachments.map((_file, index) => ({ index: index + 1, kind: 'attachment' })) : [])
  return requested.map(item => {
    const attachment = attachments[item.index - 1]
    if (!attachment) throw new HarnessError('Use a file index from the active OA originals batch.', 'OA_ATTACHMENT_REQUIRED')
    const { attachmentId, name, bytes } = attachment
    return { attachmentId, name, bytes, kind: item.kind }
  })
}

function describeOriginals(batch, receipt) {
  return {
    originalsReceipt: receipt,
    originals: batch.attachments.map(({ name, bytes }, index) => ({ index: index + 1, name, bytes }))
  }
}

function desktopTransport() {
  const endpoint = process.env.HQHARNESS_OA_URL
  const token = process.env.HQHARNESS_OA_TOKEN
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/operation$/u.test(endpoint ?? '') || !/^[a-f0-9]{64}$/u.test(token ?? '')) return
  return async (operation, signal) => {
    try {
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(operation)
      })
      const result = await response.json()
      if (response.ok && typeof result?.ok === 'boolean') return result
    } catch {
      // Cancellation and transport failures may race a remote save.
    }
    throw new HarnessError('Check the existing draft before any retry.',
      operation.operation === 'draft' || operation.operation === 'revise' ? 'OA_UNKNOWN_OUTCOME' : 'OA_NOT_CONNECTED')
  }
}

export function createOaPlugin(transport = desktopTransport) {
  return { name, inject, async apply(ctx, config) {
    const request = transport()
    if (!request || typeof config?.resources !== 'string' || !isAbsolute(config.resources)) return
    const catalog = await skillCatalog(join(config.resources, 'xasp', 'skill'))
    ctx.skills.registerProvider(() => ({
      name,
      list: async () => [...catalog.values()].map(entry => entry.candidate),
      get: async selected => {
        const entry = catalog.get(selected.locator)
        if (entry) return { ...entry.candidate, content: entry.content }
      }
    }))
    const current = new WeakMap()
    const originals = new WeakMap()
    ctx.on('agent/pre-step', ({ agent, turn }, next) => {
      if (current.get(agent)?.turn !== turn) current.delete(agent)
      return next()
    })
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      if (message?.role !== 'user' || message.source?.kind !== 'user') return
      const previous = current.get(agent)
      const sameTurn = previous?.turn === turn
      const attachments = message.content.filter(block => block.type === 'file').map(block => block.attachment)
      const unsupported = message.content.some(block => block.type === 'image' || (block.type === 'text' && ordinaryFileMention.test(block.text)))
      let batch = sameTurn ? previous.batch : undefined
      if (attachments.length || unsupported) {
        // A newly attached batch replaces the previous batch in this conversation,
        // including unsupported attachments that must never fall back to old files.
        batch = { attachments, unsupported, checked: new Map() }
        originals.set(agent, batch)
      }
      current.set(agent, {
        turn, batch, attempted: sameTurn && previous.attempted
      })
    })
    ctx.on('agent/disposed', ({ agent }) => {
      current.delete(agent)
      originals.delete(agent)
    })
    const definition = defineTool({
      name: OA_TOOL_NAME,
      description: 'Work with an in-box xasp OA TEST business skill. Check facts and attachments, save a draft, revise supported fields on the existing draft with desktop confirmation, or read back the draft. Load the matching skill first.',
      parameters: {
        workflow: { type: 'string', enum: WORKFLOWS, required: true },
        action: { type: 'string', enum: ['instructions', 'reference', 'check', 'draft', 'revise', 'readback'], required: true },
        reference: { type: 'string', description: 'Exact reference filename listed in the skill. Only used with reference.' },
        intake: { type: 'json', description: 'Business facts using the selected skill’s intake fields. For revise, supply only the explicitly requested changes listed in the skill. Exclude remote identifiers.' },
        originalsReceipt: { type: 'string', description: 'Receipt returned by a full check of the same workflow’s original files. Required to reuse an earlier message’s checked files in a later user turn. Omit for newly attached files, revise and readback.' },
        materials: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          index: { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7, 8], required: true },
          kind: { type: 'string', enum: ['invoice', 'attachment'], required: true }
        } }, description: 'Classify OA originals by their 1-based position in the active batch. Draft requires every original exactly once.' }
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      timeoutMs: 245_000,
      presentCall: args => ({ card: 'generic', kind: args.action === 'draft' || args.action === 'revise' ? 'execute' : 'read',
        title: `OA · ${args.workflow} · ${args.action}` }),
      async execute(args, exec) {
        const entry = catalog.get(args.workflow)
        if (args.action === 'instructions') return { ok: true, content: entry.content }
        if (args.action === 'reference') {
          const path = entry.references.get(args.reference)
          if (!path) return { ok: false, code: 'OA_REFERENCE_NOT_FOUND', references: [...entry.references.keys()] }
          const bytes = await readFile(path, { signal: exec.signal })
          if (bytes.length > 128 * 1024) return { ok: false, code: 'OA_REFERENCE_TOO_LARGE' }
          return { ok: true, reference: args.reference, content: bytes.toString('utf8') }
        }
        const session = exec.agent?.session?.header
        if (!session?.id || session.origin === 'subagent') throw new HarnessError('OA requires the owning user conversation.', 'OA_SESSION_REQUIRED')
        const dispatch = (intake, materials) => request({
          workflow: args.workflow, operation: args.action, sessionId: session.id, intake, materials
        }, exec.signal)
        if (args.action === 'readback') return dispatch({}, [])

        const state = current.get(exec.agent)
        const writesDraft = args.action === 'draft' || args.action === 'revise'
        if (writesDraft && (!state || state.attempted)) return { ok: false, code: 'OA_NEW_USER_TURN_REQUIRED' }
        if (args.action === 'revise') {
          if (state.batch || args.materials?.length || args.originalsReceipt !== undefined) {
            return { ok: false, code: 'OA_REVISION_REQUIRES_ORIGINAL_DRAFT' }
          }
          state.attempted = true
          return dispatch(args.intake ?? {}, [])
        }

        const batch = originals.get(exec.agent)
        if (batch?.unsupported) return { ok: false, code: 'OA_ORIGINALS_REQUIRED' }
        const fresh = batch && state?.batch === batch
        const receipt = batch?.checked.get(args.workflow)
        if (args.originalsReceipt !== undefined && args.originalsReceipt !== receipt) {
          return { ok: false, code: 'OA_ORIGINALS_CHANGED' }
        }
        if (!fresh && receipt && args.originalsReceipt === undefined) {
          return { ok: false, code: 'OA_ORIGINALS_RECEIPT_REQUIRED', ...describeOriginals(batch, receipt) }
        }
        if (!fresh && batch && !receipt && args.action === 'draft') {
          return { ok: false, code: 'OA_ORIGINALS_CHECK_REQUIRED' }
        }

        const attachments = batch?.attachments ?? []
        if (args.action === 'draft') {
          if (new Set(args.materials?.map(item => item.index)).size !== attachments.length
            || (args.materials?.length ?? 0) !== attachments.length) return { ok: false, code: 'OA_CLASSIFY_ATTACHMENTS' }
          const materials = selectMaterials(args, attachments)
          state.attempted = true
          return dispatch(args.intake ?? {}, materials)
        }

        const materials = selectMaterials(args, attachments)
        if (!materials.length) return dispatch(args.intake ?? {}, materials)
        if (receipt === undefined) batch.checked.set(args.workflow, null)
        const result = await dispatch(args.intake ?? {}, materials)
        if (exec.signal.aborted || originals.get(exec.agent) !== batch
          || !Array.isArray(result.materials) || result.materials.length !== attachments.length
          || new Set(materials.map(material => material.attachmentId)).size !== attachments.length) return result
        const reviewed = batch.checked.get(args.workflow) ?? randomUUID()
        batch.checked.set(args.workflow, reviewed)
        return { ...result, ...describeOriginals(batch, reviewed) }
      }
    })
    ctx.tools.register(definition)
    ctx.effect(() => markTrustedOaDefinition(definition), 'hqharness-oa.trusted-definition')
    ctx.systemPrompt.section({ name: 'hqharness:oa', order: 119, text:
      `For xasp OA TEST business requests, load the matching bundled skill and use ${OA_TOOL_NAME}. In PTC mode load its instructions through a strict JSON call: return await tools.${OA_TOOL_NAME}({"action":"instructions","workflow":"oa-travel-expense"});. For OA_ORIGINALS_REQUIRED or OA_ORIGINALS_CHANGED, ask the user to attach files via Attach OA originals. For OA_ORIGINALS_CHECK_REQUIRED, check the retained originals in this workflow before saving. For OA_ORIGINALS_RECEIPT_REQUIRED, use the returned receipt only when the user is continuing the same materials and workflow. Credentials are entered only in Desktop settings. Respect an explicit GUI-only instruction. Use revise only for explicit, supported changes to the same draft. Use readback for unknown writes. A refused or unconfirmed save must never be repeated with another tool. Never describe a draft as submitted.` })
  } }
}

export async function apply(ctx, config) { return createOaPlugin().apply(ctx, config) }

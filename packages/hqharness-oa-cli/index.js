import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { markTrustedOaDefinition, OA_ROUTING_TOOL_NAME } from 'hqharness-automation/oa-routing'
import { scopeMaterials } from './materials.js'

export const name = 'hqharness-oa-cli'
export const inject = ['tools', 'skills', 'sandboxPolicy', 'systemPrompt']

const DISCOVERY = new Set(['system.info', 'system.doctor', 'profile.list', 'profile.show'])
const AUTH = new Set(['auth.status', 'auth.login', 'auth.logout'])
const RECOVERY = new Set(['operations.prepare', 'operations.apply', 'operations.status', 'operations.reconcile'])
const OFFLINE = new Set(['oa.file.inspect', 'oa.invoice.materials.check', 'oa.expense.materials.check', 'oa.city.search'])
// Approve new capabilities when updating the pinned CLI. A new upstream
// command can otherwise widen the model's local file and remote write scope.
const OA = new Set([
  ...OFFLINE,
  'oa.auth.code.issue', 'oa.auth.token', 'oa.auth.refresh',
  'oa.identity.show', 'oa.identity.verify', 'oa.person.resolve',
  'oa.file.info', 'oa.file.download', 'oa.file.upload',
  'oa.invoice.inspect', 'oa.invoice.match', 'oa.invoice.query', 'oa.invoice.recognize', 'oa.invoice.upload',
  'oa.workflow.todo', 'oa.workflow.todo.count', 'oa.workflow.detail', 'oa.workflow.request.get',
  'oa.workflow.form.info', 'oa.workflow.form.resolve', 'oa.workflow.form.fill', 'oa.workflow.search', 'oa.workflow.fields',
  'oa.workflow.draft.create', 'oa.workflow.travel.application.draft', 'oa.workflow.submit',
  'oa.expense.draft', 'oa.expense.home.draft', 'oa.expense.inspect', 'oa.expense.amend',
  'oa.expense.invoice.preflight', 'oa.expense.invoice.save', 'oa.expense.invoice.link', 'oa.expense.invoice.verify',
  'oa.expense.payment.fill', 'oa.expense.complete'
])
const MUTATING = new Set(['remote-write', 'local-file-write', 'auth-session-write'])
const META = new Set(['commands.list', 'schema', 'skill.reference'])
const PROFILE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u
const SKILL_NAME = /^(?:huaqing-shared|oa-[a-z0-9-]+)$/u
const REFERENCE_FILE = /^(?:SKILL\.md|references\/[a-zA-Z0-9_-]+\.md)$/u
const DEFAULT_TIMEOUT = 30_000
const MAX_CLI_TIMEOUT = 300_000

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const needsApproval = operation => operation.effects.some(effect => MUTATING.has(effect))
const denied = (message, code = 'HUAQING_OA_INVALID_INPUT') => new HarnessError(message, code)

function operationCatalog(source) {
  if (source?.schemaVersion !== 1 || !Array.isArray(source.operations)) throw new Error('hqharness-oa-cli: unsupported command catalog')
  const index = new Map()
  for (const operation of source.operations) {
    if (typeof operation?.id !== 'string' || operation.availability !== 'implemented') continue
    const { id } = operation
    if (!OA.has(id) && !DISCOVERY.has(id) && !AUTH.has(id) && !RECOVERY.has(id)) continue
    if (!Array.isArray(operation.effects) || typeof operation.description !== 'string'
      || !record(operation.inputSchema) || !record(operation.outputSchema) || index.has(id)) {
      throw new Error(`hqharness-oa-cli: invalid command catalog entry ${id}`)
    }
    index.set(id, operation)
  }
  const missing = [...DISCOVERY, ...OA, ...AUTH, ...RECOVERY].filter(id => !index.has(id))
  if (missing.length) throw new Error(`hqharness-oa-cli: required OA commands are missing: ${missing.join(', ')}`)
  return index
}

function resolveOperation(catalog, operation) {
  const entry = catalog.get(operation)
  if (!entry) throw denied('Use commands.list and schema to find an operation supported by this OA integration.', 'HUAQING_OA_OPERATION_UNAVAILABLE')
  return entry
}

async function ask(ctx, exec, profile, command, input, signal) {
  const approver = ctx.get('approval')
  if (!exec.agent || !approver) throw denied('OA writes require approval in an active desktop conversation.', 'HUAQING_OA_APPROVAL_UNAVAILABLE')
  const target = [input.targetRequestId, input.requestId, input.executionId].find(value =>
    typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/u.test(value))
  const reference = target ? ` · ${target}` : ''
  const outcome = await approver.request({
    agent: exec.agent,
    toolName: exec.name,
    callId: exec.callId,
    reason: `Huaqing OA: ${command.id} (profile ${profile})${reference}`,
    displayReason: {
      en: `Allow this OA operation for profile ${profile}${reference}? ${command.description}`,
      zh: `是否允许在 OA 配置 ${profile} 中执行 ${command.id}${reference}？`
    },
    signal
  })
  if (outcome !== 'allowed-once') throw denied('The OA operation did not receive approval. Stop this action and wait for a new user instruction.', 'HUAQING_OA_APPROVAL_REQUIRED')
  signal.throwIfAborted()
}

async function skillReference(skillRoot, input, signal) {
  const { name, file } = input
  if (typeof name !== 'string' || !SKILL_NAME.test(name) || typeof file !== 'string' || !REFERENCE_FILE.test(file)) {
    throw denied('Provide an installed OA Skill name and SKILL.md or a references/<name>.md path.')
  }
  const path = join(skillRoot, name, file)
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > 256 * 1024) throw new Error('invalid reference')
    return { name, file, content: await readFile(path, { encoding: 'utf8', signal }) }
  } catch {
    signal?.throwIfAborted()
    throw denied('The reference was not found in the installed OA Skill. Use its linked references.', 'HUAQING_OA_REFERENCE_UNAVAILABLE')
  }
}

function resolveProfile(args, requiresProfile) {
  const profile = args.profile ?? process.env.HUAQING_PROFILE
  if (profile !== undefined && !PROFILE.test(profile)) throw denied('Use a valid configured OA profile name.')
  if (requiresProfile && !profile) {
    throw denied('Select a configured OA profile from profile.list and use it throughout the task and its recovery.', 'HUAQING_OA_PROFILE_REQUIRED')
  }
  return profile
}

function childEnvironment() {
  // Account references can name arbitrary configured variables. Preserve
  // those while preventing inherited loader options from replacing code in
  // the pinned CLI, including case-insensitive environment keys on Windows.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:NODE_OPTIONS$|NODE_PATH$|NAPI_RS_|DYLD_|LD_PRELOAD$|LD_LIBRARY_PATH$)/iu.test(key)))
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

/** Install-owned CLI process and the catalog from that exact distribution. */
function oaTool(ctx, { catalog, runOperation, cliPath, skillRoot }) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'hqharness-oa-cli.calls')
  return defineTool({
    name: OA_ROUTING_TOOL_NAME,
    description: 'Use the built-in Huaqing CLI for OA expense reports and OA workflow tasks. Load the relevant OA Skill first. Use commands.list to discover operations, schema with input.operation for the current business schema, and skill.reference with input.name and input.file to load linked Skill references. For OA calls provide the confirmed profile, business input, and the required execution fields. A write also needs approval in the desktop. On interruption or an unknown outcome use the same profile and original execution ID or idempotency key to check status.',
    parameters: {
      operation: { type: 'string', required: true, description: 'OA operation ID or commands.list, schema, or skill.reference.' },
      input: { type: 'object', required: true, additionalProperties: true, description: 'The JSON input declared by the installed command schema.' },
      profile: { type: 'string', description: 'Explicit OA CLI profile for this task and recovery. Use profile.list to discover profiles.' },
      execution: { type: 'object', additionalProperties: false, properties: {
        confirm: { type: 'boolean', const: true },
        dryRun: { type: 'boolean', const: true },
        idempotencyKey: { type: 'string' }
      } },
      timeoutMs: { type: 'integer', description: 'CLI timeout in milliseconds from 1 to 300000.' }
    },
    output: { schema: { type: 'json' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    timeoutMs: MAX_CLI_TIMEOUT + 30_000,
    isConcurrencySafe: () => false,
    presentCall: args => ({
      card: 'generic',
      kind: typeof args.operation === 'string' && catalog.has(args.operation) && needsApproval(catalog.get(args.operation)) ? 'execute' : 'read',
      title: `Huaqing OA · ${args.operation}`,
      rawInput: args.operation
    }),
    async execute(args, exec) {
      const signal = AbortSignal.any(exec.signal ? [lifetime.signal, exec.signal] : [lifetime.signal])
      signal.throwIfAborted()
      const { operation, execution, timeoutMs = DEFAULT_TIMEOUT } = args
      if (timeoutMs < 1 || timeoutMs > MAX_CLI_TIMEOUT) throw denied('Use a timeout from 1 to 300000 milliseconds.')
      if (META.has(operation)) {
        if (operation === 'commands.list') return { operations: Array.from(catalog.values(), ({ id, description, effects }) => ({ id, description, effects })) }
        if (operation === 'schema') return resolveOperation(catalog, args.input.operation)
        return skillReference(skillRoot, args.input, signal)
      }

      let command = resolveOperation(catalog, operation)
      const profile = resolveProfile(args, (!DISCOVERY.has(operation) && !OFFLINE.has(operation))
        || (operation === 'system.doctor' && args.input.live === true))
      const common = { cliPath, profile, timeoutMs, signal, env: childEnvironment() }
      let input = AUTH.has(operation) ? { ...args.input, provider: 'oa' } : args.input
      if (AUTH.has(operation) && Object.hasOwn(args.input, 'provider') && args.input.provider !== 'oa') throw denied('Only the OA authentication provider is available here.')
      if (operation === 'profile.show' && profile && Object.hasOwn(input, 'name') && input.name !== profile) throw denied('Select one OA profile for this call.')

      if (operation === 'operations.prepare') {
        if (!OA.has(input.operation) || !resolveOperation(catalog, input.operation).effects.includes('remote-write')) {
          throw denied('Prepare requires a supported OA write.')
        }
      }
      if (RECOVERY.has(operation) && Object.hasOwn(input, 'input')) {
        // The pinned CLI uses a flat input object for tracked writes.
        throw denied('Pass original business fields alongside operation or executionId. Check the installed operation schema.')
      }
      if (operation === 'operations.apply' || operation === 'operations.reconcile') {
        if (typeof input.executionId !== 'string') throw denied('Provide the original execution ID.')
        const status = await runOperation({ ...common, operation: 'operations.status', input: { executionId: input.executionId } })
        if (status.issue !== null || !status.envelope?.ok) return status
        command = resolveOperation(catalog, status.envelope.data?.operation)
        if (!OA.has(command.id) || !command.effects.includes('remote-write')) throw denied('The execution does not belong to a supported OA write.')
      }
      const dryRun = OA.has(operation) && command.effects.includes('remote-write') && execution?.dryRun === true
      const approval = needsApproval(command) && operation !== 'operations.reconcile' && !dryRun
      const localWrite = command.effects.includes('local-file-write')
      input = await scopeMaterials(ctx, exec, input, localWrite)
      if (approval) {
        // The CLI validates write confirmation and idempotency. A model-supplied
        // flag never grants desktop approval for a real operation.
        if (command.effects.includes('remote-write') && execution?.confirm !== true) throw denied('Use execution.confirm after confirming this OA write with the user.', 'HUAQING_OA_CONFIRMATION_REQUIRED')
        await ask(ctx, exec, profile, command, input, signal)
        input = await scopeMaterials(ctx, exec, input, localWrite)
      }
      return runOperation({ ...common, operation, input, execution })
    }
  })
}

export async function apply(ctx, config) {
  const root = config?.resources
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('hqharness-oa-cli: absolute installation resources are required')
  const cliPath = join(root, 'dist', 'cli.js')
  const skillRoot = join(root, 'oa-skills')
  let catalog
  let runOperation
  try {
    const [entry, skill, source, adapter] = await Promise.all([
      stat(cliPath),
      stat(join(skillRoot, 'oa-workflow-expense', 'SKILL.md')),
      readFile(join(root, 'docs', 'generated', 'command-catalog.json'), 'utf8'),
      import(pathToFileURL(join(root, 'examples', 'node-process.mjs')).href)
    ])
    if (!entry.isFile() || !skill.isFile() || typeof adapter.runOperation !== 'function') throw new Error('invalid CLI, Skill or process adapter')
    catalog = operationCatalog(JSON.parse(source))
    runOperation = adapter.runOperation
  } catch (cause) {
    // Keep the core Desktop usable if its optional OA payload is damaged.
    // The release verifier independently treats an incomplete payload as fatal.
    ctx.logger.error('hqharness-oa-cli: installed capability unavailable: %s', cause instanceof Error ? cause.message : String(cause))
    return
  }

  await ctx.plugin(skillFilesystem, {
    providerName: 'huaqing-oa',
    includeDefaultRoots: false,
    bundledSkillDir: skillRoot,
    watch: false,
    watchFollowSymlinks: false
  })
  const definition = oaTool(ctx, { catalog, runOperation, cliPath, skillRoot })
  ctx.tools.register(definition)
  ctx.effect(() => markTrustedOaDefinition(definition), 'hqharness-oa-cli.trusted-definition')
  ctx.systemPrompt.section({
    name: 'huaqing:oa',
    order: 119,
    text: 'For OA reimbursement, load oa-workflow-expense. Use the built-in huaqing_oa tool for the installed CLI, schema discovery and Skill references. In PTC mode, use one strict JSON call, for example return await tools.huaqing_oa({"operation":"skill.reference","input":{"name":"oa-workflow-expense","file":"SKILL.md"}});. For configuration, use system.doctor with empty input and profile.list. Keep using the same explicit OA profile for one task and its recovery. Use the exact absolute paths of materials in this workspace or files uploaded by the user to this conversation. Follow the approval and recovery steps in the OA Skill.'
  })
}

const trusted = new WeakSet()

export const OA_TOOL_NAME = 'oa_business'

export function markTrustedOaDefinition(definition) {
  if (definition?.name !== OA_TOOL_NAME) throw new TypeError('The built-in OA tool definition is required')
  trusted.add(definition)
  return () => trusted.delete(definition)
}

export function isTrustedOaExecution(tools, exec) {
  const definition = tools?.get?.(exec.name, exec.agent)
  return Boolean(definition?.name === OA_TOOL_NAME && trusted.has(definition))
}

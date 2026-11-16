// The GUI guard admits only the installed OA definition, including inside PTC.
const trusted = new WeakSet()
export const OA_ROUTING_TOOL_NAME = 'huaqing_oa'

export function markTrustedOaDefinition(definition) {
  if (definition.name !== OA_ROUTING_TOOL_NAME || trusted.has(definition)) throw new Error('Invalid built-in OA tool registration')
  trusted.add(definition)
  return () => trusted.delete(definition)
}

export function isTrustedOaExecution(tools, exec) {
  const definition = tools?.get?.(exec.name, exec.agent)
  return definition?.name === OA_ROUTING_TOOL_NAME && trusted.has(definition)
}

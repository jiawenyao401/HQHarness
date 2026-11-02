// Trust is tied to the definition installed by the built-in WPS plugin, not to
// a namespace/description which a Profile tool can copy or shadow.
const trusted = new WeakSet()
export const WPS_ROUTING_TOOL_NAME = 'mcp__huaqing_wps__wps_use'
export function markTrustedWpsDefinition(definition) {
  if (!definition || typeof definition !== 'object' || definition.name !== WPS_ROUTING_TOOL_NAME) throw new TypeError('The built-in WPS tool definition is required')
  if (trusted.has(definition)) throw new Error('WPS definition is already registered')
  trusted.add(definition)
  return () => trusted.delete(definition)
}
export function isTrustedWpsExecution(tools, exec) {
  const definition = tools?.get?.(exec.name, exec.agent)
  return Boolean(definition && definition.name === exec.name && trusted.has(definition))
}

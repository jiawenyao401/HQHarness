import { homedir } from 'node:os'
import { join } from 'node:path'

/** Only a local capability is passed to Harness; model vendor keys remain in Switch. */
export function huaqingSwitchEnvironment(
  homeDirectory: string = homedir(),
): NodeJS.ProcessEnv {
  return {
    HQHARNESS_MODEL_SOURCE: 'huaqing-switch',
    HUAQING_SWITCH_CONNECTOR_PATH: join(
      homeDirectory,
      '.huaqing-switch',
      'connector.json',
    ),
  }
}

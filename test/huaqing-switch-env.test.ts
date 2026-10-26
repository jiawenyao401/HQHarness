import { join } from 'node:path'
import { expect, it } from 'vitest'
import { huaqingSwitchEnvironment } from '../src/main/huaqing-switch'

it('passes only the local Switch discovery location and deployment mode to Harness', () => {
  expect(huaqingSwitchEnvironment('/test-user')).toEqual({
    HQHARNESS_MODEL_SOURCE: 'huaqing-switch',
    HUAQING_SWITCH_CONNECTOR_PATH: join(
      '/test-user',
      '.huaqing-switch',
      'connector.json',
    ),
  })
})

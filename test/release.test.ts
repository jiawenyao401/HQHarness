import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')

const releaseAssets = [
  'hqharness-mac-arm64.dmg',
  'hqharness-mac-x64.dmg',
  'hqharness-windows-x64-setup.exe'
]

/** The exact Harness build every `@deepseek-ai/dsh-*` production dep is pinned to. */
const HARNESS_VERSION = '0.2.0-rc.2'

describe('GitHub release contract', () => {
  it('keeps the package and lockfile versions aligned', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { version: string }
    const packageLock = JSON.parse(
      await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8')
    ) as { version: string; packages: Record<string, { version?: string }> }

    expect(packageLock.version).toBe(packageJson.version)
    expect(packageLock.packages['']?.version).toBe(packageJson.version)
  })

  it('declares required DSH peer packages as production dependencies', async () => {
    const packageLock = JSON.parse(
      await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8')
    ) as {
      packages: Record<string, { dev?: boolean; peer?: boolean }>
    }

    // A lock location is a path, so nested installs read as
    // `node_modules/<host>/node_modules/<name>`. Only the segment after the
    // last `node_modules/` names the package: without that, a third-party peer
    // that npm nested under a DSH package (rc.8 gives ui-trajectory its own
    // React 19) reads as a DSH package and trips this guard.
    const packageNameOf = (location: string): string =>
      location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length)

    const peerOnlyRuntimePackages = Object.entries(packageLock.packages)
      .filter(
        ([location, metadata]) =>
          packageNameOf(location).startsWith('@deepseek-ai/') &&
          metadata.peer === true &&
          metadata.dev !== true
      )
      .map(([location]) => packageNameOf(location))

    expect(peerOnlyRuntimePackages).toEqual([])
  })

  it('vendors upstream-new closure packages as file: production deps with no registry resolution', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { dependencies: Record<string, string> }
    const packageLockRaw = await readFile(
      path.join(projectRoot, 'package-lock.json'),
      'utf8'
    )
    const packageLock = JSON.parse(packageLockRaw) as {
      packages: Record<string, { resolved?: string; integrity?: string }>
    }

    // alpha.3 introduced these as transitive deps of shipped packages; they are
    // explicit production deps so the lockfile pins them like the rest of the
    // closure instead of letting a transitive range float.
    const promotedClosurePackages = [
      '@deepseek-ai/dsh-client-ui-schedule',
      '@deepseek-ai/dsh-deque',
      '@deepseek-ai/dsh-session-turn-outline',
      '@deepseek-ai/dsh-util-time',
      '@deepseek-ai/dsh-util-values'
    ]

    for (const packageName of promotedClosurePackages) {
      expect(packageJson.dependencies[packageName]).toBe(HARNESS_VERSION)
    }

    // Upstream publishes the official CI build to the registry, so every
    // `@deepseek-ai/dsh-*` dep is pinned to one exact version and every
    // resolution carries an integrity hash — `npm ci` stays reproducible
    // without vendoring tarballs into the repository.
    const harnessDeps = Object.entries(packageJson.dependencies).filter(
      ([name]) => name.startsWith('@deepseek-ai/dsh')
    )
    expect(harnessDeps.length).toBeGreaterThan(200)
    for (const [name, range] of harnessDeps) {
      expect(range, name).toBe(HARNESS_VERSION)
      const entry = packageLock.packages[`node_modules/${name}`]
      expect(entry?.resolved, name).toMatch(/^https?:\/\//)
      expect(entry?.integrity, name).toMatch(/^sha\d+-/)
    }

    // The vendored-tarball layout is gone; nothing may resolve from it.
    expect(packageLockRaw).not.toMatch(/file:packages\/harness-/)
  })

  it('does not promote optional Harness providers and test support into the desktop runtime', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> }
    const packageLock = JSON.parse(
      await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8')
    ) as { packages: Record<string, unknown> }

    const excludedHarnessPackages = [
      '@deepseek-ai/cordis-plugin-logger-console',
      '@deepseek-ai/dsh-agent-loop-testkit',
      '@deepseek-ai/dsh-client-test-runtime',
      // upstream 0.1.2-rc.1 moved this to packages/experimental/ (out of the
      // dsh family tarball set); desktop continues not to bundle it.
      '@deepseek-ai/dsh-code-runtime-python',
      '@deepseek-ai/dsh-e2b',
      '@deepseek-ai/dsh-fs-e2b',
      '@deepseek-ai/dsh-llm-mock-server',
      '@deepseek-ai/dsh-llm-replay',
      '@deepseek-ai/dsh-loader-smoke',
      '@deepseek-ai/dsh-lsp',
      '@deepseek-ai/dsh-lsp-stdio',
      '@deepseek-ai/dsh-sdk-client',
      // NOTE: @deepseek-ai/dsh-session-persistence-sqlite was removed upstream in
      // 0.1.2-alpha.3, so its exclusion assertion is gone. dsh-storage-sqlite is
      // likewise no longer in the closure but its guard is kept defensively.
      '@deepseek-ai/dsh-session-snapshot',
      '@deepseek-ai/dsh-session-title-all-prompts-llm',
      '@deepseek-ai/dsh-storage-sqlite',
      '@deepseek-ai/dsh-subagent-acp',
      '@deepseek-ai/dsh-subagent-claude-code',
      '@deepseek-ai/dsh-subagent-codex',
      '@deepseek-ai/dsh-subagent-dsh-sdk',
      '@deepseek-ai/dsh-subprocess-e2b',
      '@deepseek-ai/dsh-tool-lsp',
      '@deepseek-ai/dsh-tool-session-query',
      '@deepseek-ai/dsh-tool-terminal',
      '@deepseek-ai/dsh-web-search-exa',
      '@deepseek-ai/dsh-web-search-perplexity'
    ]

    for (const packageName of excludedHarnessPackages) {
      expect(packageJson.dependencies[packageName]).toBeUndefined()
      expect(packageLock.packages[`node_modules/${packageName}`]).toBeUndefined()
    }
    // The same official shell is rebuilt for the current primitives. Its Node
    // package is build-only; the browser bundle has always contained this code.
    expect(packageJson.dependencies['@deepseek-ai/dsh-client-web']).toBeUndefined()
    expect(packageJson.devDependencies['@deepseek-ai/dsh-client-web']).toBe(HARNESS_VERSION)
    expect(packageLock.packages['node_modules/@deepseek-ai/dsh-client-web']).toMatchObject({ dev: true })
    expect(packageLock.packages['node_modules/@anthropic-ai/claude-agent-sdk']).toBeUndefined()
    expect(packageLock.packages['node_modules/@openai/codex']).toBeUndefined()
  })

  it('uses stable platform-specific artifact names', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as {
      build: {
        artifactName: string
        asar: boolean
        asarUnpack: string[]
        afterPack?: string
        extraResources: Array<{ from: string; to: string }>
        win: { target: Array<{ target: string; arch: string[] }>; requestedExecutionLevel?: string }
        nsis: { artifactName: string; include: string }
        portable?: unknown
      }
    }
    const harnessNodeEntry = await readFile(
      path.join(projectRoot, 'build', 'harness-node-entry.mjs'),
      'utf8'
    )
    const windowsHiddenConsole = await readFile(
      path.join(projectRoot, 'build', 'windows-hidden-console.mjs'),
      'utf8'
    )

    expect(packageJson.build.artifactName).toBe('hqharness-${os}-${arch}.${ext}')
    expect(packageJson.build.asar).toBe(true)
    // JavaScript stays in app.asar; only files the OS loads or executes unpack.
    expect(packageJson.build.asarUnpack).not.toContain('node_modules/**/*')
    expect(packageJson.build.asarUnpack).toEqual(expect.arrayContaining([
      '**/*.{node,dylib,dll,so,exe}',
      '**/spawn-helper',
      '**/@vscode/ripgrep-*/bin/rg',
      'node_modules/@deepseek-ai/libreoffice-kit-*/**/*'
    ]))
    expect(packageJson.build.extraResources).toContainEqual({
      from: '.build/brand/app-icon.png',
      to: 'icon.png'
    })
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/windows-hidden-console.mjs',
      to: 'windows-hidden-console.mjs'
    })
    expect(harnessNodeEntry).toContain("await import('./windows-hidden-console.mjs')")
    // A top-level import: leaving this out of the package does not degrade the
    // host peer fallback, it stops the Harness entry from loading at all.
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/host-module-fallback.mjs',
      to: 'host-module-fallback.mjs'
    })
    expect(harnessNodeEntry).toContain("from './host-module-fallback.mjs'")
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/office-engine-resolution.mjs',
      to: 'office-engine-resolution.mjs'
    })
    expect(harnessNodeEntry).toContain("from './office-engine-resolution.mjs'")
    expect(windowsHiddenConsole).toContain('export function createHiddenConsole')
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/windows-child-process-hide.mjs',
      to: 'windows-child-process-hide.mjs'
    })
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/splash.html',
      to: 'splash.html'
    })
    expect(packageJson.build.extraResources).toContainEqual({
      from: '.build/brand/dsh-loader.gif',
      to: 'dsh-loader.gif'
    })
    expect(packageJson.build.extraResources).toContainEqual({
      from: '.build/brand/dsh-loader-dark.gif',
      to: 'dsh-loader-dark.gif'
    })
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/dsh-desktop.patch.yml',
      to: 'dsh-desktop.patch.yml'
    })
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/dsh-desktop-safe.patch.yml',
      to: 'dsh-desktop-safe.patch.yml'
    })
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/web-import.html',
      to: 'web-import.html'
    })
    expect(packageJson.build.nsis.artifactName).toBe(
      'hqharness-windows-${arch}-setup.${ext}'
    )
    expect(packageJson.build.nsis.include).toBe('build/installer.nsh')
    expect(packageJson.build.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
    expect(packageJson.build.win.requestedExecutionLevel).toBe('asInvoker')
    expect(packageJson.build.portable).toBeUndefined()
  })

  it('keeps update metadata on the latest channel for pre-release versions', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { build: { detectUpdateChannel?: boolean } }

    // A version like 0.8.0-rc.1 would otherwise make electron-builder write
    // rc-mac.yml / rc.yml instead of latest-mac.yml / latest.yml, which every
    // downstream release step expects by name.
    expect(packageJson.build.detectUpdateChannel).toBe(false)
  })

  it('requires explicit HQHarness services and a self-owned publisher for updates', async () => {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      build: { appId: string; productName: string; publish: unknown; win: { verifyUpdateCodeSignature: boolean; signtoolOptions: { publisherName?: unknown } } }
    }
    const brand = JSON.parse(await readFile(path.join(projectRoot, 'brand.config.json'), 'utf8')) as {
      updateBaseUrl: string | null; desktopServiceUrl: string | null; supportUrl: string | null; publisherName: string | null; releaseRepository: string | null
    }
    expect(packageJson.dependencies['electron-updater']).toBeTruthy()
    expect(packageJson.build.appId).toBe('app.hqharness.desktop')
    expect(packageJson.build.productName).toBe('HQHarness')
    for (const serviceUrl of [brand.updateBaseUrl, brand.desktopServiceUrl, brand.supportUrl]) {
      if (serviceUrl !== null) {
        expect(new URL(serviceUrl).protocol).toBe('https:')
        expect(new URL(serviceUrl).hostname).not.toMatch(/(^|\.)dshdesktop\.com$/)
      }
    }
    const feed = brand.updateBaseUrl
      ? new URL('latest/', brand.updateBaseUrl.endsWith('/') ? brand.updateBaseUrl : `${brand.updateBaseUrl}/`).href
      : null
    expect(packageJson.build.publish).toEqual(feed ? [{ provider: 'generic', url: feed }] : null)
    expect(packageJson.build.win.signtoolOptions.publisherName).toEqual(brand.publisherName ?? undefined)
    expect(brand.publisherName).not.toBe('Beijing Shuju Xiangsu Intelligence Technology Co., Ltd.')
    expect(brand.releaseRepository).not.toBe('dataelement/dsh-desktop')
    expect(packageJson.build.win.verifyUpdateCodeSignature).toBe(true)
  })

  it('keeps builder jobs from attempting implicit tag publishing', async () => {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    for (const script of ['package:mac', 'package:mac:arm64', 'package:mac:x64', 'package:win', 'package:dev:mac:arm64', 'package:dev:mac:x64', 'package:dev:win']) {
      expect(packageJson.scripts[script]).toContain('--publish never')
    }
  })

  it('uses the staged-directory installer for Windows packaging and signed repackaging', async () => {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>; build: { nsis: { allowToChangeInstallationDirectory: boolean } }
    }
    const workflow = await readFile(path.join(projectRoot, '.github/workflows/release.yml'), 'utf8')
    expect(packageJson.scripts['package:win']).toContain('electron-builder-windows.mjs')
    expect(packageJson.scripts['package:dev:win']).toContain('electron-builder-windows.mjs')
    expect(packageJson.build.nsis.allowToChangeInstallationDirectory).toBe(true)
    expect(workflow).toContain('node scripts/electron-builder-windows.mjs --win --x64 --publish never')
    expect(workflow).toContain('--prepackaged')
  })

  it('packages an isolated development identity', async () => {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const developmentConfig = createRequire(import.meta.url)('../electron-builder.dev.cjs') as {
      appId: string; productName: string; directories: { output: string }; extraMetadata: { name: string; dshDesktopChannel: string }; artifactName: string; nsis: { artifactName: string }; publish: unknown
    }
    expect(packageJson.scripts['package:dev:dir']).toContain('npm run build')
    for (const [script, target] of [['package:dev:mac:arm64', 'darwin arm64'], ['package:dev:mac:x64', 'darwin x64'], ['package:dev:win', 'win32 x64']]) {
      expect(packageJson.scripts[script ?? '']).toContain(`verify-target.mjs ${target}`)
      expect(packageJson.scripts[script ?? '']).toContain('electron-builder.dev.cjs')
      expect(packageJson.scripts[script ?? '']).toContain('--publish never')
    }
    expect(developmentConfig.appId).toBe('app.hqharness.desktop.dev')
    expect(developmentConfig.productName).toBe('HQHarness Dev')
    expect(developmentConfig.directories.output).toBe('dist-dev')
    expect(developmentConfig.extraMetadata.name).toBe('hqharness-dev')
    expect(developmentConfig.extraMetadata.dshDesktopChannel).toBe('development')
    expect(developmentConfig.artifactName).toBe('hqharness-dev-${os}-${arch}.${ext}')
    expect(developmentConfig.nsis.artifactName).toBe('hqharness-dev-windows-${arch}-setup.${ext}')
    expect(developmentConfig.publish).toBeNull()
  })

  it('describes the source fork without invented websites, communities or signed releases', async () => {
    const readmes = await Promise.all(['README.md', 'README.zh.md', 'README.ja.md', 'README.ru.md', 'README.es.md', 'README.pt.md'].map(file => readFile(path.join(projectRoot, file), 'utf8')))
    for (const readme of readmes) {
      expect(readme).toContain('# HQHarness')
      expect(readme).toContain('115a0b474cc2c4794316171c640a8898398591fe')
      expect(readme).toContain('https://github.com/dataelement/dsh-desktop')
      expect(readme).toContain('MIT')
      expect(readme).toContain('docs/hqharness-release.md')
      expect(readme).not.toMatch(/dshdesktop\.com|discord\.gg|wechat-group|releases\/latest\/download/)
      for (const asset of releaseAssets) expect(readme).not.toContain(`download/${asset}`)
    }
  })

  it('does not change Windows security settings during installation', async () => {
    const installer = await readFile(path.join(projectRoot, 'build/installer.nsh'), 'utf8')
    expect(installer).not.toMatch(/Add-MpPreference|HKLM|ExecShell\s+"runas"/)
  })
})

interface WorkflowStep {
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
  if?: string
}
interface WorkflowJob {
  if?: string
  needs?: string | string[]
  'runs-on'?: string | string[]
  environment?: string
  permissions?: Record<string, string>
  steps: WorkflowStep[]
  strategy?: { 'fail-fast': boolean; matrix: { include: unknown[] } }
}
interface ReleaseWorkflow {
  on: Record<string, unknown>
  permissions: Record<string, string>
  jobs: Record<string, WorkflowJob>
}
const loadWorkflow = async (): Promise<{ source: string; workflow: ReleaseWorkflow }> => {
  const source = await readFile(path.join(projectRoot, '.github/workflows/release.yml'), 'utf8')
  return { source, workflow: parse(source) as ReleaseWorkflow }
}

describe('HQHarness native release workflow', () => {
  it('runs native build, tests and typecheck on public PR runners without signing credentials', async () => {
    const { workflow } = await loadWorkflow()
    expect(workflow.permissions.contents).toBe('read')
    expect(workflow.jobs.macos?.['runs-on']).toBe('${{ matrix.runner }}')
    expect(workflow.jobs.macos?.strategy?.['fail-fast']).toBe(false)
    expect(workflow.jobs.macos?.strategy?.matrix.include).toEqual([
      { arch: 'arm64', label: 'Apple Silicon', runner: 'macos-15', 'app-directory': 'mac-arm64', artifact: 'macos-apple-silicon' },
      { arch: 'x64', label: 'Intel', runner: 'macos-15-intel', 'app-directory': 'mac', artifact: 'macos-intel' }
    ])
    expect(workflow.jobs['windows-x64']?.['runs-on']).toBe('windows-2022')
    for (const name of ['macos', 'windows-x64']) {
      const job = workflow.jobs[name]
      expect(job?.if).toContain("github.event_name == 'pull_request'")
      const steps = job?.steps ?? []
      const buildIndex = steps.findIndex(step => step.run === 'npm run build')
      const testIndex = steps.findIndex(step => step.run?.startsWith('npx --no-install vitest run'))
      expect(buildIndex).toBeGreaterThanOrEqual(0)
      expect(testIndex).toBeGreaterThan(buildIndex)
      expect(steps.filter(step => step.run === 'npm run build')).toHaveLength(1)
      expect(steps.some(step => step.run === 'npm run typecheck')).toBe(true)
      const packages = steps.filter(step => step.run?.includes('--publish never'))
      expect(packages).toHaveLength(2)
      for (const step of packages) {
        expect(step.run).toContain('verify-target.mjs')
        expect(step.run).not.toContain('npm run build')
      }
      for (const step of steps.filter(step => step.uses === 'actions/upload-artifact@v4' && step.with?.['if-no-files-found'] === 'error')) {
        expect(step.with?.['compression-level']).toBe(0)
      }
      for (const step of steps.filter(step => step.name?.includes('signing') || step.name?.includes('notariz'))) {
        expect(step.if).toContain("startsWith(github.ref, 'refs/tags/v')")
      }
    }
  })

  it('preserves the real packaged Windows Harness and native dependency smoke', async () => {
    const { source } = await loadWorkflow()
    for (const contract of ['Smoke test packaged Windows Harness', '$sourceExecutable = Get-Item $env:SMOKE_EXE', '$isolatedApp = Join-Path $env:RUNNER_TEMP', '-WorkingDirectory $isolatedApp', 'Packaged koffi native binding failed', 'dist-dev\\win-unpacked\\HQHarness Dev.exe', "Invoke-HarnessRpc 'workspace/create'", "Invoke-HarnessRpc 'session/create'", 'Harness process exited after workspace and session creation.', 'smoke-signed-windows-installer.ps1']) {
      expect(source).toContain(contract)
    }
    expect(source).toContain('node scripts/probe-electron-node-runtime.mjs')
    expect(source).toContain('node scripts/check-recovery-ui.mjs')
    expect(source).toContain("if (Test-Path $packagedNode) { throw 'Standalone Windows node.exe must not be packaged.' }")
  })

  it('requires HQHarness secrets and both native signing verification gates', async () => {
    const { source, workflow } = await loadWorkflow()
    for (const secret of ['HQHARN_CSC_LINK', 'HQHARN_CSC_KEY_PASSWORD', 'HQHARN_APPLE_API_KEY', 'HQHARN_APPLE_API_KEY_ID', 'HQHARN_APPLE_API_ISSUER', 'HQHARN_APPLE_TEAM_ID', 'HQHARN_WINDOWS_SIGNING_PIN']) {
      expect(source).toContain(`secrets.${secret}`)
    }
    expect(source).toContain('vars.HQHARN_WINDOWS_PUBLISHER_NAME')
    expect(source).toContain('-PublisherName $env:HQHARN_WINDOWS_PUBLISHER_NAME')
    expect(source).toContain('xcrun notarytool submit')
    expect(source.match(/xcrun stapler validate/g)).toHaveLength(2)
    expect(source).toContain('sign-windows-unpacked.mjs')
    expect(workflow.jobs['sign-windows']?.steps.some(step => step.run === 'npm run brand:prepare')).toBe(true)
    expect(source).toContain('finalize-windows-release.mjs')
    expect(source).toContain('--storetype ETOKEN')
    expect(source).toContain('--storepass "file:$pin_file"')
    expect(source).toContain('--tsmode RFC3161')
    expect(source).toContain('unset WINDOWS_SIGNING_PIN')
    expect(workflow.jobs['sign-windows']?.['runs-on']).toEqual(['self-hosted', 'macOS', 'ARM64', 'hqharness-signing'])
    expect(workflow.jobs['sign-windows']?.environment).toBe('hqharness-signing')
    expect(workflow.jobs['smoke-signed-windows']?.needs).toBe('sign-windows')
    for (const name of ['publish', 'publish-prerelease']) {
      const job = workflow.jobs[name]
      expect(job?.needs).toEqual(['macos', 'sign-windows', 'smoke-signed-windows'])
      expect(job?.if).toContain("needs.macos.result == 'success'")
      expect(job?.if).toContain("needs.sign-windows.result == 'success'")
      expect(job?.if).toContain("needs.smoke-signed-windows.result == 'success'")
      expect(job?.environment).toBe('hqharness-release')
      expect(job?.permissions?.contents).toBe('write')
    }
  })

  it('publishes only verified assets to the current configured GitHub repository', async () => {
    const { source, workflow } = await loadWorkflow()
    expect(source).toContain('.github/scripts/validate-release-config.mjs')
    expect(workflow.jobs['publish-prerelease']?.if).toContain("inputs.target == 'all'")
    expect(workflow.jobs['publish-prerelease']?.if).toContain("inputs.mode == 'prerelease'")
    expect(workflow.jobs.publish?.if).toContain("startsWith(github.ref, 'refs/tags/v')")
    for (const name of ['publish', 'publish-prerelease']) {
      const steps = workflow.jobs[name]?.steps ?? []
      const verify = steps.findIndex(step => step.run?.includes('verify-release-assets.mjs release-assets'))
      const publish = steps.findIndex(step => step.run?.includes('gh release create'))
      expect(verify).toBeGreaterThanOrEqual(0)
      expect(publish).toBeGreaterThan(verify)
      expect(steps[publish]?.run).toContain('--repo "$GITHUB_REPOSITORY"')
      expect(steps[publish]?.run).toContain('--title "HQHarness ')
    }
    expect(source).toContain('merge-mac-update-metadata.mjs')
    expect(source).toContain('if [ -f release-assets/latest-mac-arm64.yml ]')
    expect(source).not.toMatch(/dshdesktop\.com|alexyaojin|MODELSCOPE|FEISHU|Beijing Shuju|COPILOT|RELEASE_NOTES_MODEL/)
    expect(source).not.toContain('publish-signed-test:')
    expect(source).not.toContain('configure-rollout')
    expect(source).not.toContain('secrets.DESKTOP_')
  })

  it('backs up only explicitly selected releases without writing to an external service', async () => {
    const source = await readFile(path.join(projectRoot, '.github/workflows/backfill-archive.yml'), 'utf8')
    const workflow = parse(source) as ReleaseWorkflow
    expect(workflow.on.workflow_dispatch).toBeTruthy()
    expect(workflow.on.push).toBeUndefined()
    expect(workflow.permissions.contents).toBe('read')
    expect(source).toContain('RELEASE_MODE: backfill')
    expect(source).toContain('.github/scripts/validate-release-config.mjs')
    expect(source).toContain('verify-release-assets.mjs release-assets')
    expect(source).toContain('! -name SHA256SUMS -print0')
    expect(source).toContain('xargs -0 sha256sum > SHA256SUMS')
    expect(source).toContain('--repo "$GITHUB_REPOSITORY"')
    expect(source).not.toMatch(/modelscope|dshdesktop\.com|FEISHU|upload_folder|upload_file|configure-rollout/)
  })
})

describe('HQHarness publication identity validation', () => {
  async function validate(brand: Record<string, unknown>, mode: string, repository = 'example/hqharness', publisher = '', target = 'all', packagePublisher?: string) {
    const temporary = await mkdtemp(path.join(tmpdir(), 'hqharness-release-'))
    try {
      const [brandSource, packageSource] = await Promise.all([
        readFile(path.join(projectRoot, 'brand.config.json'), 'utf8'),
        readFile(path.join(projectRoot, 'package.json'), 'utf8')
      ])
      const fixtureBrand = {
        ...JSON.parse(brandSource),
        updateBaseUrl: null, desktopServiceUrl: null, supportUrl: null,
        releaseRepository: null, publisherName: null,
        ...brand
      }
      const fixturePackage = JSON.parse(packageSource)
      fixturePackage.build.publish = fixtureBrand.updateBaseUrl
        ? { provider: 'generic', url: new URL('latest/', `${fixtureBrand.updateBaseUrl.replace(/\/+$/, '')}/`).href }
        : null
      fixturePackage.build.win.verifyUpdateCodeSignature = true
      fixturePackage.build.win.signtoolOptions.publisherName = packagePublisher ?? fixtureBrand.publisherName ?? undefined
      await Promise.all([
        writeFile(path.join(temporary, 'brand.config.json'), JSON.stringify(fixtureBrand)),
        writeFile(path.join(temporary, 'package.json'), JSON.stringify(fixturePackage))
      ])
      return execFileSync(process.execPath, [path.join(projectRoot, '.github/scripts/validate-release-config.mjs')], {
        cwd: temporary,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, RELEASE_MODE: mode, RELEASE_TARGET: target, GITHUB_REPOSITORY: repository, HQHARN_WINDOWS_PUBLISHER_NAME: publisher }
      })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }

  it('allows unsigned validation without a publisher or release repository', async () => {
    await expect(validate({ releaseRepository: null, publisherName: null }, 'development')).resolves.toContain('validated')
  })

  it('rejects missing, upstream or mismatched release destinations before publication', async () => {
    await expect(validate({ releaseRepository: null }, 'release')).rejects.toThrow('Configure your own owner/repo')
    await expect(validate({ releaseRepository: 'dataelement/dsh-desktop' }, 'backfill', 'dataelement/dsh-desktop')).rejects.toThrow('must not publish into the upstream')
    await expect(validate({ releaseRepository: 'other/hqharness' }, 'backfill')).rejects.toThrow('must match the current GITHUB_REPOSITORY')
  })

  it('requires the exact configured Windows certificate publisher for signed builds', async () => {
    await expect(validate({ publisherName: null }, 'signed')).rejects.toThrow('Configure your own Windows certificate')
    await expect(validate({ publisherName: 'HQ Fixture Publisher' }, 'signed', undefined, 'Different Publisher')).rejects.toThrow('must exactly match')
    await expect(validate({ releaseRepository: 'example/hqharness', publisherName: 'HQ Fixture Publisher' }, 'release', undefined, 'HQ Fixture Publisher')).resolves.toContain('validated')
    await expect(validate({ publisherName: null }, 'signed', undefined, '', 'macos')).resolves.toContain('validated')
  })

  it('rejects an enabled update feed when the actual package publisher differs from the brand', async () => {
    await expect(validate({
      releaseRepository: 'example/hqharness',
      publisherName: 'HQ Fixture Publisher',
      updateBaseUrl: 'https://updates.hqharness.test/desktop/',
      desktopServiceUrl: 'https://policy.hqharness.test/service/'
    }, 'release', undefined, 'HQ Fixture Publisher', 'all', 'Different Package Publisher')).rejects.toThrow('Windows update signature verification and publisherName must match the brand configuration')
  })
})

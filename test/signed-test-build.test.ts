import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

describe('signed test builds', () => {
  it('uploads only selected installers and never notifies after upload or download failures', () => {
    const output = execFileSync('python3', ['-c', String.raw`
import sys, tempfile, types, os
from pathlib import Path
from unittest.mock import patch, MagicMock
sys.path.insert(0, '.github/scripts')
import signed_test_build as build

with tempfile.TemporaryDirectory() as work:
    directory = Path(work)
    for names in build.INSTALLERS.values():
        for _, name in names:
            (directory / name).write_bytes(b'installer')
    (directory / 'latest.yml').write_text('not an installer')
    for target, count in [('all', 3), ('macos', 2), ('windows', 1)]:
        files = build.installer_paths(directory, target)
        assert len(files) == count
        notes = build.build_notification('1.0.0-test.1', files, 'example/desktop', 'test/1.0.0-test.1/42', 'https://github.com/example/desktop/actions/runs/42')
        assert notes.count('/resolve/master/test/') == count
        assert ('Windows 安装包' in notes) == (target != 'macos')
        assert ('macOS 安装包' in notes) == (target != 'windows')
        assert '客户端中更新' not in notes
    assert build.test_prefix('1.0.0-test.1', '42') == 'test/1.0.0-test.1/42'
    for version in ['../latest', 'v1.0.0', '1.0.0/test']:
        try:
            build.test_prefix(version, '42')
        except ValueError:
            pass
        else:
            raise AssertionError('invalid path accepted')
    (directory / 'dsh-desktop-mac-arm64.dmg').unlink()
    try:
        build.installer_paths(directory, 'all')
    except ValueError:
        pass
    else:
        raise AssertionError('missing installer accepted')
    # A Windows-only run does not need the omitted macOS installer.
    assert len(build.installer_paths(directory, 'windows')) == 1

    events = []
    api = MagicMock()
    api.upload_file.side_effect = lambda **kw: events.append(('upload', kw['path_in_repo']))
    sdk = types.ModuleType('modelscope.hub.api')
    sdk.HubApi = lambda: api
    env = dict(MODELSCOPE_REPO_ID='example/desktop', MODELSCOPE_TOKEN='fixture', FEISHU_RELEASE_WEBHOOK='fixture', GITHUB_SERVER_URL='https://github.com', GITHUB_REPOSITORY='example/desktop', GITHUB_STEP_SUMMARY=str(directory / 'summary'))
    argv = ['signed_test_build.py', '--directory', work, '--target', 'windows', '--version', '1.0.0-test.1', '--run-id', '42']
    with patch.dict(sys.modules, {'modelscope': types.ModuleType('modelscope'), 'modelscope.hub': types.ModuleType('modelscope.hub'), 'modelscope.hub.api': sdk}), patch.dict(os.environ, env), patch.object(sys, 'argv', argv), patch.object(build, 'verify_download', side_effect=lambda *args: events.append(('verify', args[0]))) as verify, patch.object(build, 'send_feishu_notification', side_effect=lambda *args, **kw: events.append(('notify', kw))) as notify:
        build.main()
        assert [e[0] for e in events] == ['upload', 'verify', 'notify']
        assert events[0][1] == 'test/1.0.0-test.1/42/dsh-desktop-windows-x64-setup.exe'
        assert events[2][1] == {'test_build': True}
        assert 'Windows x64' in (directory / 'summary').read_text(encoding='utf-8')
        notify.reset_mock()
        api.upload_file.side_effect = RuntimeError('upload failed')
        try:
            build.main()
        except RuntimeError:
            pass
        else:
            raise AssertionError('upload failure swallowed')
        notify.assert_not_called()
        api.upload_file.side_effect = None
        verify.side_effect = RuntimeError('public download failed')
        try:
            build.main()
        except RuntimeError:
            pass
        else:
            raise AssertionError('download failure swallowed')
        notify.assert_not_called()

response = MagicMock()
response.status = 206
response.headers = {'Content-Range': 'bytes 0-0/9'}
response.read.return_value = b'i'
response.__enter__.return_value = response
with patch.object(build.urllib.request, 'urlopen', return_value=response), patch.object(build.time, 'sleep'):
    build.verify_download('https://example.com/installer', 9)
    response.status = 200
    build.verify_download('https://example.com/installer', 9)
    response.headers = {'Content-Range': 'bytes 0-0/8'}
    try:
        build.verify_download('https://example.com/installer', 9)
    except RuntimeError:
        pass
    else:
        raise AssertionError('wrong public size accepted')

import feishu_release_notes as feishu
response.read.return_value = b'{"code": 0}'
with patch.object(feishu.urllib.request, 'urlopen', return_value=response) as send:
    feishu.send_feishu_notification('https://example.com/webhook', '1.0.0-test.1', 'download links', test_build=True)
    import json
    card = json.loads(send.call_args.args[0].data)['card']
    assert card['header']['title']['content'].endswith('测试打包完成')
    assert card['header']['template'] == 'orange'
    assert card['elements'][0]['text']['content'] == 'download links'
print('signed test build behavior passed')
`], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    expect(output).toContain('signed test build behavior passed')
  })

  it('keeps upstream upload and notification tools disconnected from HQHarness signed mode', () => {
    const yaml = require('js-yaml') as { load(source: string): { jobs: Record<string, unknown> } }
    const source = readFileSync('.github/workflows/release.yml', 'utf8')
    const workflow = yaml.load(source)
    expect(workflow.jobs['publish-signed-test']).toBeUndefined()
    expect(source).not.toContain('signed_test_build.py')
    expect(source).not.toContain('FEISHU_RELEASE_WEBHOOK')
    expect(source).not.toContain('MODELSCOPE_REPO_ID')
  })

  it('checks the actual unsigned application identity and version without requiring update metadata', async () => {
    const yaml = require('js-yaml') as { load(source: string): { jobs: Record<string, { steps: { name?: string, run?: string, if?: string }[] }> } }
    const asar = require('@electron/asar') as { createPackage(source: string, destination: string): Promise<void> }
    const expected = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string, productName: string, version: string }
    const workflow = yaml.load(readFileSync('.github/workflows/release.yml', 'utf8'))
    const step = workflow.jobs['sign-windows']?.steps.find(item => item.name === 'Extract and verify unsigned Windows application')
    expect(step?.if).toBeUndefined()
    if (!step?.run) throw new Error('Unsigned application verification step is missing')

    const work = mkdtempSync(join(tmpdir(), 'hqharness-signing-manifest-'))
    try {
      const verify = async (directory: string, manifest: typeof expected, metadata?: string) => {
        const source = join(directory, 'source')
        const staging = join(directory, 'staging')
        const release = join(directory, 'release')
        const resources = join(staging, 'win-unpacked', 'resources')
        mkdirSync(source, { recursive: true })
        mkdirSync(resources, { recursive: true })
        mkdirSync(release, { recursive: true })
        writeFileSync(join(source, 'package.json'), JSON.stringify(manifest))
        await asar.createPackage(source, join(resources, 'app.asar'))
        execFileSync('tar', ['-czf', join(release, 'win-unpacked.tar.gz'), '-C', staging, 'win-unpacked'])
        if (metadata) writeFileSync(join(release, 'latest.yml'), metadata)
        return () => execFileSync('bash', ['-c', step.run ?? ''], {
          encoding: 'utf8',
          env: {
            ...process.env, WINDOWS_SIGNING_WORK_DIR: directory.replaceAll('\\', '/'),
            // This Linux signing step is exercised via Git Bash on Windows.
            // GNU tar otherwise interprets the C: fixture path as a remote host.
            ...(process.platform === 'win32' ? { TAR_OPTIONS: '--force-local' } : {})
          },
          stdio: 'pipe',
        })
      }
      const valid = await verify(join(work, 'valid'), expected)
      expect(valid()).toContain(`Verified unsigned Windows application ${expected.productName} ${expected.version}`)
      // A matching sidecar cannot conceal the different version inside the ASAR.
      const wrongVersion = await verify(join(work, 'wrong-version'), { ...expected, version: '0.0.0-invalid' }, `version: ${expected.version}\n`)
      expect(wrongVersion).toThrow(/application version .* does not match expected/)
      const wrongName = await verify(join(work, 'wrong-name'), { ...expected, name: 'dsh-desktop' })
      expect(wrongName).toThrow(/application name .* does not match expected/)
      const wrongProduct = await verify(join(work, 'wrong-product'), { ...expected, productName: 'DSH Desktop' })
      expect(wrongProduct).toThrow(/application productName .* does not match expected/)
      const missing = join(work, 'missing')
      mkdirSync(join(missing, 'release'), { recursive: true })
      expect(() => execFileSync('bash', ['-c', step.run ?? ''], {
        env: { ...process.env, WINDOWS_SIGNING_WORK_DIR: missing },
        stdio: 'pipe',
      })).toThrow()
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})

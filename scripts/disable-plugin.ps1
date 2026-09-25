# dsh-invest 一键禁用（应急回退）。
#
# 重要：本脚本不再「整文件覆盖」profile 的 cordis.patch.yml —— 那里还挂着
# openviking-boot（OpenViking 本地服务自启钩子），整文件覆盖会让该钩子静默失效。
# 现在改为在 patch 层「按 id 停用」invest 行（dsh-invest 本体由 package.json 的
# dsh.profile.bundles 挂载，用 `- id: invest` + `disabled: true` 即可停掉它）。
# 数据（缓存/报告/输出）不受影响。
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\disable-plugin.ps1
$ErrorActionPreference = 'Stop'
$patch = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'
if (-not (Test-Path $patch)) { Write-Host "未找到 profile patch: $patch"; exit 1 }
$content = @'
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).

# dsh-invest 已由 scripts/disable-plugin.ps1 停用（恢复请运行 enable-plugin.ps1）。
# 只按 id 停用，绝不整文件覆盖 —— openviking-boot 钩子也挂在本文件。
- id: invest
  disabled: true

- insert:
    - id: openviking-boot
      name: 'dsh-openviking-boot'
'@
[System.IO.File]::WriteAllText($patch, $content, [System.Text.UTF8Encoding]::new($true))
Write-Host 'dsh-invest 已停用（openviking-boot 钩子保留）。现在可以重启 DSH（插件不再加载，其余功能正常）。'
Write-Host '恢复：powershell -ExecutionPolicy Bypass -File scripts\enable-plugin.ps1'

# dsh-invest 一键禁用（应急回退）：把 profile 用户层 patch 恢复为空数组，
# 插件行不再挂载 → DSH 可正常启动。数据（缓存/报告/输出）不受影响。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\disable-plugin.ps1
$ErrorActionPreference = 'Stop'
$patch = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'
if (-not (Test-Path $patch)) { Write-Host "未找到 profile patch: $patch"; exit 1 }
$content = @'
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).

# dsh-invest 已禁用（scripts/disable-plugin.ps1）。恢复请运行 scripts/enable-plugin.ps1
[]
'@
[System.IO.File]::WriteAllText($patch, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host 'dsh-invest 已禁用。现在可以重启 DSH（插件不再加载，其余功能正常）。'
Write-Host '恢复：powershell -ExecutionPolicy Bypass -File scripts\enable-plugin.ps1'

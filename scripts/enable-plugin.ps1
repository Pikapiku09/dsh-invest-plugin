# dsh-invest 一键启用（恢复挂载）：把插件行写回 profile 用户层 patch。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\enable-plugin.ps1
$ErrorActionPreference = 'Stop'
$patch = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'
if (-not (Test-Path $patch)) { Write-Host "未找到 profile patch: $patch"; exit 1 }
$content = @'
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).

# dsh-invest 插件行（本地常规插件，profile 层永久挂载，不依赖 bundles 列表）
- insert:
    - id: invest
      name: 'dsh-invest'
'@
[System.IO.File]::WriteAllText($patch, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host 'dsh-invest 已启用。重启 DSH 后生效。'
Write-Host '禁用：powershell -ExecutionPolicy Bypass -File scripts\disable-plugin.ps1'

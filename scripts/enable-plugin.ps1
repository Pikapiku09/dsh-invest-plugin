# dsh-invest 一键启用（恢复挂载）。
#
# 重要：dsh-invest 本体现在由 profile 的 package.json → dsh.profile.bundles 挂载
# （bundle 层会自动应用该包自带的 cordis.patch.yml），所以这里不再插入 invest 行
# ——重复插入会产生第二个 invest 行，导致插件被挂载两次、工具重名。
#
# 本脚本只负责保证 profile 的 cordis.patch.yml 处于「正常」状态，并且必须保留
# openviking-boot（OpenViking 本地服务自启钩子）—— 它也挂在同一个文件里，
# 整文件覆盖会让该钩子静默失效。
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\enable-plugin.ps1
$ErrorActionPreference = 'Stop'
$patch = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'
if (-not (Test-Path $patch)) { Write-Host "未找到 profile patch: $patch"; exit 1 }
$content = @'
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).

# 注：dsh-invest 与 dsh-openviking 已在 package.json 的 dsh.profile.bundles 中声明，
# 由 bundle 层自动挂载；此处只额外挂载 openviking 本地服务自启钩子。
- insert:
    - id: openviking-boot
      name: 'dsh-openviking-boot'
'@
[System.IO.File]::WriteAllText($patch, $content, [System.Text.UTF8Encoding]::new($true))
Write-Host 'dsh-invest 已启用（bundle 层挂载 + openviking-boot 钩子保留）。重启 DSH 后生效。'
Write-Host '禁用：powershell -ExecutionPolicy Bypass -File scripts\disable-plugin.ps1'

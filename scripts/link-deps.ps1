# dsh-invest 依赖链接脚本（Windows）
# 原因：以 pnpm link: 方式安装时，包的真实路径在仓库目录（profile 树外），
# Node ESM 从真实路径向上找不到 @deepseek-ai/* 依赖（profile 为 hoisted 布局，
# 且 ESM import 不读 NODE_PATH）。本脚本将 peer 依赖以目录联接（junction）
# 链入包目录 node_modules，版本与部署树必然一致。
# 用法：powershell -ExecutionPolicy Bypass -File scripts/link-deps.ps1
$ErrorActionPreference = 'Stop'
$pkg = Join-Path $PSScriptRoot '..\packages\dsh-invest'
$deploy = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai'
$deps = @('dsh-tools', 'dsh-host-webserver', 'dsh-system-prompt')

if (-not (Test-Path $deploy)) {
  Write-Host "部署树不存在: $deploy" -ForegroundColor Red
  exit 1
}
$scoped = Join-Path $pkg 'node_modules\@deepseek-ai'
New-Item -ItemType Directory -Force -Path $scoped | Out-Null
foreach ($dep in $deps) {
  $target = Join-Path $deploy $dep
  $link = Join-Path $scoped $dep
  if (-not (Test-Path $target)) { Write-Host "跳过（部署树无）: $dep" -ForegroundColor Yellow; continue }
  if (Test-Path $link) {
    $item = Get-Item $link -Force
    if ($item.LinkType -eq 'Junction') { Write-Host "已存在: $dep"; continue }
    Remove-Item $link -Recurse -Force
  }
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
  Write-Host "已链接: $dep"
}
Write-Host '依赖链接完成。'

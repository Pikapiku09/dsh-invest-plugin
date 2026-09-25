# dsh-invest 依赖链接脚本（Windows）
#
# 背景：插件以 pnpm link:（Windows 目录联接 / junction）方式挂进 profile，包的真实
# 路径在仓库目录（profile 树外），Node ESM 从真实路径向上找不到 @deepseek-ai/* 依赖
# （profile 为 hoisted 布局，且 ESM import 不读 NODE_PATH）。本脚本把 peer 依赖以
# junction 链入包目录 node_modules。
#
# 2026-09 修正（重要）：
#   旧的链接源是 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`
#   ——那是 npm 全局安装的 DSH 0.1.0-rc.x（2026-08 前的部署）。
#   现在部署已换成 Minke 桌面应用，宿主包位于
#     <Minke>\resources\host\node_modules\@deepseek-ai   （当前 0.1.6-alpha.1）
#   并且 dsh 会维护一份稳定镜像
#     ~\.dsh\profiles\node_modules\@deepseek-ai
#   （该目录里每个包都是指向“当前宿主”的 junction，随应用升级自动更新）。
#
#   继续指旧的全局树，会让插件加载 0.1.0-rc.x 的 dsh-tools，与 0.1.6-alpha.1 宿主
#   不兼容 → 插件挂载失败。所以这里改为链接到那份自动更新的镜像。
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\link-deps.ps1
$ErrorActionPreference = 'Stop'
$pkg = Join-Path $PSScriptRoot '..\packages\dsh-invest'
$deploy = Join-Path $env:USERPROFILE '.dsh\profiles\node_modules\@deepseek-ai'
$deps = @('dsh-tools', 'dsh-host-webserver', 'dsh-system-prompt', 'schemastery')

if (-not (Test-Path $deploy)) {
  Write-Host "宿主依赖镜像不存在: $deploy" -ForegroundColor Red
  Write-Host "请先启动一次 Minke/DSH，让它生成该镜像后再运行本脚本。" -ForegroundColor Yellow
  exit 1
}

$scoped = Join-Path $pkg 'node_modules\@deepseek-ai'
New-Item -ItemType Directory -Force -Path $scoped | Out-Null

foreach ($dep in $deps) {
  $target = Join-Path $deploy $dep
  $link = Join-Path $scoped $dep
  if (-not (Test-Path $target)) { Write-Host "跳过（镜像里没有）: $dep" -ForegroundColor Yellow; continue }
  if (Test-Path $link) {
    $item = Get-Item $link -Force
    $current = ($item.Target -join ';')
    if ($item.LinkType -eq 'Junction' -and $current -eq $target) {
      Write-Host "已正确链接: $dep"
      continue
    }
    Write-Host "替换旧链接: $dep（原 -> $current）" -ForegroundColor Yellow
    # 只删联接本身，绝不递归删除目标内容（Windows PowerShell 5.1 的
    # `Remove-Item -Recurse` 会穿透 junction 删掉目标里的文件）。
    [System.IO.Directory]::Delete($link, $false)
  }
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
  Write-Host "已链接: $dep -> $target"
}

$hostVersion = (Get-Content (Join-Path $deploy 'dsh-tools\package.json') -Raw | ConvertFrom-Json).version
Write-Host "依赖链接完成（镜像 dsh-tools = $hostVersion）。" -ForegroundColor Green

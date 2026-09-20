<#
.SYNOPSIS
  给 Dramatis 做一个能双击启动的快捷方式（桌面 / 开始菜单）。

.DESCRIPTION
  这不是「桌面壳」，而是把现成的启动器接进 Windows 的入口体系：图标、开始菜单搜索、
  双击即用。真正的应用窗口仍然是 Chromium 的 `--app` 模式（见 docs/DESKTOP.md 的结论）。

  快捷方式这么配：

  ```
  node <仓库>\tools\desktop\launch.mjs --prod
  ```

  用 `--prod`（生产构建）而不是 dev：日常使用要的是「打开就能用」，不是热更新；
  构建产物已经是最新的时候启动器会跳过构建（`--force-build` 可以强制重建）。

  命令行窗口会最小化留在任务栏上——**它就是本地服务**。关掉它，页面还能接着看，
  但刷新会连不上；要停服务就关它。

.EXAMPLE
  pwsh -File tools/desktop/install-shortcut.ps1
  pwsh -File tools/desktop/install-shortcut.ps1 -Destination Both -Force

.EXAMPLE
  # 只生成到一个指定目录（不改桌面、不改开始菜单）
  pwsh -File tools/desktop/install-shortcut.ps1 -TargetDirectory .\tmp-shortcut
#>
[CmdletBinding()]
param(
  [ValidateSet('Desktop', 'StartMenu', 'Both')]
  [string]$Destination = 'Desktop',

  [string]$Name = 'Dramatis · 登场',

  # 图标写在这里（不是仓库里）：它是本机生成的派生文件，不进版本库
  [string]$IconDirectory = (Join-Path $env:LOCALAPPDATA 'Dramatis'),

  # 只往这个目录里写快捷方式（验证用；给了它就不碰桌面与开始菜单）
  [string]$TargetDirectory,

  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
$launcher = Join-Path $repoRoot 'tools\desktop\launch.mjs'
$distIndex = Join-Path $repoRoot 'apps\web\dist\index.html'

if (-not (Test-Path $launcher)) { throw "找不到启动器：$launcher" }
if (-not (Test-Path $distIndex)) {
  Write-Warning '还没有生产构建（apps/web/dist/index.html 不存在）。启动器会自己构建一次，第一次双击会慢一些；想现在就好，先在仓库里跑 pnpm build。'
}

$node = (Get-Command node -ErrorAction SilentlyContinue)
if ($null -eq $node) { throw '找不到 node。请先装 Node 20 或更高版本，并保证它在 PATH 里。' }

# ---- 图标：把现成的 PNG 包成 .ico ----
#
# Windows 的 .ico 从 Vista 起允许直接塞 PNG，所以不需要图像库：
# 写一个 6 字节的文件头 + 每个尺寸 16 字的目录项 + 原样的 PNG 字节。
function New-IcoFromPng {
  param([string]$OutputPath, [array]$Sources)

  $entries = @()
  $images = New-Object System.IO.MemoryStream
  foreach ($src in $Sources) {
    $bytes = [System.IO.File]::ReadAllBytes($src)
    if ($bytes.Length -lt 24) { throw "$src 不是合法的 PNG。" }
    $width = ([int]$bytes[16] * 16777216) + ([int]$bytes[17] * 65536) + ([int]$bytes[18] * 256) + [int]$bytes[19]
    $height = ([int]$bytes[20] * 16777216) + ([int]$bytes[21] * 65536) + ([int]$bytes[22] * 256) + [int]$bytes[23]
    if ($width -gt 256 -or $height -gt 256) { continue }  # 目录项一个字节装不下更大的尺寸
    $entries += [pscustomobject]@{ Width = $width; Height = $height; Bytes = $bytes }
  }
  if ($entries.Count -eq 0) { throw '没有可用的方形图标源（需要 ≤256 的 PNG）。' }

  # ICONDIR：保留(2) + 类型(2，1=图标) + 图像数(2)
  $header = New-Object byte[] 6
  $header[2] = 1                                  # type = 1（图标）
  [BitConverter]::GetBytes([uint16]$entries.Count).CopyTo($header, 4)

  # ICONDIRENTRY × N：每个 16 字节，imageOffset 指向后面那段 PNG
  $offset = 6 + (16 * $entries.Count)
  $directory = New-Object System.IO.MemoryStream
  foreach ($entry in $entries) {
    $item = New-Object byte[] 16
    $item[0] = if ($entry.Width -ge 256) { 0 } else { [byte]$entry.Width }
    $item[1] = if ($entry.Height -ge 256) { 0 } else { [byte]$entry.Height }
    $item[2] = 0; $item[3] = 0
    [BitConverter]::GetBytes([uint16]1).CopyTo($item, 4)     # planes
    [BitConverter]::GetBytes([uint16]32).CopyTo($item, 6)    # bit count
    [BitConverter]::GetBytes([uint32]$entry.Bytes.Length).CopyTo($item, 8)
    [BitConverter]::GetBytes([uint32]$offset).CopyTo($item, 12)
    $directory.Write($item, 0, $item.Length)
    $offset += $entry.Bytes.Length
    $images.Write($entry.Bytes, 0, $entry.Bytes.Length)
  }

  # 顺序必须是「文件头 → 目录 → 图像数据」，偏移量就是照这个顺序算的
  $all = $header + $directory.ToArray() + $images.ToArray()

  $dir = Split-Path -Parent $OutputPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllBytes($OutputPath, $all)
  return $entries.Count
}

$iconPath = Join-Path $IconDirectory 'dramatis.ico'
$iconSources = @(
  (Join-Path $repoRoot 'apps\web\public\icon-192.png'),
  (Join-Path $repoRoot 'apps\web\public\favicon.png')
) | Where-Object { Test-Path $_ }

if ($iconSources.Count -gt 0) {
  $count = New-IcoFromPng -OutputPath $iconPath -Sources $iconSources
  Write-Host "图标：$iconPath（$count 个尺寸）"
} else {
  $iconPath = $null
  Write-Warning '找不到图标源（apps/web/public/icon-192.png），快捷方式会用默认图标。'
}

# ---- 快捷方式 ----
function New-Shortcut {
  param([string]$Path)

  if ((Test-Path $Path) -and -not $Force) {
    Write-Warning "$Path 已经存在，跳过（要覆盖加 -Force）。"
    return $false
  }

  $dir = Split-Path -Parent $Path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $node.Source
  $shortcut.Arguments = "`"$launcher`" --prod"
  $shortcut.WorkingDirectory = $repoRoot
  $shortcut.Description = 'Dramatis · 多角色扮演酒馆'
  $shortcut.WindowStyle = 7                        # 最小化：命令行就是本地服务，别占着屏幕
  if ($null -ne $iconPath) { $shortcut.IconLocation = "$iconPath,0" }
  $shortcut.Save()
  return $true
}

$targets = @()
if ($TargetDirectory) {
  $targets += (Join-Path (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force -Path $TargetDirectory)).Path "$Name.lnk")
} else {
  if ($Destination -eq 'Desktop' -or $Destination -eq 'Both') {
    $targets += (Join-Path ([Environment]::GetFolderPath('Desktop')) "$Name.lnk")
  }
  if ($Destination -eq 'StartMenu' -or $Destination -eq 'Both') {
    $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    $targets += (Join-Path $programs "$Name.lnk")
  }
}

$made = 0
foreach ($target in $targets) {
  if (New-Shortcut -Path $target) {
    Write-Host "已创建：$target"
    $made += 1
  }
}

Write-Host ''
Write-Host "完成：$made 个快捷方式。双击它会启动本地服务并打开应用窗口。"
Write-Host '命令行窗口是服务本体（已最小化）；关掉它就等于停服务。'
Write-Host '不想留常驻进程的话，也可以直接用「浏览器 → 安装应用」把 http://127.0.0.1:5273 装成 PWA。'

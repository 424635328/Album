# ============================================================
#  关闭风景画廊服务
#  用法:  stop-gallery.cmd              (双击即可)
#         pwsh build\stop-server.ps1 -DryRun   (只查看,不关闭)
#
#  说明:
#   * build\server.js 会在端口被占用时自动顺延(8420 → 8440),
#     历史上多次测试可能留下多个实例 —— 本脚本会全部清理。
#   * 同时按进程命令行兜底查找 build\server.js 实例,
#     即使端口已被释放也不会漏掉。
# ============================================================
[CmdletBinding()]
param([switch]$DryRun)

$ErrorActionPreference = 'SilentlyContinue'
$portRange = 8420..8450
$targets = [ordered]@{}

# 1) 按监听端口查找(8420-8450)
Get-NetTCPConnection -State Listen | Where-Object { $portRange -contains $_.LocalPort } | ForEach-Object {
  if (-not $targets.Contains($_.OwningProcess)) {
    $targets[$_.OwningProcess] = "监听端口 $($_.LocalPort)"
  }
}

# 2) 兜底:按命令行查找 build\server.js 实例
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -and ($_.CommandLine -like '*server.js*')
} | ForEach-Object {
  if (-not $targets.Contains($_.ProcessId)) {
    $targets[$_.ProcessId] = '命令行匹配 server.js'
  }
}

if ($targets.Count -eq 0) {
  Write-Host '  当前没有正在运行的画廊服务。' -ForegroundColor Yellow
  exit 0
}

Write-Host ("  发现 {0} 个画廊服务实例:" -f $targets.Count) -ForegroundColor Cyan
foreach ($procId in $targets.Keys) {
  $p = Get-Process -Id $procId
  $mem = if ($p) { [math]::Round($p.WorkingSet64 / 1MB) } else { 0 }
  Write-Host ("    PID {0,-7} {1,-22} 内存 {2} MB" -f $procId, $targets[$procId], $mem)
}

if ($DryRun) {
  Write-Host '  (DryRun: 未执行关闭)' -ForegroundColor Yellow
  exit 0
}

Write-Host '  正在关闭…' -ForegroundColor Cyan
foreach ($procId in $targets.Keys) {
  Stop-Process -Id $procId -Force
}
Start-Sleep -Milliseconds 1200

# 验证
$left = Get-NetTCPConnection -State Listen | Where-Object { $portRange -contains $_.LocalPort }
if ($left) {
  Write-Host '  ⚠ 仍有端口在监听,请重试或手动结束进程:' -ForegroundColor Red
  $left | ForEach-Object { Write-Host ("    PID {0} 端口 {1}" -f $_.OwningProcess, $_.LocalPort) -ForegroundColor Red }
  exit 1
} else {
  Write-Host '  ✓ 画廊服务已全部关闭。' -ForegroundColor Green
  Write-Host '    (重新打开:双击 start-gallery.cmd)' -ForegroundColor DarkGray
}

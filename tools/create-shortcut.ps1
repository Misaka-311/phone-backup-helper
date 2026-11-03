$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $root '手机备份助手.vbs'
$icon = Join-Path $root 'ui\icon.ico'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'

if (-not (Test-Path $vbs)) {
  Write-Host "找不到启动器：$vbs" -ForegroundColor Red
  exit 1
}

$shell = New-Object -ComObject WScript.Shell
$dirs = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
)

foreach ($dir in $dirs) {
  if (-not (Test-Path $dir)) { continue }
  $lnk = Join-Path $dir '手机备份助手.lnk'
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = $wscript
  $s.Arguments = '"' + $vbs + '"'
  $s.WorkingDirectory = $root
  if (Test-Path $icon) { $s.IconLocation = $icon + ',0' }
  $s.Description = '手机备份助手：手机/硬盘 → 硬盘/云盘'
  $s.WindowStyle = 1
  $s.Save()
  Write-Host ('已创建：' + $lnk)
}

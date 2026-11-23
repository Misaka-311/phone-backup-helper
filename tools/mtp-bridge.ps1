# MTP bridge for phone-backup-helper.
# Talks to a USB-connected phone through the Windows Shell (MTP / portable device),
# so it works WITHOUT enabling USB debugging.
#
# Protocol: request JSON file in, response JSON file out (both UTF-8, no BOM).
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File mtp-bridge.ps1 -Req <in> -Res <out>
#
# Request:
#   { action: 'probe' | 'list' | 'listMany' | 'copy',
#     device?: string, storage?: string,
#     path?: string[],  paths?: string[][],       // segments under the storage root (= /sdcard)
#     dir?: string[],   names?: string[], dest?: string, expect?: {name: size} }
# Response:
#   { ok, action, device, storages?, items?, listing?, copied?, error?, stage? }
#
# Keep this file pure ASCII: Windows PowerShell 5.1 reads .ps1 as ANSI.
# Unicode folder names are expressed as .NET regex \uXXXX escapes on purpose.

param(
  [Parameter(Mandatory = $true)][string]$ReqPath,
  [Parameter(Mandatory = $true)][string]$ResPath
)

$ErrorActionPreference = 'Stop'
$script:Result = $null
# Resolved Shell folders are memoized: MTP re-enumeration is the main cost when
# several paths are listed in one process.
$script:FolderCache = @{}

# Matches storage roots: internal shared storage / internal storage (Chinese names) / SD card
$script:StoragePattern = '\u5185\u90e8(\u5171\u4eab)?\u5b58\u50a8|Internal storage|Internal shared storage|Phone storage|SD card'

function New-Arr { return New-Object System.Collections.ArrayList }

function Write-Res {
  param($Obj)
  $json = $Obj | ConvertTo-Json -Depth 6 -Compress
  $enc = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($ResPath, $json, $enc)
}

function Get-Shell { return New-Object -ComObject Shell.Application }

function Get-PcItems {
  param($shell)
  return @($shell.NameSpace(17).Items())
}

# Candidate devices: top-level "This PC" items that contain a storage-like child.
function Find-Devices {
  param($shell, [string]$want)
  $found = New-Arr
  foreach ($item in (Get-PcItems $shell)) {
    if ($want -and $item.Name -ne $want) { continue }
    $kids = @()
    try {
      $folder = $item.GetFolder
      if (-not $folder) { continue }
      $kids = @($folder.Items())
    } catch { continue }
    $storages = New-Arr
    foreach ($k in $kids) {
      if ($k.Name -match $script:StoragePattern) { [void]$storages.Add([string]$k.Name) }
    }
    if ($storages.Count -gt 0) {
      [void]$found.Add([pscustomobject]@{ name = [string]$item.Name; storages = @($storages) })
    }
  }
  return @($found)
}

function Get-DeviceFolder {
  param($shell, [string]$deviceName)
  $items = Get-PcItems $shell
  if ($deviceName) {
    $hit = $items | Where-Object { $_.Name -eq $deviceName } | Select-Object -First 1
    if ($hit) { return $hit.GetFolder }
  }
  $devs = @(Find-Devices -shell $shell -want $deviceName)
  if ($devs.Count -eq 0) { throw 'NO_DEVICE' }
  $name = [string]$devs[0].name
  $hit = $items | Where-Object { $_.Name -eq $name } | Select-Object -First 1
  if (-not $hit) { throw 'NO_DEVICE' }
  return $hit.GetFolder
}

function Get-StorageFolder {
  param($shell, [string]$deviceName, [string]$storageName)
  $ck = 'S|' + $deviceName + '|' + $storageName
  if ($script:FolderCache.ContainsKey($ck)) { return $script:FolderCache[$ck] }
  $dev = Get-DeviceFolder -shell $shell -deviceName $deviceName
  $items = @($dev.Items())
  if ($storageName) {
    $hit = $items | Where-Object { $_.Name -eq $storageName } | Select-Object -First 1
    if ($hit) {
      $script:FolderCache[$ck] = $hit.GetFolder
      return $script:FolderCache[$ck]
    }
  }
  $hit = $items | Where-Object { $_.Name -match $script:StoragePattern } | Select-Object -First 1
  if (-not $hit) { throw 'NO_STORAGE' }
  $script:FolderCache[$ck] = $hit.GetFolder
  return $script:FolderCache[$ck]
}

# segments: [] = storage root, ['DCIM','Camera'] = /sdcard/DCIM/Camera
function Resolve-Folder {
  param($shell, [string]$deviceName, [string]$storageName, $segments)
  $key = 'F|' + $deviceName + '|' + $storageName + '|' + ((@($segments) | Where-Object { $_ }) -join '/')
  if ($script:FolderCache.ContainsKey($key)) { return $script:FolderCache[$key] }
  $folder = Get-StorageFolder -shell $shell -deviceName $deviceName -storageName $storageName
  foreach ($seg in @($segments)) {
    if (-not $seg) { continue }
    $hit = @($folder.Items()) | Where-Object { $_.Name -eq $seg -and $_.IsFolder } | Select-Object -First 1
    if (-not $hit) { throw ('NO_SUCH_DIR:' + $seg) }
    $folder = $hit.GetFolder
  }
  $script:FolderCache[$key] = $folder
  return $folder
}

function Get-EpochMs {
  param($value)
  if ($null -eq $value) { return 0 }
  try {
    $dt = $null
    if ($value -is [datetime]) { $dt = [datetime]$value }
    else {
      $s = [string]$value
      if (-not $s) { return 0 }
      $dt = [datetime]::Parse($s, [Globalization.CultureInfo]::InvariantCulture)
    }
    # Shell reports System.DateModified in UTC; label it UTC before converting.
    $utc = [DateTime]::SpecifyKind($dt, [DateTimeKind]::Utc)
    return [long]([DateTimeOffset]::new($utc).ToUnixTimeMilliseconds())
  } catch { return 0 }
}

function Get-Entry {
  param($item)
  $size = 0
  $mtime = 0
  $isDir = [bool]$item.IsFolder
  if (-not $isDir) {
    try {
      $v = $item.ExtendedProperty('System.Size')
      if ($null -ne $v) { $size = [long]$v }
    } catch { $size = 0 }
    try {
      $d = $item.ExtendedProperty('System.DateModified')
      $mtime = Get-EpochMs $d
    } catch { $mtime = 0 }
  }
  return [pscustomobject]@{
    name    = [string]$item.Name
    isDir   = $isDir
    size    = [long]$size
    mtimeMs = [long]$mtime
  }
}

function List-Folder {
  param($folder)
  $out = New-Arr
  foreach ($it in @($folder.Items())) { [void]$out.Add((Get-Entry $it)) }
  return @($out)
}

# Copy one file, wait until it lands with the expected size (MTP copy is asynchronous).
function Copy-One {
  param($destNS, $item, [string]$name, [string]$dest, [long]$want, [int]$timeoutMs = 300000)
  $target = Join-Path $dest $name
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try { $destNS.CopyHere($item, 0x14) } catch { return [pscustomobject]@{ name = $name; ok = $false; size = 0; error = $_.Exception.Message } }

  $lastSeen = -1
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    if (Test-Path -LiteralPath $target) {
      try {
        $len = [long](Get-Item -LiteralPath $target -Force).Length
        if ($want -gt 0) {
          if ($len -eq $want) { return [pscustomobject]@{ name = $name; ok = $true; size = $len; error = $null } }
        } elseif ($len -gt 0 -and $len -eq $lastSeen) {
          return [pscustomobject]@{ name = $name; ok = $true; size = $len; error = $null }
        }
        $lastSeen = $len
      } catch { }
    }
    Start-Sleep -Milliseconds 120
  }
  return [pscustomobject]@{ name = $name; ok = $false; size = 0; error = 'TIMEOUT' }
}

function Copy-Files {
  param($shell, $srcFolder, $names, [string]$dest, $expect)
  if (-not (Test-Path -LiteralPath $dest)) { [void][IO.Directory]::CreateDirectory($dest) }
  $destNS = $shell.NameSpace($dest)
  if (-not $destNS) { throw 'NO_DEST_NS' }

  $available = @{}
  foreach ($it in @($srcFolder.Items())) { $available[[string]$it.Name] = $it }

  $copied = New-Arr
  foreach ($n in @($names)) {
    if (-not $available.ContainsKey($n)) {
      [void]$copied.Add([pscustomobject]@{ name = $n; ok = $false; size = 0; error = 'NOT_FOUND' })
      continue
    }
    $want = 0
    if ($expect) {
      $prop = $expect.PSObject.Properties | Where-Object { $_.Name -eq $n } | Select-Object -First 1
      if ($prop) { $want = [long]$prop.Value }
    }
    [void]$copied.Add((Copy-One -destNS $destNS -item $available[$n] -name $n -dest $dest -want $want))
  }
  return @($copied)
}

try {
  $raw = [IO.File]::ReadAllText($ReqPath, (New-Object System.Text.UTF8Encoding($false)))
  $req = $raw | ConvertFrom-Json
  $action = [string]$req.action
  $shell = Get-Shell

  $deviceName = [string]$req.device
  $storageName = [string]$req.storage

  if ($action -eq 'probe') {
    $devs = @(Find-Devices -shell $shell -want $deviceName)
    $okProbe = ($devs.Count -gt 0)
    $devNameOut = $null
    $storOut = @()
    if ($okProbe) {
      $devNameOut = [string]$devs[0].name
      $storOut = @($devs[0].storages)
    }
    $script:Result = [pscustomobject]@{
      ok       = $okProbe
      action   = 'probe'
      devices  = @($devs | ForEach-Object { [pscustomobject]@{ name = $_.name; storages = @($_.storages) } })
      device   = $devNameOut
      storages = $storOut
    }
  }
  elseif ($action -eq 'list') {
    $folder = Resolve-Folder -shell $shell -deviceName $deviceName -storageName $storageName -segments $req.path
    $items = List-Folder -folder $folder
    $script:Result = [pscustomobject]@{
      ok      = $true
      action  = 'list'
      device  = $deviceName
      storage = $storageName
      items   = @($items)
    }
  }
  elseif ($action -eq 'count') {
    # Count files only: skip per-item ExtendedProperty calls (much faster)
    $counts = New-Arr
    foreach ($p in @($req.paths)) {
      try {
        $folder = Resolve-Folder -shell $shell -deviceName $deviceName -storageName $storageName -segments $p
        $n = 0
        foreach ($it in @($folder.Items())) { if (-not $it.IsFolder) { $n = $n + 1 } }
        [void]$counts.Add([pscustomobject]@{ path = @($p); count = $n })
      } catch {
        [void]$counts.Add([pscustomobject]@{ path = @($p); count = 0; error = $_.Exception.Message })
      }
    }
    $script:Result = [pscustomobject]@{
      ok      = $true
      action  = 'count'
      device  = $deviceName
      storage = $storageName
      counts  = @($counts)
    }
  }
  elseif ($action -eq 'listMany') {
    $listing = New-Arr
    foreach ($p in @($req.paths)) {
      try {
        $folder = Resolve-Folder -shell $shell -deviceName $deviceName -storageName $storageName -segments $p
        [void]$listing.Add([pscustomobject]@{ path = @($p); items = @(List-Folder -folder $folder) })
      } catch {
        [void]$listing.Add([pscustomobject]@{ path = @($p); items = @(); error = $_.Exception.Message })
      }
    }
    $script:Result = [pscustomobject]@{
      ok      = $true
      action  = 'listMany'
      device  = $deviceName
      storage = $storageName
      listing = @($listing)
    }
  }
  elseif ($action -eq 'copy') {
    $src = Resolve-Folder -shell $shell -deviceName $deviceName -storageName $storageName -segments $req.dir
    $copied = Copy-Files -shell $shell -srcFolder $src -names $req.names -dest ([string]$req.dest) -expect $req.expect
    $script:Result = [pscustomobject]@{
      ok     = $true
      action = 'copy'
      copied = @($copied)
    }
  }
  else {
    $script:Result = [pscustomobject]@{ ok = $false; error = ('UNKNOWN_ACTION:' + $action) }
  }
} catch {
  $msg = $_.Exception.Message
  $stage = 'unknown'
  if ($msg -like 'NO_DEVICE*') { $stage = 'no-device' }
  elseif ($msg -like 'NO_STORAGE*') { $stage = 'no-storage' }
  elseif ($msg -like 'NO_SUCH_DIR*') { $stage = 'no-dir' }
  elseif ($msg -like 'NO_DEST_NS*') { $stage = 'no-dest' }
  $script:Result = [pscustomobject]@{ ok = $false; error = $msg; stage = $stage }
}

Write-Res $script:Result

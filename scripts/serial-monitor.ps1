param(
  [string[]]$Ports = @('COM5', 'COM6'),
  [int]$Baud = 115200,
  [string]$LogDir = 'serial-logs'
)
$ErrorActionPreference = 'Continue'
$logFull = Join-Path $PSScriptRoot $LogDir
New-Item -ItemType Directory -Force -Path $logFull | Out-Null

function Open-Serial([string]$portName, [int]$baud) {
  try {
    $sp = New-Object System.IO.Ports.SerialPort $portName, $baud, 'None', 8, 'One'
    $sp.ReadTimeout = 300
    $sp.Open()
    Write-Host "[monitor] opened $portName @ $baud"
    return $sp
  } catch {
    Write-Host "[monitor] FAILED to open $portName : $($_.Exception.Message)"
    return $null
  }
}

$handles = @()
foreach ($p in $Ports) {
  $h = Open-Serial $p $Baud
  if ($h) { $handles += $h }
}
if ($handles.Count -eq 0) {
  Write-Host "[monitor] no port opened. Close Arduino IDE serial monitor if open, then rerun."
  exit 1
}
Write-Host "[monitor] listening, logs at: $logFull  (Ctrl+C to stop)"
while ($true) {
  foreach ($h in $handles) {
    try {
      if ($h.IsOpen) {
        $data = $h.ReadExisting()
        if ($data.Length -gt 0) {
          $time = Get-Date -Format 'HH:mm:ss.fff'
          Write-Host ("[$time][" + $h.PortName + "] " + $data) -NoNewline
          Add-Content -Path (Join-Path $logFull ($h.PortName + '.log')) -Value $data -NoNewline -Encoding utf8
        }
      }
    } catch {}
  }
  Start-Sleep -Milliseconds 120
}
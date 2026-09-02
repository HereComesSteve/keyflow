param(
  [ValidateSet('left', 'right', 'both')]
  [string]$Hand = 'both',
  [string]$Sketch = "$PSScriptRoot\..\trae\trae.ino",
  [string]$Cli = 'D:\app\arduino\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe',
  [string]$Fqbn = 'arduino:avr:uno',
  [int]$BootTimeoutSec = 15
)
# Flash script: compile + upload firmware via arduino-cli (for automation/agent use).
# Port map: COM6=left(master) COM5=right(slave); role stored in EEPROM, same firmware for both.
# Flow: check port free -> upload -> read serial until "Glove ready" boot log -> close serial.
$ErrorActionPreference = 'Stop'
$Sketch = (Resolve-Path $Sketch).Path
if (-not (Test-Path $Cli)) { Write-Host "[flash] ERROR: arduino-cli not found: $Cli"; exit 1 }

$ports = @()
if ($Hand -eq 'left' -or $Hand -eq 'both') { $ports += 'COM6' }
if ($Hand -eq 'right' -or $Hand -eq 'both') { $ports += 'COM5' }

# Pre-check: ports must be free (close Arduino IDE serial monitor first)
foreach ($p in $ports) {
  try {
    $sp = New-Object System.IO.Ports.SerialPort $p, 115200, 'None', 8, 'One'
    $sp.Open(); $sp.Close(); $sp.Dispose()
  } catch {
    Write-Host "[flash] ERROR: $p is busy, close serial monitor / other programs first"
    exit 1
  }
}

# Post-upload: wait for "Glove ready" boot log to confirm reboot done
function Wait-Boot([string]$portName, [int]$timeoutSec) {
  $sp = New-Object System.IO.Ports.SerialPort $portName, 115200, 'None', 8, 'One'
  $sp.ReadTimeout = 500
  try {
    $sp.Open()
    $sp.DiscardInBuffer()
    # Pulse DTR to reset the board (UNO auto-reset circuit), so boot log is re-printed
    $sp.DtrEnable = $false
    Start-Sleep -Milliseconds 100
    $sp.DtrEnable = $true
    Start-Sleep -Milliseconds 100
    $sp.DtrEnable = $false
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    $buf = ''
    while ((Get-Date) -lt $deadline) {
      try { $buf += $sp.ReadExisting() } catch {}
      if ($buf -match 'Glove ready') {
        $lines = $buf -split "`r?`n" | Where-Object { $_ -match 'Glove ready|Role:' }
        Write-Host "[flash] $portName boot OK: $($lines -join ' | ')"
        return $true
      }
      Start-Sleep -Milliseconds 200
    }
    $tail = $buf.Substring([Math]::Max(0, $buf.Length - 120))
    Write-Host "[flash] WARN: $portName no 'Glove ready' within ${timeoutSec}s (tail: $tail)"
    return $false
  } finally {
    $sp.Close(); $sp.Dispose()
  }
}

foreach ($p in $ports) {
  Write-Host ""
  Write-Host "===== [flash] compile+upload $Sketch -> $p ($Hand) ====="
  & $Cli upload -p $p --fqbn $Fqbn $Sketch
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[flash] FAILED on $p"
    exit $LASTEXITCODE
  }
  Write-Host "[flash] upload OK on $p, waiting for boot..."
  if (-not (Wait-Boot $p $BootTimeoutSec)) { exit 1 }
}
Write-Host ""
Write-Host "[flash] all done."
exit 0

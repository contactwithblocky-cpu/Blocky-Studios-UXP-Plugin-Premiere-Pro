param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$registryPath = Join-Path $env:APPDATA "Adobe\Adobe UXP Developer Tool\plugins_workspace.json"
$targetPattern = '(?i)[\\/]com\.blocky\.oracle(?:\.v\d+)?[\\/]manifest\.json$'

Write-Host "Blocky Studios UXP registry purge"
Write-Host "Registry: $registryPath"

if (-not (Test-Path -LiteralPath $registryPath)) {
  throw "UXP Developer Tool registry was not found: $registryPath"
}

$registry = Get-Content -Raw -LiteralPath $registryPath | ConvertFrom-Json
$oracleEntries = @($registry.plugins | Where-Object { $_.manifestPath -match $targetPattern })

if ($oracleEntries.Count -eq 0) {
  Write-Host "No Blocky Studios entries exist in the UXP Developer Tool registry."
  exit 0
}

Write-Host "Blocky Studios registrations scheduled for removal:"
$oracleEntries | ForEach-Object { Write-Host "  $($_.manifestPath)" }

if (-not $Force) {
  Write-Host "Dry run only. Re-run with -Force to stop Premiere/UDT and purge these entries."
  exit 0
}

$processNames = @("Adobe Premiere Pro", "Adobe UXP Developer Tools")
foreach ($processName in $processNames) {
  Get-Process -Name $processName -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "Stopping $($_.ProcessName) PID $($_.Id)"
    Stop-Process -Id $_.Id -Force
  }
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = "$registryPath.oracle-backup-$timestamp"
Copy-Item -LiteralPath $registryPath -Destination $backupPath
Write-Host "Backup: $backupPath"

$registry.plugins = @($registry.plugins | Where-Object { $_.manifestPath -notmatch $targetPattern })
$json = $registry | ConvertTo-Json -Depth 20 -Compress
Set-Content -LiteralPath $registryPath -Value $json -Encoding UTF8

Write-Host "Stale Blocky Studios registrations purged."
Write-Host "Restart Premiere and UXP Developer Tool, then add only the intended v4 manifest."

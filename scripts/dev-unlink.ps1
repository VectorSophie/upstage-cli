<#
.SYNOPSIS
    Removes the dev-link wrapper + marker written by scripts\dev-link.ps1.

.DESCRIPTION
    Restores nothing -- there is no Windows production installer to fall
    back to in this release (scripts\install.sh explicitly declines on
    Windows; see scripts\dev-link.ps1's header comment). This script only
    removes what dev-link.ps1 itself created, and leaves anything else
    (e.g. a hand-placed upstage.cmd) alone.

.EXAMPLE
    powershell -File scripts\dev-unlink.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$binDir = if ($env:UPSTAGE_BIN_DIR) { $env:UPSTAGE_BIN_DIR } else { Join-Path $env:USERPROFILE ".local\bin" }
$wrapper = Join-Path $binDir "upstage.cmd"
$markerFile = Join-Path (Join-Path $env:USERPROFILE ".upstage-cli") "dev-link.json"
$markerTag = "upstage-cli dev-link wrapper"

$removedAny = $false

if (Test-Path $wrapper) {
    $content = Get-Content $wrapper -Raw -ErrorAction SilentlyContinue
    if ($content -and $content.Contains($markerTag)) {
        Remove-Item $wrapper -Force
        Write-Host "Removed: $wrapper"
        $removedAny = $true
    } else {
        Write-Warning "$wrapper exists but doesn't look like a dev-link wrapper -- leaving it alone."
    }
} else {
    Write-Host "No wrapper found at $wrapper."
}

if (Test-Path $markerFile) {
    Remove-Item $markerFile -Force
    Write-Host "Removed: $markerFile"
    $removedAny = $true
} else {
    Write-Host "No dev-link marker found at $markerFile."
}

if (-not $removedAny) {
    Write-Host "Nothing to unlink."
}

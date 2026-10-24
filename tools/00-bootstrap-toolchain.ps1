# tools/00-bootstrap-toolchain.ps1  --  RUN AS ADMINISTRATOR
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\00-bootstrap-toolchain.ps1
#
# Installs:
#   1. Visual Studio 2022 Build Tools + "Desktop development with C++" + Windows 11 SDK
#   2. depot_tools into F:\depot_tools, added to the user PATH
#
# Size: ~7-10 GB download, 30-60 minutes, may require a reboot.
# Chinese runbook: chromium/README.md  (section 2, step 0)
#
# ---------------------------------------------------------------------------
# WHY THIS FILE IS PURE ASCII
# ---------------------------------------------------------------------------
# Windows PowerShell 5.1 reads a .ps1 with no BOM as ANSI, NOT UTF-8.
# A previous version of this file had Chinese string literals; PowerShell
# mangled the bytes, terminated string literals early, and the whole script
# failed to parse with "Unexpected token" errors -- the install never ran.
# Keeping this file ASCII-only removes the entire failure class.
# Chinese documentation lives in chromium/README.md instead.
# ---------------------------------------------------------------------------
#
# NOTE: $ErrorActionPreference = 'Stop' does NOT catch native command failures
# (winget / git returning non-zero do not throw). Every native call below is
# wrapped in Invoke-Native, which checks $LASTEXITCODE explicitly.

$ErrorActionPreference = 'Stop'

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Administrator privileges required. Re-open PowerShell as Administrator."
    }
}

function Invoke-Native {
    param([string]$What, [scriptblock]$Cmd)
    & $Cmd
    if ($LASTEXITCODE -ne 0) {
        throw "$What FAILED (exit $LASTEXITCODE). See the raw output above."
    }
}

Assert-Admin

$wingetId = 'Microsoft.VisualStudio.2022.BuildTools'

Write-Host "=== 1/3 Visual Studio 2022 Build Tools ===" -ForegroundColor Cyan
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget not found. Install 'App Installer' from the Microsoft Store and retry."
}

# Base package first (idempotent).
Invoke-Native "winget install BuildTools (base)" {
    winget install --id $wingetId --accept-package-agreements --accept-source-agreements --disable-interactivity
}

# Then the C++ workload + Windows SDK via --override.
# The SDK component id is version-specific; if it is rejected we retry with only
# the recommended set so the install still completes. Unverified until first
# real run -- see chromium/README.md section 3.
#
# NOTE: Microsoft.VisualStudio.Component.VC.ATL is REQUIRED and is NOT part of
# --includeRecommended for BuildTools. Chromium includes <atldef.h> from
# base/win/atl_throw.h; without ATL the build dies at
#   base/win/atl_throw.h(35,10): fatal error: 'atldef.h' file not found
# Component ids verified against the local VS catalog (19354 packages).
$overrideFull = "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows11SDK.26100 --add Microsoft.VisualStudio.Component.VC.ATL --includeRecommended"
$overrideLite = "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.ATL --includeRecommended"

Write-Host "  -> trying with pinned Windows 11 SDK component id"
$fullOk = $true
try {
    & winget install --id $wingetId --accept-package-agreements --accept-source-agreements `
        --disable-interactivity --override $overrideFull
    if ($LASTEXITCODE -ne 0) { $fullOk = $false }
} catch {
    $fullOk = $false
}
if (-not $fullOk) {
    Write-Host "  -> pinned SDK id rejected (exit $LASTEXITCODE); retrying with --includeRecommended only" -ForegroundColor Yellow
    Invoke-Native "winget install BuildTools (workload + recommended)" {
        winget install --id $wingetId --accept-package-agreements --accept-source-agreements `
            --disable-interactivity --override $overrideLite
    }
} else {
    Write-Host "  -> OK"
}

Write-Host "=== 2/3 depot_tools ===" -ForegroundColor Cyan
$depot = 'F:\depot_tools'
if (-not (Test-Path $depot)) {
    Invoke-Native "git clone depot_tools" {
        git clone --depth=1 https://chromium.googlesource.com/chromium/tools/depot_tools.git $depot
    }
} else {
    Write-Host "  already present, skipping clone: $depot"
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$depot*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$depot", 'User')
    Write-Host "  added $depot to the user PATH (REOPEN your terminal)"
} else {
    Write-Host "  PATH already contains $depot"
}

Write-Host "=== 3/3 Verify ===" -ForegroundColor Cyan
$failures = @()

$cl = & where.exe cl.exe 2>$null
if (-not $cl) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
        $vcTools = & $vswhere -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($vcTools) {
            Write-Host "  vswhere reports VC tools at: $vcTools"
        } else {
            $failures += "VC toolchain (workload VCTools) was NOT installed"
        }
    } else {
        $failures += "cl.exe not found, and vswhere.exe is missing too"
    }
} else {
    Write-Host "  cl.exe: $($cl[0])"
}

$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\Include'
if (-not (Test-Path $sdkRoot)) {
    $failures += "Windows SDK not installed (missing $sdkRoot)"
} else {
    Write-Host "  Windows SDK Include:"
    Get-ChildItem $sdkRoot | ForEach-Object { Write-Host "    $($_.Name)" }
}

if ($failures.Count -gt 0) {
    Write-Host ""
    Write-Host "=== VERIFY FAILED ===" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    Write-Host ""
    Write-Host "Do NOT continue. Common causes:" -ForegroundColor Yellow
    Write-Host "  * component id does not match your VS version (chromium/README.md section 3)"
    Write-Host "  * the installer is still running in the background -- open 'Visual Studio Installer'"
    exit 1
}

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host "Reopen a terminal, then confirm:"
Write-Host "  gclient --version"
Write-Host "  where.exe cl.exe"
Write-Host ""
Write-Host "Then run:"
Write-Host "  tools\10-fetch-chromium.sh"
Write-Host "  tools\20-rebase.sh --dry-run"

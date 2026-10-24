# 需要**以管理员身份**运行的 PowerShell
#
#   tools\00-bootstrap-toolchain.ps1
#
# 装两样东西:
#   1. Visual Studio 2022 Build Tools + "使用 C++ 的桌面开发" 工作负载 + Windows 11 SDK
#   2. depot_tools(拉到 F:\depot_tools 并加进用户 PATH)
#
# 规模:约 7–10 GB 下载,30–60 分钟,可能需要重启。
# 依据:chromium/README.md §二 第 0 步。
#
# 注意:`$ErrorActionPreference = 'Stop'` **管不住原生命令**(winget/git 返回非 0 不会抛异常),
# 所以每一处原生命令后面都显式检查 `$LASTEXITCODE`。这是本脚本最容易出的静默失败。

$ErrorActionPreference = 'Stop'

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "需要管理员权限。请以管理员身份重开 PowerShell 后重跑本脚本。"
    }
}

function Invoke-Native {
    param([string]$What, [scriptblock]$Cmd)
    & $Cmd
    if ($LASTEXITCODE -ne 0) {
        throw "$What 失败(exit $LASTEXITCODE)。上面的输出里有 winget/安装器的原始报错。"
    }
}

Assert-Admin

Write-Host "=== 1/3 Visual Studio 2022 Build Tools ===" -ForegroundColor Cyan
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "找不到 winget。请从 Microsoft Store 安装「应用安装程序」(App Installer)后重试。"
}

# 注意:包 ID 与工作负载/SDK 组件 ID 需在首次实跑时核对(chromium/README.md §三)
Invoke-Native "winget 安装 BuildTools 基础包" {
    winget install --id Microsoft.VisualStudio.2022.BuildTools `
        --accept-package-agreements --accept-source-agreements
}

Invoke-Native "winget 追加 C++ 工作负载与 Windows SDK" {
    winget install --id Microsoft.VisualStudio.2022.BuildTools `
        --accept-package-agreements --accept-source-agreements `
        --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows11SDK.26100 --includeRecommended"
}

Write-Host "=== 2/3 depot_tools ===" -ForegroundColor Cyan
$depot = 'F:\depot_tools'
if (-not (Test-Path $depot)) {
    Invoke-Native "git clone depot_tools" {
        git clone --depth=1 https://chromium.googlesource.com/chromium/tools/depot_tools.git $depot
    }
} else {
    Write-Host "已存在,跳过 clone:$depot"
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$depot*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$depot", 'User')
    Write-Host "已把 $depot 加进用户 PATH(**需要重开终端**)"
} else {
    Write-Host "PATH 里已有 $depot"
}

Write-Host "=== 3/3 校验 ===" -ForegroundColor Cyan
$failures = @()

# cl.exe 由 VS Build Tools 提供;找得到才算装成
$cl = & where.exe cl.exe 2>$null
if (-not $cl) {
    # 退一步:用 vswhere 问 VS 安装器
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
        $vcTools = & $vswhere -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($vcTools) { Write-Host "vswhere 报 VC 工具链在:$vcTools" } else { $failures += "VC 工具链(工作负载 VCTools)未装成" }
    } else {
        $failures += "找不到 cl.exe,也找不到 vswhere.exe"
    }
} else {
    Write-Host "cl.exe: $($cl[0])"
}

$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\Include'
if (-not (Test-Path $sdkRoot)) { $failures += "Windows SDK 未装成(缺 $sdkRoot)" } else {
    Write-Host "Windows SDK Include 目录:"
    Get-ChildItem $sdkRoot | ForEach-Object { Write-Host "  $($_.Name)" }
}

if ($failures.Count -gt 0) {
    Write-Host ""
    Write-Host "=== 校验未通过 ===" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    Write-Host ""
    Write-Host "别急着往下走 —— 请把上面的原始报错贴出来。常见原因:" -ForegroundColor Yellow
    Write-Host "  * 组件 ID 与当前 VS 版本不匹配(见 chromium/README.md §三 第 1 条)"
    Write-Host "  * 安装器还在后台跑(打开「Visual Studio Installer」看进度)"
    exit 1
}

Write-Host @"

=== 完成 ===
重开一个终端,确认:
  gclient --version
  where.exe cl.exe

然后跑:
  tools\10-fetch-chromium.sh
  tools\20-rebase.sh --dry-run
"@ -ForegroundColor Green

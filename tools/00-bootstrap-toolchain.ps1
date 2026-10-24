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

$ErrorActionPreference = 'Stop'

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "需要管理员权限。请以管理员身份重开 PowerShell 后重跑本脚本。"
    }
}
Assert-Admin

Write-Host "=== 1/2 Visual Studio 2022 Build Tools ===" -ForegroundColor Cyan
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "找不到 winget。请从 Microsoft Store 安装「应用安装程序」后重试。"
}

# 注意:包 ID 与工作负载参数需在首次实跑时核对(chromium/README.md §五)
winget install --id Microsoft.VisualStudio.2022.BuildTools --accept-package-agreements --accept-source-agreements
winget install --id Microsoft.VisualStudio.2022.BuildTools `
    --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows11SDK.26100 --includeRecommended"

Write-Host "=== 2/2 depot_tools ===" -ForegroundColor Cyan
$depot = 'F:\depot_tools'
if (-not (Test-Path $depot)) {
    git clone --depth=1 https://chromium.googlesource.com/chromium/tools/depot_tools.git $depot
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

Write-Host @"

=== 完成 ===
重开一个终端,确认:
  gclient --version
  where.exe cl.exe          # 应由 VS Build Tools 提供

然后跑:
  tools\10-fetch-chromium.sh
  tools\20-rebase.sh --dry-run
"@ -ForegroundColor Green

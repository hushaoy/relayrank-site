#Requires -RunAsAdministrator
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Domain,

  [string]$Email = "",

  [string]$AdminPassword = "",

  [string]$KeyEncryptionKey = "",

  [string]$InstallDir = "C:\apps\relayrank",

  [string]$DataDir = "C:\ProgramData\RelayRank",

  [string]$CaddyDir = "C:\tools\caddy",

  [string]$NssmPath = "C:\tools\nssm.exe",

  [string]$ZipPath = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step([string]$Text) {
  Write-Host ""
  Write-Host "==> $Text" -ForegroundColor Cyan
}

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "请以管理员身份运行 PowerShell。"
  }
}

function Invoke-Download([string]$Url, [string]$OutFile) {
  Write-Host "下载: $Url"
  $params = @{ Uri = $Url; OutFile = $OutFile }
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    $params.UseBasicParsing = $true
  }
  Invoke-WebRequest @params
  if (Test-Path $OutFile) {
    Unblock-File -Path $OutFile -ErrorAction SilentlyContinue
  }
}

function Find-Node {
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $candidate = Join-Path $env:ProgramFiles "nodejs\node.exe"
  if (Test-Path $candidate) { return $candidate }

  return $null
}

function Install-Node22 {
  Write-Step "安装 Node.js 22 LTS"

  $indexUrl = "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt"
  $index = Invoke-WebRequest -Uri $indexUrl -UseBasicParsing
  $entry = ($index.Content -split "`n" |
    Where-Object { $_ -match "node-v22\.\d+\.\d+-x64\.msi$" } |
    Select-Object -First 1)

  if (-not $entry) {
    throw "没有找到 Node.js 22 x64 MSI 下载地址。"
  }

  $parts = $entry.Trim() -split "\s+"
  $expected = $parts[0].ToUpperInvariant()
  $fileName = $parts[-1]
  $msi = Join-Path $env:TEMP $fileName

  Invoke-Download "https://nodejs.org/dist/latest-v22.x/$fileName" $msi

  $actual = (Get-FileHash $msi -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($actual -ne $expected) {
    throw "Node.js 安装包校验失败。"
  }

  $process = Start-Process msiexec.exe `
    -ArgumentList @("/i", "`"$msi`"", "/qn", "/norestart") `
    -Wait -PassThru

  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
    throw "Node.js 安装失败，退出码: $($process.ExitCode)"
  }

  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath"

  $installed = Join-Path $env:ProgramFiles "nodejs\node.exe"
  if (Test-Path $installed) {
    return $installed
  }

  $node = Find-Node
  if (-not $node) {
    throw "Node.js 安装后没有找到 node.exe。"
  }

  return $node
}

function Ensure-Node {
  $node = Find-Node
  if ($node) {
    $version = (& $node -v).Trim()
    if ($version -match "^v(\d+)\." -and [int]$Matches[1] -ge 18) {
      Write-Host "使用已有 Node.js: $version ($node)"
      return $node
    }
  }

  $node = Install-Node22
  $version = (& $node -v).Trim()
  Write-Host "Node.js 已安装: $version ($node)"
  return $node
}

function Ensure-Nssm {
  if (Test-Path $NssmPath) {
    return
  }

  $parent = Split-Path $NssmPath -Parent
  New-Item -ItemType Directory -Force $parent | Out-Null

  $bundled = Join-Path $sourceDir "tools\nssm.exe"
  if (Test-Path $bundled) {
    Copy-Item $bundled $NssmPath -Force
    Unblock-File -Path $NssmPath -ErrorAction SilentlyContinue
    Write-Host "使用发行包内置 NSSM: $NssmPath"
    return
  }

  Write-Step "下载 NSSM"
  $zip = Join-Path $env:TEMP "nssm-2.24.zip"
  $extract = Join-Path $env:TEMP "nssm-2.24"
  $urls = @(
    "https://nssm.cc/download/nssm-2.24.zip",
    "https://nssm.cc/release/nssm-2.24.zip"
  )

  $downloaded = $false
  foreach ($url in $urls) {
    try {
      Invoke-Download $url $zip
      $downloaded = $true
      break
    } catch {
      Write-Host "NSSM 下载失败，尝试下一个地址: $url"
    }
  }

  if (-not $downloaded) {
    throw "NSSM 下载失败，发行包中也没有 tools\nssm.exe。"
  }

  if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
  Expand-Archive $zip $extract -Force

  $exe = Get-ChildItem $extract -Recurse -Filter "nssm.exe" |
    Where-Object { $_.FullName -match "\\win64\\" } |
    Select-Object -First 1

  if (-not $exe) {
    throw "NSSM 压缩包中没有 win64\nssm.exe。"
  }

  Copy-Item $exe.FullName $NssmPath -Force
}

function Ensure-Caddy {
  $caddyExe = Join-Path $CaddyDir "caddy.exe"
  if (Test-Path $caddyExe) {
    try {
      & $caddyExe version 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) {
        return $caddyExe
      }
    } catch {
      # 文件损坏或被拦截，重新下载
    }
  }

  Write-Step "安装 Caddy"
  New-Item -ItemType Directory -Force $CaddyDir | Out-Null

  Invoke-Download "https://caddyserver.com/api/download?os=windows&arch=amd64" $caddyExe

  if (-not (Test-Path $caddyExe)) {
    throw "Caddy 下载后没有找到 caddy.exe。"
  }

  try {
    & $caddyExe version 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }
  } catch {
    throw "Caddy 下载文件无法执行，请检查服务器网络或安全软件拦截。"
  }

  return $caddyExe
}

function Remove-OurService([string]$Name) {
  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $service) { return }

  Write-Host "停止并移除旧服务: $Name"
  & $NssmPath stop $Name 2>$null | Out-Null

  for ($i = 0; $i -lt 20; $i++) {
    $current = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $current -or $current.Status -eq "Stopped") { break }
    Start-Sleep -Milliseconds 500
  }

  & $NssmPath remove $Name confirm 2>$null | Out-Null
  Start-Sleep -Milliseconds 700
}

function Set-AclForLocalService([string]$Path, [string]$Rights) {
  if (-not (Test-Path $Path)) { return }
  & icacls $Path /grant "*S-1-5-19:(OI)(CI)$Rights" /T | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "设置 ACL 失败: $Path"
  }
}

function Assert-PortFree([int]$Port) {
  $listeners = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if (-not $listeners) { return }

  $owners = @()
  foreach ($listener in $listeners) {
    $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if ($process) {
      $owners += "$($process.ProcessName) (PID $($process.Id))"
    }
  }

  throw "端口 $Port 已被占用: $($owners -join ', ')。先停掉占用程序，Caddy 需要独占 80/443。"
}

function Install-RelayRankService([string]$NodeExe, [string[]]$EnvironmentLines) {
  Write-Step "注册 RelayRank 服务"

  Remove-OurService "RelayRank"

  & $NssmPath install RelayRank $NodeExe | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "NSSM 创建 RelayRank 服务失败。" }

  $serverJs = Join-Path $InstallDir "server.js"
  $nodeArgs = '"' + $serverJs + '"'

  & $NssmPath set RelayRank AppParameters $nodeArgs | Out-Null
  & $NssmPath set RelayRank AppDirectory $InstallDir | Out-Null
  & $NssmPath set RelayRank ObjectName "NT AUTHORITY\LocalService" | Out-Null
  & $NssmPath set RelayRank Start SERVICE_AUTO_START | Out-Null

  & $NssmPath set RelayRank AppStdout (Join-Path $DataDir "logs\stdout.log") | Out-Null
  & $NssmPath set RelayRank AppStderr (Join-Path $DataDir "logs\stderr.log") | Out-Null
  & $NssmPath set RelayRank AppRotateFiles 1 | Out-Null
  & $NssmPath set RelayRank AppRotateOnline 1 | Out-Null
  & $NssmPath set RelayRank AppRotateBytes 10485760 | Out-Null

  $paramsKey = "HKLM:\SYSTEM\CurrentControlSet\Services\RelayRank\Parameters"
  New-Item -Path $paramsKey -Force | Out-Null
  New-ItemProperty `
    -Path $paramsKey `
    -Name AppEnvironmentExtra `
    -PropertyType MultiString `
    -Value $EnvironmentLines `
    -Force | Out-Null
}

function Install-CaddyService([string]$CaddyExe, [string]$CaddyFile) {
  Write-Step "注册 Caddy 服务"

  Remove-OurService "Caddy"

  & $NssmPath install Caddy $CaddyExe | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "NSSM 创建 Caddy 服务失败。" }

  $caddyArgs = 'run --config "' + $CaddyFile + '" --adapter caddyfile'

  & $NssmPath set Caddy AppParameters $caddyArgs | Out-Null
  & $NssmPath set Caddy AppDirectory $CaddyDir | Out-Null
  & $NssmPath set Caddy ObjectName "NT AUTHORITY\LocalService" | Out-Null
  & $NssmPath set Caddy Start SERVICE_AUTO_START | Out-Null

  & $NssmPath set Caddy AppStdout "C:\ProgramData\Caddy\caddy-out.log" | Out-Null
  & $NssmPath set Caddy AppStderr "C:\ProgramData\Caddy\caddy-err.log" | Out-Null
  & $NssmPath set Caddy AppRotateFiles 1 | Out-Null
  & $NssmPath set Caddy AppRotateOnline 1 | Out-Null
  & $NssmPath set Caddy AppRotateBytes 10485760 | Out-Null
}

Assert-Admin

$Domain = $Domain.Trim().TrimEnd(".").ToLowerInvariant()
if ($Domain -notmatch "^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$") {
  throw "域名格式不正确: $Domain"
}

if (-not $Email) {
  $Email = "admin@$Domain"
}
if ($Email -notmatch "^[^@\s]+@[^@\s]+\.[^@\s]+$") {
  throw "邮箱格式不正确: $Email"
}

Write-Host "目标域名: $Domain"
Write-Host "安装目录: $InstallDir"
Write-Host "数据目录: $DataDir"

# 1. 源文件
$sourceDir = $PSScriptRoot
if (-not (Test-Path (Join-Path $sourceDir "server.js"))) {
  if (-not $ZipPath -or -not (Test-Path $ZipPath)) {
    throw "deploy-windows.ps1 需要放在发行包根目录，或用 -ZipPath 指定发行包 zip。"
  }

  $tempRelease = Join-Path $env:TEMP ("relayrank-release-" + [guid]::NewGuid().ToString("N"))
  Expand-Archive $ZipPath $tempRelease -Force
  $candidate = Get-ChildItem $tempRelease -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName "server.js") } |
    Select-Object -First 1

  if (-not $candidate) {
    throw "发行包内没有找到 server.js。"
  }
  $sourceDir = $candidate.FullName
}

# 2. 目录
Write-Step "创建目录"
$dirs = @($InstallDir, $DataDir, (Join-Path $DataDir "logs"), $CaddyDir, "C:\ProgramData\Caddy", "C:\tools")
foreach ($dir in $dirs) {
  New-Item -ItemType Directory -Force $dir | Out-Null
}

$dbFile = Join-Path $DataDir "db.json"
$hasExistingDb = Test-Path $dbFile
$keyWasProvided = -not [string]::IsNullOrWhiteSpace($KeyEncryptionKey)
$adminWasProvided = -not [string]::IsNullOrWhiteSpace($AdminPassword)

if ($hasExistingDb) {
  $dbRaw = Get-Content $dbFile -Raw -Encoding UTF8
  if ($dbRaw -match "enc:v1:" -and -not $keyWasProvided) {
    throw "现有数据库包含加密 API Key。请用 -KeyEncryptionKey 传入原 Key。"
  }
}

if (-not $hasExistingDb -and -not $adminWasProvided) {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  $AdminPassword = [Convert]::ToBase64String($bytes).Replace("+", "A").Replace("/", "B").Replace("=", "")
}

if ($AdminPassword -and $AdminPassword.Length -lt 12) {
  throw "AdminPassword 至少 12 位。"
}

if ([string]::IsNullOrWhiteSpace($KeyEncryptionKey)) {
  $keyBytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($keyBytes)
  $rng.Dispose()
  $KeyEncryptionKey = [Convert]::ToBase64String($keyBytes)
}

try {
  $decodedKey = [Convert]::FromBase64String($KeyEncryptionKey)
  if ($decodedKey.Length -ne 32) { throw "长度不是 32 字节" }
} catch {
  throw "KeyEncryptionKey 必须是 32 字节 base64。"
}

# 3. 安装依赖
$nodeExe = Ensure-Node
Ensure-Nssm
$caddyExe = Ensure-Caddy

# 4. 停止旧服务，避免文件占用
Write-Step "停止旧服务"
Remove-OurService "RelayRank"
Remove-OurService "Caddy"

$iis = Get-CimInstance Win32_Service -Filter "Name='W3SVC'" -ErrorAction SilentlyContinue
if ($iis -and ($iis.State -eq "Running" -or $iis.StartMode -eq "Auto")) {
  throw "IIS 正在运行或设为自动启动，会占用 80/443。先停用 IIS 本站点，或改用 IIS ARR 方案。"
}

Assert-PortFree 80
Assert-PortFree 443
Assert-PortFree 8803

# 5. 复制程序
Write-Step "复制程序文件"
$sourceResolved = (Resolve-Path $sourceDir).Path.TrimEnd("\")
$installResolved = (Resolve-Path $InstallDir).Path.TrimEnd("\")

New-Item -ItemType Directory -Force (Join-Path $InstallDir "public\uploads") | Out-Null

if ($sourceResolved -ne $installResolved) {
  $excluded = @("data", "logs", "dist", "backup-20261028-prehardening", ".git", "node_modules", "tools")
  Get-ChildItem $sourceDir -Force | Where-Object { $excluded -notcontains $_.Name } | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $InstallDir $_.Name) -Recurse -Force
  }
}

# 6. 权限
Write-Step "设置 LocalService 权限"
Set-AclForLocalService $InstallDir "RX"
Set-AclForLocalService (Join-Path $InstallDir "public\uploads") "M"
Set-AclForLocalService $DataDir "M"
Set-AclForLocalService "C:\ProgramData\Caddy" "M"
Set-AclForLocalService "C:\tools" "RX"

# 7. 服务环境
$envLines = @(
  "NODE_ENV=production",
  "HOST=127.0.0.1",
  "PORT=8803",
  "TRUST_PROXY=1",
  "COOKIE_SECURE=1",
  "DATA_DIR=$DataDir",
  "LOG_DIR=$(Join-Path $DataDir 'logs')",
  "KEY_ENCRYPTION_KEY=$KeyEncryptionKey"
)

if ($AdminPassword) {
  $envLines += "ADMIN_PASSWORD=$AdminPassword"
}

# 8. Caddy 配置
Write-Step "生成 Caddyfile"
$caddyFile = Join-Path $CaddyDir "Caddyfile"
$caddyConfig = @"
{
    admin off
    email $Email
    storage file_system C:/ProgramData/Caddy
}

$Domain {
    encode zstd gzip

    reverse_proxy 127.0.0.1:8803 {
        header_up X-Real-IP {http.request.remote.host}
        header_up X-Forwarded-Proto https
    }
}
"@
Set-Content -Path $caddyFile -Value $caddyConfig -Encoding ASCII

# 9. 安装并启动 Node
Install-RelayRankService $nodeExe $envLines

Write-Step "启动 RelayRank"
& $NssmPath start RelayRank | Out-Null

$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8803/api/health" -TimeoutSec 2
    if ($health.ok) {
      $healthy = $true
      break
    }
  } catch {
    # 等待服务启动
  }
}

if (-not $healthy) {
  Write-Host "RelayRank 启动失败，日志如下：" -ForegroundColor Red
  Get-Content (Join-Path $DataDir "logs\stderr.log") -Tail 100 -ErrorAction SilentlyContinue
  Get-Content (Join-Path $DataDir "logs\stdout.log") -Tail 100 -ErrorAction SilentlyContinue
  throw "RelayRank 健康检查失败。"
}

if ($AdminPassword) {
  $relayParams = "HKLM:\SYSTEM\CurrentControlSet\Services\RelayRank\Parameters"
  $currentEnv = (Get-ItemProperty -Path $relayParams -Name AppEnvironmentExtra -ErrorAction SilentlyContinue).AppEnvironmentExtra
  if ($currentEnv) {
    $filteredEnv = @($currentEnv | Where-Object { $_ -notlike "ADMIN_PASSWORD=*" })
    New-ItemProperty `
      -Path $relayParams `
      -Name AppEnvironmentExtra `
      -PropertyType MultiString `
      -Value $filteredEnv `
      -Force | Out-Null
    Write-Host "已从服务环境移除 ADMIN_PASSWORD，管理员密码已写入数据库。"
  }
}

# 10. 防火墙，必须在 Caddy 申请证书前放行
Write-Step "配置 Windows 防火墙"
foreach ($port in @(80, 443)) {
  $name = "RelayRank TCP $port"
  Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule `
    -DisplayName $name `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort $port `
    -Action Allow | Out-Null
}

# 11. 安装并启动 Caddy
Install-CaddyService $caddyExe $caddyFile

Write-Step "启动 Caddy"
& $NssmPath start Caddy | Out-Null
Start-Sleep -Seconds 5

if ((Get-Service Caddy).Status -ne "Running") {
  Get-Content "C:\ProgramData\Caddy\caddy-err.log" -Tail 100 -ErrorAction SilentlyContinue
  throw "Caddy 启动失败。"
}

$httpsOk = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  try {
    $httpsHealth = Invoke-RestMethod -Uri "https://$Domain/api/health" -TimeoutSec 3
    if ($httpsHealth.ok) {
      $httpsOk = $true
      break
    }
  } catch {
    # 等待 DNS、证书和反向代理就绪
  }
}

if (-not $httpsOk) {
  Write-Host "HTTPS 健康检查失败，Caddy 日志如下：" -ForegroundColor Red
  Get-Content "C:\ProgramData\Caddy\caddy-err.log" -Tail 120 -ErrorAction SilentlyContinue
  throw "https://$Domain/api/health 没有返回正常结果。检查 DNS 是否指向本机、80/443 是否放行。"
}

# 12. 保存加密 Key 副本
$keyFile = Join-Path $DataDir "key-encryption.txt"
Set-Content -Path $keyFile -Value $KeyEncryptionKey -Encoding ASCII
& icacls $keyFile /inheritance:r /grant "*S-1-5-32-544:F" /grant "*S-1-5-18:F" | Out-Null

# 13. 输出
$initialAdmin = Join-Path $DataDir "initial-admin.txt"
Write-Host ""
Write-Host "部署完成。" -ForegroundColor Green
Write-Host "站点: https://$Domain/"
Write-Host "后台: https://$Domain/admin"
Write-Host "初始密码文件: $initialAdmin"
Write-Host "加密 Key 副本: $keyFile"
Write-Host ""
Write-Host "首次登录后修改管理员密码，并删除 initial-admin.txt。"
Write-Host "把 key-encryption.txt 离线备份，然后从服务器删除该文件。"

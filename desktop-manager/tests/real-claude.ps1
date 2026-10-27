# Installs the real Claude Desktop the way a user would - download and Add-AppxPackage through the
# manager's command line - then starts it with launch flags, checks them on the main process, and closes
# it. Manual CI runs only: it downloads the full installer. Saved with a BOM for Windows PowerShell 5.1.
param([Parameter(Mandatory = $true)][string]$Manager)
$ErrorActionPreference = 'Stop'
$script:failures = 0

function Check([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) { Write-Host "ok   $name $detail" } else { Write-Host "FAIL $name $detail"; $script:failures++ }
}

function Run-Manager([string[]]$cmd, [int]$timeoutSec = 120) {
    $out = Join-Path $env:TEMP ('cdm-' + [guid]::NewGuid().ToString('N') + '.txt')
    # Not -Wait: that also waits for every process the manager starts, i.e. for Claude itself.
    $p = Start-Process -FilePath $Manager -ArgumentList ($cmd + @('--out', $out, '--trace')) -PassThru
    $null = $p.Handle  # keeps ExitCode readable after the process is gone
    if (-not $p.WaitForExit($timeoutSec * 1000)) { Stop-Process -Id $p.Id -Force; throw "manager $($cmd -join ' ') did not finish in $timeoutSec s" }
    $text = if (Test-Path $out) { Get-Content $out -Raw -Encoding UTF8 } else { '' }
    Write-Host "> $($cmd -join ' ')  (exit $($p.ExitCode))"
    Write-Host $text
    return [pscustomobject]@{ Code = $p.ExitCode; Text = $text }
}

function Claude-Processes {
    @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -match '\\WindowsApps\\Claude_' })
}

Write-Host "Windows $([Environment]::OSVersion.Version), $env:PROCESSOR_ARCHITECTURE"
Check 'not installed before' ($null -eq (Get-AppxPackage -Name Claude))

# Portable settings next to the exe: launch flags only, no proxy (the runner goes out directly).
$settings = Join-Path (Split-Path $Manager) 'ClaudeDesktopManager.settings.json'
$profile = [ordered]@{ name = 'ci'; proxy = [ordered]@{ mode = 'direct'; viaLaunchFlags = $true; viaEnv = $false }; lang = 'en-US' }
$json = [ordered]@{ version = 1; selectedProfile = 'ci'; profiles = @($profile); options = [ordered]@{ gracefulTimeoutSec = 10 } } | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText($settings, $json)

# ---- download and install
$dl = Join-Path $env:TEMP 'claude-download'
$r = Run-Manager @('install', '--direct', '--dir', $dl) 1200
Check 'install: exit code 0' ($r.Code -eq 0)
Check 'install: downloaded' ($r.Text -match '下载完成')
Check 'install: package is by Anthropic' ($r.Text -match '安装包：Claude ')
Check 'install: signature checked before installing' ($r.Text -match '数字签名有效')
Get-ChildItem $dl | ForEach-Object { Write-Host "  $($_.Name)  $($_.Length) bytes" }
$pkg = Get-AppxPackage -Name Claude
Check 'install: package registered' ($null -ne $pkg) "$($pkg.PackageFullName)"
if ($null -eq $pkg) { Write-Host 'cannot continue'; exit 1 }
Check 'install: family name' ($pkg.PackageFamilyName -eq 'Claude_pzs8sxrjxfjjc') $pkg.PackageFamilyName
Write-Host "publisher: $($pkg.Publisher)"
$svc = Get-Service CoworkVMService -ErrorAction SilentlyContinue
Write-Host "CoworkVMService: $(if ($svc) { $svc.Status } else { 'not installed' })"

$r = Run-Manager @('install', '--direct', '--dir', $dl) 1200
Check 'install again: reuses the download' ($r.Text -match '之前已经下载好了')
Check 'install again: exit code 0' ($r.Code -eq 0)

$r = Run-Manager @('status')
Check 'status: MSIX install found' ($r.Text -match 'MSIX')

# ---- start through MSIX activation, with flags
$r = Run-Manager @('start') 180
Check 'start: exit code 0' ($r.Code -eq 0)
Check 'start: flags on the main process' ($r.Text -match '启动参数已生效')
Start-Sleep -Seconds 5
$procs = Claude-Processes
$main = $procs | Where-Object { $_.Name -ieq 'claude.exe' -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1
Check 'start: Claude running' ($null -ne $main) "($($procs.Count) processes)"
if ($main) {
    Write-Host "main: $($main.CommandLine)"
    Check 'start: --lang passed' ($main.CommandLine -match '--lang=en-US')
    Check 'start: --no-proxy-server passed' ($main.CommandLine -match '--no-proxy-server')
}
$r = Run-Manager @('status')
Check 'status: running' ($r.Text -match '正在运行')

# ---- stop, then start and kill
$r = Run-Manager @('stop') 120
Check 'stop: exit code 0' ($r.Code -eq 0)
Start-Sleep -Seconds 2
$left = @(Claude-Processes | Where-Object { $_.Name -ieq 'claude.exe' })
Check 'stop: no Claude.exe left' ($left.Count -eq 0) "($($left.Count) left)"

$r = Run-Manager @('start') 180
Check 'start again: exit code 0' ($r.Code -eq 0)
Start-Sleep -Seconds 5
$r = Run-Manager @('kill') 120
Check 'kill: exit code 0' ($r.Code -eq 0)
Start-Sleep -Seconds 2
$left = @(Claude-Processes | Where-Object { $_.Name -ieq 'claude.exe' })
Check 'kill: no Claude.exe left' ($left.Count -eq 0) "($($left.Count) left)"

Write-Host ''
if ($script:failures -gt 0) { Write-Host "$($script:failures) check(s) failed"; exit 1 }
Write-Host 'all checks passed'

# End-to-end test on a real Windows machine (CI): a fake Claude.exe in the old Squirrel install location,
# driven through the manager's command line. Saved with a BOM so Windows PowerShell 5.1 reads the Chinese text.
param(
    [Parameter(Mandatory = $true)][string]$Manager,
    [Parameter(Mandatory = $true)][string]$Fake
)
$ErrorActionPreference = 'Stop'
$script:failures = 0

function Check([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) { Write-Host "ok   $name $detail" } else { Write-Host "FAIL $name $detail"; $script:failures++ }
}

function Run-Manager([string[]]$cmd) {
    $out = Join-Path $env:TEMP ('cdm-' + [guid]::NewGuid().ToString('N') + '.txt')
    $p = Start-Process -FilePath $Manager -ArgumentList ($cmd + @('--out', $out)) -Wait -PassThru
    $text = if (Test-Path $out) { Get-Content $out -Raw -Encoding UTF8 } else { '' }
    Write-Host "> $($cmd -join ' ')  (exit $($p.ExitCode))"
    Write-Host $text
    return [pscustomobject]@{ Code = $p.ExitCode; Text = $text }
}

function Fake-Processes {
    @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($app, [StringComparison]::OrdinalIgnoreCase) })
}

function Current-Tz { (tzutil /g | Out-String).Trim() }

$app = Join-Path $env:LOCALAPPDATA 'AnthropicClaude\app-9.9.9'
New-Item -ItemType Directory -Force $app | Out-Null
Copy-Item $Fake (Join-Path $app 'claude.exe') -Force
$logDir = Join-Path $env:TEMP 'fakeclaude'
Remove-Item $logDir -Recurse -Force -ErrorAction SilentlyContinue

# Portable settings next to the exe: one profile with a proxy, a time zone, extra args and env.
$settings = Join-Path (Split-Path $Manager) 'ClaudeDesktopManager.settings.json'
$profile = [ordered]@{
    name = 'e2e'
    proxy = [ordered]@{ mode = 'manual'; scheme = 'http'; host = '127.0.0.1'; port = 7890; viaLaunchFlags = $true; viaPolicy = $false; viaEnv = $true }
    timeZoneId = 'Tokyo Standard Time'
    lang = 'en-US'
    extraArgs = '--spawn-gui'
    extraEnv = 'FOO=bar'
}
$json = [ordered]@{ version = 1; selectedProfile = 'e2e'; profiles = @($profile); options = [ordered]@{ gracefulTimeoutSec = 5; stopCoworkService = $false } } | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText($settings, $json)

$origTz = Current-Tz
if ($origTz -eq 'Tokyo Standard Time') { tzutil /s 'UTC'; $origTz = Current-Tz }
Write-Host "original time zone: $origTz"

# ---- start
$r = Run-Manager @('start')
Check 'start: exit code 0' ($r.Code -eq 0)
Start-Sleep -Seconds 3
$procs = Fake-Processes
$main = $procs | Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object -First 1
Check 'start: fake Claude running' ($null -ne $main) "($($procs.Count) processes)"
if ($null -eq $main) { Write-Host 'cannot continue'; exit 1 }
Check 'start: helper process' ((@($procs | Where-Object { $_.CommandLine -match '--type=renderer' })).Count -ge 1)
Check 'start: --proxy-server passed' ($main.CommandLine -match [regex]::Escape('--proxy-server=http://127.0.0.1:7890')) $main.CommandLine
Check 'start: --lang passed' ($main.CommandLine -match '--lang=en-US')
$mainLog = Get-Content (Join-Path $logDir "$($main.ProcessId).txt") -Raw
Check 'start: HTTPS_PROXY env' ($mainLog -match [regex]::Escape('HTTPS_PROXY=http://127.0.0.1:7890'))
Check 'start: extra env' ($mainLog -match 'FOO=bar')
Check 'start: Claude saw Tokyo time' ($mainLog -match 'TZ=Tokyo Standard Time') $mainLog
Check 'start: system time zone switched' ((Current-Tz) -eq 'Tokyo Standard Time')
$ping = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $main.ProcessId -and $_.Name -ieq 'ping.exe' } | Select-Object -First 1
$viewer = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $main.ProcessId -and $_.Name -ieq 'viewer.exe' } | Select-Object -First 1
Check 'start: console child (like an MCP server)' ($null -ne $ping)
Check 'start: window child (like VS Code)' ($null -ne $viewer)

$r = Run-Manager @('status')
Check 'status: running' ($r.Text -match '正在运行')

# ---- stop: WM_CLOSE first, then clean up what is left
$r = Run-Manager @('stop')
Check 'stop: exit code 0' ($r.Code -eq 0)
Start-Sleep -Seconds 1
$left = Fake-Processes
Check 'stop: no fake Claude process left' ($left.Count -eq 0) "($($left.Count) left)"
Check 'stop: closed gracefully first' ($r.Text -match '正常退出')
if ($ping) { Check 'stop: console child ended' ($null -eq (Get-Process -Id $ping.ProcessId -ErrorAction SilentlyContinue)) }
if ($viewer) { Check 'stop: window child kept' ($null -ne (Get-Process -Id $viewer.ProcessId -ErrorAction SilentlyContinue)) }
Check 'stop: time zone restored' ((Current-Tz) -eq $origTz) (Current-Tz)
if ($viewer) { Stop-Process -Id $viewer.ProcessId -Force -ErrorAction SilentlyContinue }

# ---- start again, then kill
$r = Run-Manager @('start')
Start-Sleep -Seconds 3
Check 'restart: running again' ((Fake-Processes).Count -ge 2)
$r = Run-Manager @('kill')
Check 'kill: exit code 0' ($r.Code -eq 0)
Start-Sleep -Seconds 1
Check 'kill: no fake Claude process left' ((Fake-Processes).Count -eq 0)
Check 'kill: did not wait for a graceful exit' ($r.Text -notmatch '正常退出')
Check 'kill: time zone restored' ((Current-Tz) -eq $origTz) (Current-Tz)

# `start` left a copy in the tray to restore the time zone later; it is not needed any more.
Get-Process ClaudeDesktopManager -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process viewer -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item $settings -Force -ErrorAction SilentlyContinue

if ($script:failures -gt 0) { Write-Host "$($script:failures) check(s) failed"; exit 1 }
Write-Host 'all end-to-end checks passed'

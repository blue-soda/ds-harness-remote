#requires -Version 7
<#
.SYNOPSIS
    Make the client stop answering for a while, so the Server declares it offline - then watch it recover.

.DESCRIPTION
    The client half runs inside the same process as its local shell, so suspending that process freezes
    both: its control connection stops sending pongs and its transports stop answering. This is the mirror
    image of desktop-silence.ps1, and it exercises the direction the Server owns:

      the Server drops a peer whose last accepted pong is older than DSH_SERVER_PEER_TIMEOUT_MS (45 s by
      default) when it checks, which it does once per DSH_SERVER_HEARTBEAT_INTERVAL_MS (20 s), so the
      declaration lands somewhere in [45 s, 65 s]. Dropping the peer drops every link it holds.

    On resume the client must notice the dead control connection, rebuild it, and then rebuild the link.
    The link is rebuilt by the quick window - at most two attempts inside ten seconds, both forced over
    relay - which keeps the user's view, Workspace and Session list in place. A window that runs out hands
    the session back to the local shell and the retry schedule takes over.

    Timings (measured 2026-10-08: declarations landed at 48 s and 57 s, and the link was ready in the same
    second the client resumed):
      -Seconds 30   the Server never declares it offline -> nothing happens at all, and the link survives
      -Seconds 90   declared offline; the Host is still up -> the quick window's first attempt recovers it
      -Seconds 400  still the same outcome: freezing only the client never removes the Host, so the window
                    recovers it whatever the duration. To see the fallback, the Host must be unreachable as
                    well - freeze it too (desktop-silence.ps1) or stop the Desktop's Host runtime.

    Every suspended process is resumed, including on Ctrl-C or an error.

.PARAMETER Seconds
    How long to keep the client silent. Default 90 (long enough for the Server to declare it offline).

.PARAMETER Port
    The client instance's local HTTP port, used to find the process to suspend. Default 63721.

.PARAMETER ProcessId
    Suspend only this process instead of the one listening on -Port.

.PARAMETER OutLog
    The instance's stdout log, printed after the resume. Default the isolated instance's log.

.PARAMETER List
    Only report which process would be suspended, then exit.

.EXAMPLE
    pwsh -File scripts/client-silence.ps1 -Seconds 90
#>
[CmdletBinding()]
param(
    [ValidateRange(5, 600)][int]$Seconds = 90,
    [int]$Port = 63721,
    [int]$ProcessId,
    [string]$OutLog = 'C:\Workspace\.dsh-remote-client\instance.out.log',
    [switch]$List
)

$ErrorActionPreference = 'Stop'

if (-not ('DshProcessControl' -as [type])) {
    Add-Type -Namespace DshProcessControl -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern System.IntPtr OpenProcess(int access, bool inherit, int pid);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern bool CloseHandle(System.IntPtr handle);
[System.Runtime.InteropServices.DllImport("ntdll.dll")]
public static extern int NtSuspendProcess(System.IntPtr handle);
[System.Runtime.InteropServices.DllImport("ntdll.dll")]
public static extern int NtResumeProcess(System.IntPtr handle);
'@
}

$SUSPEND_RESUME = 0x0800

if ($ProcessId) {
    $ids = @($ProcessId)
}
else {
    $owner = (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1).OwningProcess
    if (-not $owner) {
        Write-Error "No process is listening on port $Port. Is the client instance running? (use -ProcessId to pick one)"
    }
    # The client runtime and its local shell share this process, so one target is the whole client.
    $ids = @($owner) + @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $owner" | ForEach-Object { $_.ProcessId })
}

$targets = Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId }
if (-not $targets) { Write-Error 'No matching process found.' }
foreach ($target in $targets) {
    Write-Host ("target: pid={0} ({1}) started={2}" -f $target.ProcessId, $target.Name, $target.CreationDate)
}
if ($List) { return }

$errLog = Join-Path (Split-Path -Parent $OutLog) 'instance.err.log'
$before = if (Test-Path $OutLog) { (Get-Content $OutLog).Count } else { 0 }
$beforeErr = if (Test-Path $errLog) { (Get-Content $errLog).Count } else { 0 }

$handles = @()
try {
    foreach ($target in $targets) {
        $handle = [DshProcessControl.Native]::OpenProcess($SUSPEND_RESUME, $false, $target.ProcessId)
        if ($handle -eq [IntPtr]::Zero) {
            Write-Warning "OpenProcess failed for pid $($target.ProcessId); skipping it (run elevated to include it)"
            continue
        }
        [void][DshProcessControl.Native]::NtSuspendProcess($handle)
        $handles += [pscustomobject]@{ Pid = $target.ProcessId; Handle = $handle }
    }
    Write-Host ("suspended  {0:HH:mm:ss}  {1} process(es) for {2}s  (the client answers nothing; the page will look stuck)" -f (Get-Date), $handles.Count, $Seconds)
    Start-Sleep -Seconds $Seconds
}
finally {
    foreach ($entry in $handles) {
        [void][DshProcessControl.Native]::NtResumeProcess($entry.Handle)
        [void][DshProcessControl.Native]::CloseHandle($entry.Handle)
    }
    Write-Host ("resumed    {0:HH:mm:ss}  {1} process(es)  (the client continues where it stopped)" -f (Get-Date), $handles.Count)
}

# Give the recovery a moment to land, then show only what happened since the freeze began.
Start-Sleep -Seconds 20
Write-Host ''
Write-Host 'client log since the freeze (recovery chain):'
if (Test-Path $OutLog) {
    Get-Content $OutLog | Select-Object -Skip $before |
        Where-Object { $_ -match 'control connection|transport ready|reconnect|target switched|kept its view|gave up' } |
        ForEach-Object { '  ' + $_.Trim() }
}
Write-Host 'client errors since the freeze (non-stack lines):'
if (Test-Path $errLog) {
    Get-Content $errLog | Select-Object -Skip $beforeErr |
        Where-Object { $_ -notmatch '^\s+at ' -and $_.Trim() -notin @('', '}', '}') } |
        ForEach-Object { '  ' + $_.Trim() }
}
Write-Host @'

Expected, in order:
  [dsh-remote] server control connection online                      <- the control connection came back
  [dsh-remote] remote Harness link needs rebuilding; trying a quick reconnect {"attempts":2,"windowMs":10000}
  [dsh-remote] remote Harness session kept its view through a quick reconnect
  [dsh-remote] remote Harness reconnect finished {"reason":"link re-established"}
If the Host was down as well, the window fails instead and the schedule runs to:
  [dsh-remote] remote Harness reconnect gave up; staying in the local shell {"attempts":10}
'@

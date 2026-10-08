#requires -Version 7
<#
.SYNOPSIS
    Make the Desktop Host stop answering for a while, long enough for the Server to declare it offline.

.DESCRIPTION
    The Desktop's Host runtime runs inside one of the app's Electron processes. Suspending them freezes
    their event loops - timers stop, relay frames are neither handled nor answered - while the window
    itself stays open. A client therefore sees exactly the condition the two-level reconnect exists for:
    a probe with no answer.

    Every top-level process of the app is frozen (the Electron main process plus the electron-as-node
    sidecars, which all lack a --type= switch), because the Host runtime may live in any of them.

    What a client sees is decided by the Server's heartbeat, not by a probe of ours: a peer whose last
    accepted pong is older than DSH_SERVER_PEER_TIMEOUT_MS (45 s by default) is declared offline on the
    next check, and checks happen every DSH_SERVER_HEARTBEAT_INTERVAL_MS (20 s). The declaration therefore
    lands in [45 s, 65 s], and it drops the peer together with every link it holds.
      -Seconds 40   under the threshold  -> nothing should happen at all; the link survives
      -Seconds 90   declared offline, Host returns -> the client's quick window recovers it, view intact
      -Seconds 150  the window fails while the Host is still frozen -> fallback, then the retry schedule

    Every suspended process is resumed, including on Ctrl-C or an error.

.PARAMETER Seconds
    How long to keep the Host silent. Default 40 (one missed probe).

.PARAMETER DesktopPath
    The Desktop application directory to match in a process command line.

.PARAMETER ProcessId
    Suspend only these process ids instead of every match.

.PARAMETER List
    Only report which processes would be suspended, then exit.

.EXAMPLE
    pwsh -File scripts/desktop-silence.ps1 -Seconds 40
#>
[CmdletBinding()]
param(
    [ValidateRange(5, 600)][int]$Seconds = 40,
    [string]$DesktopPath = 'C:\Workspace\deepseek-harness\apps\desktop',
    [int[]]$ProcessId,
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

# Renderer, GPU and utility processes carry --type=; the app's own processes do not.
$targets = if ($ProcessId) {
    Get-CimInstance Win32_Process | Where-Object { $ProcessId -contains $_.ProcessId }
}
else {
    Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$DesktopPath*" -and $_.CommandLine -notmatch '--type=' }
}

if (-not $targets) {
    Write-Error "No Electron process found for '$DesktopPath'. Is the Desktop running? (use -ProcessId to pick one)"
}
foreach ($target in $targets) {
    $shape = if ($target.CommandLine -match '--inspect=') { 'main' } else { 'sidecar' }
    Write-Host ("target: pid={0} ({1}) started={2}" -f $target.ProcessId, $shape, $target.CreationDate)
}
if ($List) { return }

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
    Write-Host ("suspended  {0:HH:mm:ss}  {1} process(es) for {2}s  (the Desktop window will look frozen)" -f (Get-Date), $handles.Count, $Seconds)
    Start-Sleep -Seconds $Seconds
}
finally {
    foreach ($entry in $handles) {
        [void][DshProcessControl.Native]::NtResumeProcess($entry.Handle)
        [void][DshProcessControl.Native]::CloseHandle($entry.Handle)
    }
    Write-Host ("resumed    {0:HH:mm:ss}  {1} process(es)  (the Desktop continues where it stopped)" -f (Get-Date), $handles.Count)
}

Write-Host @'

Now check the client's log for:
  [dsh-remote] remote Harness link needs rebuilding; trying a quick reconnect {"attempts":2,"windowMs":10000}
  [dsh-remote] remote Harness session kept its view through a quick reconnect      <- the window held
  [dsh-remote] remote Harness reconnect gave up; staying in the local shell        <- the schedule ended
There is no liveness probe any more: the Server's heartbeat is the only thing that declares a peer gone,
and a busy Host keeps answering it because pongs never wait on the business layer.
'@


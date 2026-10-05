param([Parameter(Mandatory=$true)][string]$RunId,[ValidateSet('chrome','tauri')][string]$Runtime='chrome',[string]$Exe,[ValidateSet('start','stop')][string]$Mode='start',[ValidateSet('harness','standard')][string]$BrowserConfig='harness',[switch]$KeepDisplayAwake,[switch]$DiagnosticIceAddresses,[switch]$ResourcesOnly)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if($RunId -notmatch '^matrix-[a-zA-Z0-9-]{1,80}$'){throw 'Invalid test run id'}
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$stage=[IO.Path]::GetFullPath((Join-Path $projectRoot "output/remote-matrix/$RunId-$Runtime"))
if(-not $stage.StartsWith($projectRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid stage directory'}
$taskName="SeeMyGame-E2E-$RunId-$Runtime"
if($Mode -eq 'stop'){
 $ready=Join-Path $stage 'ready.json'
 if(Test-Path -LiteralPath $ready){
  $message=Get-Content -LiteralPath $ready -Raw | ConvertFrom-Json
  if($message.controlEndpoint -match '^http://127\.0\.0\.1:19334/smg-viewer/[a-f0-9-]+$'){
   try {Invoke-WebRequest -UseBasicParsing -Uri ($message.controlEndpoint+'/shutdown') -Method Post -TimeoutSec 10 | Out-Null;Start-Sleep -Seconds 2}catch{}
  }
 }
 $task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
 if($task){Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName $taskName -Confirm:$false}
 [pscustomobject]@{removedTask=$taskName} | ConvertTo-Json -Compress
 exit
}
if(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue){throw 'Test task already exists'}
New-Item -ItemType Directory -Path $stage -Force | Out-Null
if((Get-Item -LiteralPath $stage).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Stage must not be a link'}
# Ready capability exists only while the helper is alive, and only this user/SYSTEM can read it.
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
foreach($account in @($identity,'SYSTEM')){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($account,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
Set-Acl -LiteralPath $stage -AclObject $acl
$node=Join-Path $projectRoot 'output/ssh-sync/sync-2026-10-02T17-23-09-36ff98/runtime/node.exe'
if(-not (Test-Path -LiteralPath $node)){throw 'Validated Node runtime not found'}
if($Runtime -eq 'tauri' -and -not (Test-Path -LiteralPath $Exe -PathType Leaf)){throw 'Receiver exe not found'}
$ready=Join-Path $stage 'ready.json'
$agent=Join-Path $projectRoot 'tools/e2e/viewer-agent.mjs'
$runner=Join-Path $stage 'start.ps1'
$escape={param($text) "'"+$text.Replace("'","''")+"'"}
$script="`$ErrorActionPreference='Stop'; Set-Location -LiteralPath $(&$escape $projectRoot); & $(&$escape $node) $(&$escape $agent) --runtime $Runtime --browser-config $BrowserConfig --channel chrome --browser-port 19333 --control-port 19334 --max-minutes 6 --ready-file $(&$escape $ready)"
if($DiagnosticIceAddresses){$script+=' --diagnostic-ice-addresses'}; if($Runtime -eq 'tauri'){$script+=" --exe $(&$escape $Exe)"}
if($ResourcesOnly){if($Runtime -ne 'chrome'){throw 'Resource-only helper cannot start Tauri'};$script+=' --resources-only'}
$errorLog=Join-Path $stage 'errors.log'
$script+=" 2> $(&$escape $errorLog) | Out-Null"
if($KeepDisplayAwake){
 # Scoped to this runner thread; Windows releases the request when the process exits.
 $lease='Add-Type -TypeDefinition ''using System; using System.Runtime.InteropServices; public static class SmgDisplayLease { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }''; $previousState=[SmgDisplayLease]::SetThreadExecutionState([uint32]2147483651); if($previousState -eq 0){throw ''Display awake request failed''}; '
 $script=$lease+'try { '+$script+' } finally { [SmgDisplayLease]::SetThreadExecutionState($previousState) | Out-Null }'
}
[IO.File]::WriteAllText($runner,$script)
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`"" -WorkingDirectory $projectRoot
$principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 8) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $taskName
$deadline=[DateTime]::UtcNow.AddSeconds(50)
while([DateTime]::UtcNow -lt $deadline){
 if(Test-Path -LiteralPath $ready){Get-Content -LiteralPath $ready -Raw;exit}
 $info=Get-ScheduledTaskInfo -TaskName $taskName
 if($info.LastTaskResult -notin 0,267009,267011){throw "Viewer scheduled task failed: $($info.LastTaskResult)"}
 Start-Sleep -Milliseconds 500
}
throw 'Interactive receiver readiness timeout; task has a bounded lifetime and can be removed using -Mode stop'

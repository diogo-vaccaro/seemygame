param([Parameter(Mandatory=$true)][string]$RunId,[ValidateSet('receiver','observer')][string]$Role='receiver',[ValidateSet('start','stop')][string]$Mode='start',[string]$Token,[switch]$PrivateNetwork,[string]$AllowPrivateMediaFrom,[switch]$DebugOptics)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if($RunId -notmatch '^compare-[a-zA-Z0-9-]{1,90}$'){throw 'Invalid diagnostic run id'}
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$stage=[IO.Path]::GetFullPath((Join-Path $projectRoot "output/native-comparisons/$RunId"))
if(-not $stage.StartsWith($projectRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid stage'}
$taskName="SeeMyGame-NativeProbe-$RunId"
$firewallName="SeeMyGame-E2E-UDP-$RunId"
$expiryTask="SeeMyGame-E2E-UDP-Expiry-$RunId"
$exe=Join-Path $stage 'probe.exe'
if($Mode -eq 'stop'){
 $task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
 if($task){Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName $taskName -Confirm:$false}
 $log=Join-Path $stage 'probe.log'
 if(Test-Path -LiteralPath $log){
  $line=Get-Content -LiteralPath $log | Where-Object {$_ -match 'SMG_COMPARE_READY '} | Select-Object -First 1
  if($line){$ready=$line.Substring($line.IndexOf('SMG_COMPARE_READY ')+18) | ConvertFrom-Json;$owned=Get-Process -Id $ready.pid -ErrorAction SilentlyContinue;if($owned -and $owned.Path -eq $exe){Stop-Process -Id $owned.Id -ErrorAction SilentlyContinue}}
 }
 if(Get-NetFirewallRule -Name $firewallName -ErrorAction SilentlyContinue){Remove-NetFirewallRule -Name $firewallName}
 if(Get-ScheduledTask -TaskName $expiryTask -ErrorAction SilentlyContinue){Unregister-ScheduledTask -TaskName $expiryTask -Confirm:$false}
 [pscustomobject]@{removedTask=$taskName;removedFirewallRule=$firewallName} | ConvertTo-Json -Compress
 exit
}
if($Token -notmatch '^[a-f0-9]{48}$'){throw 'Invalid diagnostic capability'}
if(-not (Test-Path -LiteralPath $exe -PathType Leaf)){throw 'Staged diagnostic executable missing'}
if((Get-Item -LiteralPath $stage).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Stage must not be a link'}
if(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue){throw 'Diagnostic task already exists'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
foreach($account in @($identity,'SYSTEM')){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($account,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
Set-Acl -LiteralPath $stage -AclObject $acl
$escape={param($text) "'"+$text.Replace("'","''")+"'"}
$firewallEvidence=$null
if($AllowPrivateMediaFrom){
 if($Role -ne 'receiver' -or $AllowPrivateMediaFrom -notmatch '^192\.168\.\d{1,3}\.\d{1,3}$'){throw 'Explicit receiver UDP permission requires one private IPv4 peer'}
 $parsedIp=$null
 if(-not [Net.IPAddress]::TryParse($AllowPrivateMediaFrom,[ref]$parsedIp)){throw 'Invalid private peer address'}
 if(Get-NetFirewallRule -Name $firewallName -ErrorAction SilentlyContinue){throw 'Diagnostic firewall rule already exists'}
 # This switch requires explicit human permission. The decoder remains Limited.
 # A separate privileged cleanup task expires the exact rule even if SSH dies.
 $cleanupScript=Join-Path $stage 'expire-firewall.ps1'
 $cleanupText="`$ErrorActionPreference='Stop'; if(Get-NetFirewallRule -Name '$firewallName' -ErrorAction SilentlyContinue){Remove-NetFirewallRule -Name '$firewallName'}; Unregister-ScheduledTask -TaskName '$expiryTask' -Confirm:`$false"
 [IO.File]::WriteAllText($cleanupScript,$cleanupText)
 $expires=[DateTime]::Now.AddMinutes(6)
 $expiryAction=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$cleanupScript`""
 $expiryPrincipal=New-ScheduledTaskPrincipal -UserId $identity -LogonType S4U -RunLevel Highest
 Register-ScheduledTask -TaskName $expiryTask -Action $expiryAction -Principal $expiryPrincipal -Trigger (New-ScheduledTaskTrigger -Once -At $expires) -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) | Out-Null
 New-NetFirewallRule -Name $firewallName -DisplayName $firewallName -Direction Inbound -Action Allow -Profile Private -Program $exe -Protocol UDP -RemoteAddress $AllowPrivateMediaFrom | Out-Null
 $firewallEvidence=@{name=$firewallName;program=$exe;protocol='UDP';profile='Private';remoteAddress=$AllowPrivateMediaFrom;expires=$expires.ToString('o')}
}
$gst=Join-Path $projectRoot 'native-media/gstreamer'
$log=Join-Path $stage 'probe.log'
$runner=Join-Path $stage 'start.ps1'
$script="`$ErrorActionPreference='Stop'; `$env:SMG_COMPARE_PRIVATE_NETWORK='$([int][bool]$PrivateNetwork)'; `$env:SMG_COMPARE_ROLE='$Role'; `$env:SMG_COMPARE_DEBUG_OPTICS='$([int][bool]$DebugOptics)'; `$env:SMG_COMPARE_PORT='0'; `$env:SMG_COMPARE_TOKEN='$Token'; `$env:SEEMYGAME_GSTREAMER_ROOT=$(&$escape $gst); `$env:PATH=$(&$escape (Join-Path $gst 'bin'))+';'+`$env:PATH; `$env:GST_DEBUG='*:2'; Set-Location -LiteralPath $(&$escape $stage); `$ErrorActionPreference='Continue'; & $(&$escape $exe) run_transport_comparison_probe --ignored --nocapture --test-threads=1 *> $(&$escape $log)"
[IO.File]::WriteAllText($runner,$script)
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`"" -WorkingDirectory $stage
$principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 6) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $taskName
$deadline=[DateTime]::UtcNow.AddSeconds(45)
while([DateTime]::UtcNow -lt $deadline){
 if(Test-Path -LiteralPath $log){$line=Get-Content -LiteralPath $log | Where-Object {$_ -match 'SMG_COMPARE_READY '} | Select-Object -First 1;if($line){$ready=$line.Substring($line.IndexOf('SMG_COMPARE_READY ')+18) | ConvertFrom-Json;$ready | Add-Member -NotePropertyName firewall -NotePropertyValue $firewallEvidence;$ready | ConvertTo-Json -Compress -Depth 8;exit}}
 $info=Get-ScheduledTaskInfo -TaskName $taskName
 if($info.LastTaskResult -notin 0,267009,267011){throw "Native probe task failed: $($info.LastTaskResult)"}
 Start-Sleep -Milliseconds 300
}
throw 'Native probe readiness timeout; inspect its bounded task log'

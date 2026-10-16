$ErrorActionPreference = 'Stop'
$bridgeStatePath = Join-Path $env:LOCALAPPDATA 'CodexDSHBridge'
if (-not (Test-Path -LiteralPath $bridgeStatePath)) { New-Item -ItemType Directory -Path $bridgeStatePath | Out-Null }
$bridgeStateDirectory = [System.IO.DirectoryInfo]::new($bridgeStatePath)
$bridgeStateAcl = $bridgeStateDirectory.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
$bridgeStateAcl.SetAccessRuleProtection($true, $false)
$bridgeUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($bridgeSid in @($bridgeUserSid, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
  $bridgeRule = [System.Security.AccessControl.FileSystemAccessRule]::new($bridgeSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $bridgeStateAcl.AddAccessRule($bridgeRule)
}
$bridgeStateDirectory.SetAccessControl($bridgeStateAcl)

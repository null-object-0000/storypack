$t = $null; $e = $null
[System.Management.Automation.Language.Parser]::ParseFile('D:\story-cli\scripts\watchdog.ps1', [ref]$t, [ref]$e) | Out-Null
if ($e) {
  foreach ($x in $e) {
    Write-Host ($x.Message + ' @ line ' + $x.Extent.StartLineNumber + ':' + $x.Extent.StartColumnNumber)
  }
} else {
  Write-Host 'parse OK'
}
param([Parameter(Mandatory=$true)][string]$Url)
$u=$Url.TrimEnd('/') + '/health'
Invoke-RestMethod $u | ConvertTo-Json -Depth 8

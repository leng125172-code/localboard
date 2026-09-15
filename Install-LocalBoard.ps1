[CmdletBinding()]
param(
  [string]$GitHubAccount,
  [string]$RepositoryName = 'localboard-personal-todos',
  [string]$ProjectTitle = 'LocalBoard Personal Tasks',
  [string]$TodoRoot,
  [switch]$NoLaunch
)

& (Join-Path $PSScriptRoot 'scripts\install-windows.ps1') @PSBoundParameters
exit $LASTEXITCODE

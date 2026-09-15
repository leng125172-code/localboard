[CmdletBinding()]
param(
  [string]$GitHubAccount,
  [string]$RepositoryName = 'localboard-personal-todos',
  [string]$ProjectTitle = 'LocalBoard Personal Tasks',
  [string]$TodoRoot,
  [string]$InstallRoot,
  [string]$CodexHome,
  [string]$AgentHome,
  [switch]$NoLaunch,
  [switch]$NoShortcuts,
  [switch]$NoPath,
  [switch]$SkipGitHub,
  [switch]$Unattended
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) { $PSNativeCommandUseErrorActionPreference = $false }
$sourceRoot = Split-Path -Parent $PSScriptRoot
if (-not $InstallRoot) { $InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\LocalBoard' }
if (-not $TodoRoot) { $TodoRoot = $env:USERPROFILE }
if (-not $CodexHome) { $CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' } }
if (-not $AgentHome) { $AgentHome = Join-Path $env:USERPROFILE '.agents' }
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$TodoRoot = [IO.Path]::GetFullPath($TodoRoot)

function Invoke-Installation {
  $mutex = [Threading.Mutex]::new($false, 'Local\LocalBoardInstaller')
  $ownsMutex = $false
  try {
  $ownsMutex = $mutex.WaitOne(0)
  if (-not $ownsMutex) { throw 'Another LocalBoard installation is already running.' }

  Assert-Command node 'Install Node.js 22.5 or newer, then rerun this installer.'
  Assert-Command npm 'Install npm, then rerun this installer.'
  $nodeVersion = (& node -p "process.versions.node").Trim()
  if ([version]$nodeVersion -lt [version]'22.5.0') { throw "Node.js 22.5+ is required; found $nodeVersion." }

  $package = Get-Content (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json
  $releaseId = '{0}-{1}' -f $package.version, (Get-Date -Format 'yyyyMMddHHmmss')
  $releaseRoot = Join-Path $InstallRoot "releases\$releaseId"
  New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
  Copy-AppFiles $sourceRoot $releaseRoot
  & npm ci --no-audit --no-fund --prefix $releaseRoot
  Assert-LastExitCode 'Failed to install LocalBoard desktop dependencies.'
  Ensure-ElectronRuntime $sourceRoot $releaseRoot

  $binRoot = Join-Path $InstallRoot 'bin'
  New-Item -ItemType Directory -Path $binRoot -Force | Out-Null
  Write-Utf8File (Join-Path $InstallRoot 'current.txt') "$releaseRoot`r`n"
  Write-CommandShim $binRoot
  Write-DesktopLauncher $binRoot $InstallRoot
  if (-not $NoPath) { Add-UserPath $binRoot }

  $hookCommand = Join-Path $binRoot 'localboard.cmd'
  & node (Join-Path $releaseRoot 'scripts\configure-codex.mjs') `
    --hooks (Join-Path $CodexHome 'hooks.json') `
    --config (Join-Path $CodexHome 'config.toml') `
    --skill-source (Join-Path $releaseRoot '.agents\skills\localboard') `
    --skill-target (Join-Path $AgentHome 'skills\localboard') `
    --plugin-source (Join-Path $releaseRoot 'integrations\plugins\localboard') `
    --plugin-target (Join-Path $AgentHome 'plugins\localboard') `
    --marketplace (Join-Path $AgentHome 'plugins\marketplace.json') `
    --command $hookCommand
  Assert-LastExitCode 'Failed to configure Codex Desktop/CLI integration.'

  if (-not $NoShortcuts) { New-LocalBoardShortcuts $binRoot $releaseRoot $TodoRoot $InstallRoot }
  if (-not $NoLaunch) { & $hookCommand start --repo $TodoRoot | Out-Null }

  [ordered]@{
    installed = $true
    release = $releaseRoot
    command = $hookCommand
    globalData = Join-Path $env:LOCALAPPDATA 'LocalBoard\data'
    githubAccount = $null
    githubProject = $null
    codexHooks = Join-Path $CodexHome 'hooks.json'
    codexSkill = Join-Path $AgentHome 'skills\localboard'
    codexMcp = 'mcp_servers.localboard'
    chatgptPlugin = Join-Path $AgentHome 'plugins\localboard'
    startup = -not $NoShortcuts
    desktopShortcut = -not $NoShortcuts
    launched = -not $NoLaunch
  } | ConvertTo-Json
  } finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

function Assert-Command([string]$Name, [string]$Help) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "$Name was not found. $Help" }
}

function Assert-LastExitCode([string]$Message) {
  if ($LASTEXITCODE -ne 0) { throw "$Message (exit code $LASTEXITCODE)" }
}

function Write-Utf8File([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Get-GitHubAccounts {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    $json = & gh auth status --json hosts 2>$null
    $statusCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference }
  if ($statusCode -ne 0 -and -not $json) { return @() }
  $status = $json | ConvertFrom-Json
  return @($status.hosts.'github.com' | Where-Object { $_.state -eq 'success' } | Select-Object -ExpandProperty login -Unique)
}

function Select-GitHubAccount($Accounts, [string]$Requested, [switch]$NonInteractive) {
  if ($Requested) {
    if ($Accounts -notcontains $Requested) { throw "GitHub account '$Requested' is not authenticated. Available: $($Accounts -join ', ')" }
    return $Requested
  }
  if ($Accounts.Count -eq 1) { return [string]$Accounts[0] }
  if ($NonInteractive -or [Console]::IsInputRedirected) {
    throw "Multiple GitHub accounts are authenticated. Rerun with -GitHubAccount <account>. Available: $($Accounts -join ', ')"
  }
  Write-Host 'Select the personal GitHub account that will own the LocalBoard todo repository:'
  for ($index = 0; $index -lt $Accounts.Count; $index++) { Write-Host "  $($index + 1). $($Accounts[$index])" }
  while ($true) {
    $answer = Read-Host "Account [1-$($Accounts.Count)]"
    $selected = 0
    if ([int]::TryParse($answer, [ref]$selected) -and $selected -ge 1 -and $selected -le $Accounts.Count) {
      return [string]$Accounts[$selected - 1]
    }
  }
}

function Ensure-GitHubProject([string]$Account, [string]$Title) {
  $json = & gh project list --owner $Account --format json
  Assert-LastExitCode "Failed to list GitHub Projects for $Account."
  $projects = @((($json | ConvertFrom-Json).projects) | Where-Object { $_.title -eq $Title -and -not $_.closed })
  if ($projects.Count -gt 1) { throw "Multiple open GitHub Projects are named '$Title'; rename duplicates before installing." }
  if ($projects.Count -eq 1) { return [int]$projects[0].number }
  $createdJson = & gh project create --owner $Account --title $Title --format json
  Assert-LastExitCode "Failed to create GitHub Project '$Title'."
  return [int](($createdJson | ConvertFrom-Json).number)
}

function Ensure-ProjectLink([string]$Account, [int]$ProjectNumber, [string]$Repository) {
  & gh project link $ProjectNumber --owner $Account --repo $Repository | Out-Null
  Assert-LastExitCode "Failed to link GitHub Project #$ProjectNumber to $Repository."
}

function Copy-AppFiles([string]$Source, [string]$Destination) {
  foreach ($file in @('package.json', 'package-lock.json', 'README.md')) {
    Copy-Item -LiteralPath (Join-Path $Source $file) -Destination (Join-Path $Destination $file) -Force
  }
  foreach ($directory in @('src', 'scripts', 'integrations', '.agents')) {
    Copy-Item -LiteralPath (Join-Path $Source $directory) -Destination (Join-Path $Destination $directory) -Recurse -Force
  }
}

function Ensure-ElectronRuntime([string]$Source, [string]$Release) {
  $targetElectron = Join-Path $Release 'node_modules\electron'
  $targetExecutable = Join-Path $targetElectron 'dist\electron.exe'
  if (Test-Path -LiteralPath $targetExecutable) { return }
  $sourceElectron = Join-Path $Source 'node_modules\electron'
  $sourceExecutable = Join-Path $sourceElectron 'dist\electron.exe'
  if (Test-Path -LiteralPath $sourceExecutable) {
    Copy-Item -LiteralPath (Join-Path $sourceElectron 'dist') -Destination $targetElectron -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $sourceElectron 'path.txt') -Destination (Join-Path $targetElectron 'path.txt') -Force
  } else {
    & node (Join-Path $targetElectron 'install.js')
    Assert-LastExitCode 'Electron runtime download failed.'
  }
  if (-not (Test-Path -LiteralPath $targetExecutable)) {
    throw "Electron runtime is missing after installation: $targetExecutable"
  }
}

function Write-CommandShim([string]$Bin) {
  $content = @'
@echo off
setlocal
set /p "LOCALBOARD_RELEASE="<"%~dp0..\current.txt"
node "%LOCALBOARD_RELEASE%\src\cli.mjs" %*
'@
  Set-Content -LiteralPath (Join-Path $Bin 'localboard.cmd') -Value $content -Encoding ascii
}

function Write-DesktopLauncher([string]$Bin, [string]$Root) {
  $content = @'
param([Parameter(Mandatory=$true)][string]$Repo)
$release = (Get-Content (Join-Path $PSScriptRoot '..\current.txt') -Raw).Trim()
& node (Join-Path $release 'src\cli.mjs') start --repo $Repo | Out-Null
'@
  Write-Utf8File (Join-Path $Bin 'Start-LocalBoard.ps1') $content
}

function Add-UserPath([string]$PathToAdd) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $items = @($current -split ';' | Where-Object { $_ })
  if (-not ($items | Where-Object { $_.TrimEnd('\') -ieq $PathToAdd.TrimEnd('\') })) {
    [Environment]::SetEnvironmentVariable('Path', (($items + $PathToAdd) -join ';'), 'User')
  }
  if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $PathToAdd.TrimEnd('\') })) {
    $env:Path = "$PathToAdd;$env:Path"
  }
}

function Ensure-PersonalTodoRepository([string]$Path, [string]$Account, [string]$Name, [int]$ProjectNumber, [string]$Command) {
  $fullName = "$Account/$Name"
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    & gh repo view $fullName --json nameWithOwner *> $null
    $remoteExists = $LASTEXITCODE -eq 0
  } finally { $ErrorActionPreference = $previousPreference }
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    if ($remoteExists) {
      & gh repo clone $fullName $Path
      Assert-LastExitCode "Failed to clone existing repository $fullName."
    } else {
      New-Item -ItemType Directory -Path $Path -Force | Out-Null
      & git -C $Path init -b main
      Assert-LastExitCode 'Failed to initialize the personal todo Git repository.'
    }
  } elseif (-not (Test-Path -LiteralPath (Join-Path $Path '.git'))) {
    if ((Get-ChildItem -LiteralPath $Path -Force | Select-Object -First 1)) {
      throw "Todo path exists and is not an empty Git repository: $Path"
    }
    & git -C $Path init -b main
    Assert-LastExitCode 'Failed to initialize the personal todo Git repository.'
  }

  $dataRoot = Join-Path $Path '.localboard'
  New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
  $todosPath = Join-Path $dataRoot 'todos.json'
  if (-not (Test-Path -LiteralPath $todosPath)) {
    Write-Utf8File $todosPath (([ordered]@{ schemaVersion = 1; todos = @() } | ConvertTo-Json -Depth 10) + "`n")
  }
  $configPath = Join-Path $dataRoot 'config.json'
  $config = if (Test-Path -LiteralPath $configPath) { Get-Content $configPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
  if ($null -eq $config.PSObject.Properties['github']) { $config | Add-Member -NotePropertyName github -NotePropertyValue ([pscustomobject]@{}) }
  elseif ($null -eq $config.github) { $config.github = [pscustomobject]@{} }
  Set-JsonProperty $config.github 'enabled' $true
  Set-JsonProperty $config.github 'account' $Account
  Set-JsonProperty $config.github 'owner' $Account
  Set-JsonProperty $config.github 'ownerType' 'user'
  Set-JsonProperty $config.github 'projectNumber' $ProjectNumber
  Set-JsonProperty $config.github 'repositories' ([object[]]@($fullName))
  Write-Utf8File $configPath (($config | ConvertTo-Json -Depth 10) + "`n")
  $readmePath = Join-Path $Path 'README.md'
  if (-not (Test-Path -LiteralPath $readmePath)) {
    Write-Utf8File $readmePath "# Personal todos`n`nManaged by LocalBoard. Personal todo data is stored in ``.localboard/todos.json``.`n"
  }

  $hookPath = (& git -C $Path rev-parse --git-path hooks).Trim()
  $resolvedHooks = if ([IO.Path]::IsPathRooted($hookPath)) { $hookPath } else { Join-Path $Path $hookPath }
  if (-not (Test-Path -LiteralPath (Join-Path $resolvedHooks 'pre-commit')) -and -not (Test-Path -LiteralPath (Join-Path $resolvedHooks 'pre-push'))) {
    & $Command git install --repo $Path | Out-Null
    Assert-LastExitCode 'Failed to install LocalBoard Git hooks in the personal todo repository.'
  }

  $alreadyStaged = @(& git -C $Path diff --cached --name-only | Where-Object { $_ })
  $unexpectedStaged = @($alreadyStaged | Where-Object { $_ -notin @('README.md', '.localboard/todos.json', '.localboard/config.json') })
  if ($unexpectedStaged.Count) { throw "Todo repository has unrelated staged changes; commit or unstage them first: $($unexpectedStaged -join ', ')" }
  & git -C $Path add README.md .localboard/todos.json .localboard/config.json
  & git -C $Path diff --cached --quiet
  if ($LASTEXITCODE -ne 0) {
    & git -C $Path commit -m 'chore: initialize LocalBoard personal todos'
    Assert-LastExitCode 'Failed to create the initial personal todo commit. Configure git user.name and user.email, then rerun.'
  }
  if (-not $remoteExists) {
    $originConfigured = Assert-OriginMatches $Path $fullName $false
    $remoteArguments = if ($originConfigured) { @() } else { @('--remote', 'origin') }
    & gh repo create $fullName --private --source $Path @remoteArguments
    Assert-LastExitCode "Failed to create private GitHub repository $fullName."
  } else {
    Assert-OriginMatches $Path $fullName $true
  }
  & git -C $Path push -u origin HEAD
  Assert-LastExitCode 'Failed to push the personal todo repository.'
}

function Assert-OriginMatches([string]$RepositoryPath, [string]$ExpectedRepository, [bool]$AddWhenMissing) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    $origin = & git -C $RepositoryPath remote get-url origin 2>$null
    $statusCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference }
  if ($statusCode -ne 0) {
    if ($AddWhenMissing) { & git -C $RepositoryPath remote add origin "https://github.com/$ExpectedRepository.git" }
    return $AddWhenMissing
  }
  if ($origin.Trim() -notmatch "(?i)github\.com[/:]$([regex]::Escape($ExpectedRepository))(?:\.git)?$") {
    throw "Todo repository origin points somewhere else: $($origin.Trim()). Expected $ExpectedRepository."
  }
  return $true
}

function Set-JsonProperty($Object, [string]$Name, $Value) {
  if ($null -ne $Object.PSObject.Properties[$Name]) { $Object.$Name = $Value }
  else { $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

function Write-LocalSettings([string]$RepositoryPath, [string]$Account, [string]$Repository, [int]$ProjectNumber) {
  $runtime = Join-Path $env:LOCALAPPDATA 'LocalBoard'
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  $settings = [ordered]@{
    defaultTodoRepository = $RepositoryPath
    primaryGitHubAccount = $Account
    personalTodoRepository = $Repository
    githubProjectNumber = $ProjectNumber
  } | ConvertTo-Json
  Write-Utf8File (Join-Path $runtime 'settings.json') ($settings + "`n")
}

function New-LocalBoardShortcuts([string]$Bin, [string]$Release, [string]$RepositoryPath, [string]$Root) {
  $shell = New-Object -ComObject WScript.Shell
  $launcher = Join-Path $Bin 'Start-LocalBoard.ps1'
  $powershell = (Get-Command powershell.exe).Source
  $electron = Join-Path $Release 'node_modules\electron\dist\electron.exe'
  $locations = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'LocalBoard.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\LocalBoard\LocalBoard.lnk')
  )
  foreach ($shortcutPath in $locations) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $shortcutPath) -Force | Out-Null
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $powershell
    $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`" -Repo `"$RepositoryPath`""
    $shortcut.WorkingDirectory = $RepositoryPath
    $shortcut.Description = 'LocalBoard personal todo and GitHub workspace'
    $shortcut.IconLocation = "$electron,0"
    $shortcut.Save()
  }
  $startupPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\LocalBoard.lnk'
  $startup = $shell.CreateShortcut($startupPath)
  $startup.TargetPath = $electron
  $startup.Arguments = "`"$Release`" --background"
  $startup.WorkingDirectory = $RepositoryPath
  $startup.Description = 'LocalBoard tray startup'
  $startup.IconLocation = "$electron,0"
  $startup.Save()
}

Invoke-Installation

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$evidence = Join-Path $env:RUNNER_TEMP 'wework-installer-evidence'
$sourceVersion = $env:SOURCE_VERSION
$targetVersion = $env:TARGET_VERSION
$sourceInstaller = Join-Path $env:RUNNER_TEMP "WeWork_${sourceVersion}_windows_x64-setup.exe"
$targetInstaller = Join-Path $PSScriptRoot "../../wework/electron/release-installer/WeWork_${targetVersion}_windows_x64-setup.exe"
$targetApp = Join-Path $env:RUNNER_TEMP 'wework-target/unpacked/application'
$desktopState = Join-Path $env:USERPROFILE '.wegent/workbench/wework/default'
$userData = Join-Path $desktopState 'user-data'
$releaseRoot = Join-Path $userData 'releases'
$shell = New-Object -ComObject WScript.Shell
$desktop = $shell.SpecialFolders.Item('Desktop')
$shortcut = Join-Path $desktop 'WeWork.lnk'
$startupLogs = @(
  (Join-Path $userData 'logs/wework-main.log'),
  (Join-Path $desktopState 'electron-logs/wework-main.log')
)

function Wait-For($description, [int]$seconds, [scriptblock]$condition) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($seconds)
  do {
    $result = & $condition
    if ($result) { return $result }
    Start-Sleep -Milliseconds 500
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Timed out after ${seconds}s waiting for $description"
}

function Install-Application($installer) {
  Write-Host "Installing $installer"
  $process = Start-Process -FilePath $installer -ArgumentList '/S' -PassThru
  if (!$process.WaitForExit(240000)) { throw "Installer did not exit within four minutes: $installer" }
  if ($process.ExitCode -ne 0) { throw "Installer exit code $($process.ExitCode): $installer" }
}

function Read-ShortcutTarget {
  if (!(Test-Path -LiteralPath $shortcut -PathType Leaf)) { throw "Installer did not create $shortcut" }
  $target = $shell.CreateShortcut($shortcut).TargetPath
  if (!(Test-Path -LiteralPath $target -PathType Leaf)) { throw "Shortcut target is missing: $target" }
  return $target
}

function Assert-Version($executable, $expected) {
  $components = Join-Path (Split-Path -Parent $executable) 'resources/components.json'
  $version = (Get-Content -LiteralPath $components -Raw | ConvertFrom-Json).appVersion
  if ($version -cne $expected) { throw "Expected $expected at $executable, found $version" }
}

function Get-ReadySteps([DateTimeOffset]$since) {
  $pattern = '(?m)^([0-9T:.Z-]+) \[stdout\] \[startup\] \{\s*step: ''(desktop-runtime-start|renderer-startup-ready)'',\s*status: ''completed'''
  foreach ($log in $startupLogs) {
    if (!(Test-Path -LiteralPath $log -PathType Leaf)) { continue }
    $contents = (Get-Content -LiteralPath $log -Tail 400) -join "`n"
    foreach ($match in [regex]::Matches($contents, $pattern)) {
      if ([DateTimeOffset]::Parse($match.Groups[1].Value) -ge $since) {
        $match.Groups[2].Value
      }
    }
  }
}

function Start-AndVerify($stage, $entry, $executable, $version, [DateTimeOffset]$since, [bool]$launch) {
  if ($launch) { Start-Process -FilePath $entry }
  $process = Wait-For "$stage runtime and renderer readiness at $executable" 240 {
    $steps = @(Get-ReadySteps $since)
    if ($steps -notcontains 'desktop-runtime-start' -or $steps -notcontains 'renderer-startup-ready') {
      return
    }
    Get-Process -Name 'WeWork' -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -ieq $executable -and $_.MainWindowHandle -ne 0 } |
      Select-Object -First 1
  }
  Assert-Version $process.Path $version
  $record = @{
    stage = $stage; entry = $entry; runningExecutable = $process.Path; pid = $process.Id
    version = $version; runtimeReady = $true; rendererReady = $true
    osBoot = (Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
    appAsarSha256 = (Get-FileHash (Join-Path (Split-Path -Parent $process.Path) 'resources/app.asar')).Hash
  }
  $record | ConvertTo-Json | Tee-Object -FilePath (Join-Path $evidence "$stage.json") | Write-Host
  return $process
}

function Close-Application($process) {
  if (!$process.CloseMainWindow()) { throw "Could not close the application window for PID $($process.Id)" }
  if (!$process.WaitForExit(45000)) { throw "Application PID $($process.Id) did not exit" }
}

function Assert-SelectedRelease($token, $id, $executable) {
  Wait-For "registered installer token for $targetVersion" 30 {
    $tokenPath = Join-Path $releaseRoot 'windows-installation'
    if (Test-Path -LiteralPath $tokenPath) { (Get-Content -LiteralPath $tokenPath -Raw).Trim() -ceq $token }
  } | Out-Null
  $active = (Get-Content -LiteralPath (Join-Path $releaseRoot 'active') -Raw).Trim()
  $descriptor = Get-Content -LiteralPath (Join-Path $releaseRoot "slots/$active/release.json") -Raw | ConvertFrom-Json
  if ($active -cne $id -or $descriptor.version -cne $targetVersion -or $descriptor.executable -ine $executable) {
    throw "Persisted release does not select the installed $targetVersion executable (active=$active)"
  }
  Write-Host "Persisted release: $active -> $executable"
}

New-Item -ItemType Directory -Force $evidence | Out-Null
try {
  if (Test-Path -LiteralPath $userData) { throw "Expected a clean test user, found $userData" }
  New-Item -ItemType Directory -Force $userData | Out-Null
  @{ closeToTrayEnabled = $false } | ConvertTo-Json |
    Set-Content -LiteralPath (Join-Path $userData 'app-preferences.json') -Encoding utf8NoBOM

  Install-Application $sourceInstaller
  $executable = Read-ShortcutTarget
  Assert-Version $executable $sourceVersion
  $old = Start-AndVerify 'baseline' $shortcut $executable $sourceVersion ([DateTimeOffset]::UtcNow) $true
  Close-Application $old

  $firstStart = [DateTimeOffset]::UtcNow
  Install-Application $targetInstaller
  if ((Read-ShortcutTarget) -ine $executable) { throw 'Overwrite changed the physical shortcut target' }
  Assert-Version $executable $targetVersion
  $installation = Split-Path -Parent $executable
  foreach ($relative in @('WeWork.exe', 'resources/app.asar', 'resources/components.json', 'resources/wework-launcher.exe')) {
    $installed = (Get-FileHash (Join-Path $installation $relative)).Hash
    $candidate = (Get-FileHash (Join-Path $targetApp $relative)).Hash
    if ($installed -cne $candidate) { throw "Installed $relative differs from the PR application" }
  }
  $marker = Get-Content -LiteralPath (Join-Path $installation 'wework-installed-release')
  if ($marker.Count -ne 2 -or $marker[0] -cne $targetVersion -or $marker[1] -notmatch '^\d{15,20}$') {
    throw 'The full installer did not write a valid version marker'
  }
  $token = $marker[1]
  $id = "installed-$targetVersion-$token"
  $alreadyStarted = Get-Process -Name 'WeWork' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -ieq $executable } |
    Select-Object -First 1
  $first = Start-AndVerify 'first-launch' $executable $executable $targetVersion $firstStart (!$alreadyStarted)
  Assert-SelectedRelease $token $id $executable
  Close-Application $first

  $reopened = Start-AndVerify 'shortcut-relaunch' $shortcut $executable $targetVersion ([DateTimeOffset]::UtcNow) $true
  if ($reopened.Id -eq $first.Id) { throw 'Shortcut did not create a new process' }
  Assert-SelectedRelease $token $id $executable
  Close-Application $reopened
} finally {
  foreach ($log in $startupLogs) {
    if (Test-Path -LiteralPath $log) {
      $parent = Split-Path -Leaf (Split-Path -Parent $log)
      Copy-Item -LiteralPath $log -Destination (Join-Path $evidence "$parent-main.log")
    }
  }
}

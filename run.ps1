param(
    [ValidateSet('setup', 'dev', 'build', 'check', 'preview', 'assets')]
    [string]$Command = 'dev'
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$runtimeVersion = 'v24.19.0'
$runtimeName = "node-$runtimeVersion-win-x64"
$runtimeRoot = Join-Path $PSScriptRoot '.tools'
$runtimeDirectory = Join-Path $runtimeRoot $runtimeName
$runtimeExecutable = Join-Path $runtimeDirectory 'node.exe'
if (-not (Test-Path -LiteralPath $runtimeExecutable)) {
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    $archiveName = "$runtimeName.zip"
    $archivePath = Join-Path $runtimeRoot $archiveName
    $releaseUrl = "https://nodejs.org/dist/$runtimeVersion"
    Write-Output "Downloading Node.js $runtimeVersion for this project..."
    Invoke-WebRequest "$releaseUrl/$archiveName" -OutFile $archivePath
    $checksums = (Invoke-WebRequest "$releaseUrl/SHASUMS256.txt").Content
    $checksumLine = @($checksums -split "\n" | Where-Object { $_.Trim().EndsWith("  $archiveName") })[0]
    if (-not $checksumLine) { throw 'Node archive checksum was not found.' }
    $expectedHash = ($checksumLine.Trim() -split '\s+')[0]
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if ($actualHash -ne $expectedHash) { throw 'Node archive checksum does not match.' }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeRoot -Force
}
$env:Path = "$runtimeDirectory;$env:Path"
$npmCli = Join-Path $runtimeDirectory 'node_modules/npm/bin/npm-cli.js'
if ($Command -eq 'setup') {
    if (Test-Path -LiteralPath 'package-lock.json') { & $runtimeExecutable $npmCli ci }
    else { & $runtimeExecutable $npmCli install }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $runtimeExecutable $npmCli run assets
    exit $LASTEXITCODE
}
& $runtimeExecutable $npmCli run $Command
exit $LASTEXITCODE

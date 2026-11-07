#requires -Version 5.1
<#
.SYNOPSIS
Downloads whisper.cpp and a Whisper model for Dictaphone OpenCode.

.DESCRIPTION
Installs the runtime files outside the repository, by default in:
  %USERPROFILE%\.local\share\dictaphone-opencode

.PARAMETER Backend
cpu (default) or cuda. The cuda build requires an NVIDIA GPU and driver.

.PARAMETER Root
Runtime directory. Must match the plugin's "root" option if you override it.

.PARAMETER Model
Model file name from ggerganov/whisper.cpp. Default: ggml-large-v3-turbo-q5_0.bin

.PARAMETER Force
Download even if the model already exists.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Backend cuda
#>
[CmdletBinding()]
param(
    [ValidateSet("cpu", "cuda")]
    [string]$Backend = "cpu",
    [string]$Root = (Join-Path $env:USERPROFILE ".local\share\dictaphone-opencode"),
    [string]$Model = "ggml-large-v3-turbo-q5_0.bin",
    [string]$Release = "v1.9.2",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Windows locks whisper-server.exe while it runs; updating the files under it
# would fail halfway through.
if (Get-Process -Name "whisper-server" -ErrorAction SilentlyContinue) {
    throw "whisper-server.exe is running. Quit OpenCode Desktop (or disable the Dictaphone OpenCode plugin), then run the installer again."
}

$binDir = Join-Path $Root "bin"
$modelsDir = Join-Path $Root "models"
New-Item -ItemType Directory -Force -Path $binDir, $modelsDir | Out-Null

$asset = if ($Backend -eq "cuda") {
    "whisper-cublas-12.4.0-bin-x64.zip"
} else {
    "whisper-bin-x64.zip"
}
$url = "https://github.com/ggml-org/whisper.cpp/releases/download/$Release/$asset"
$zip = Join-Path $env:TEMP $asset

Write-Host "Downloading whisper.cpp ($Backend)..." -ForegroundColor Cyan
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe -L --fail --retry 3 --connect-timeout 30 -o $zip $url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $url" }
} else {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
}

$extract = Join-Path $env:TEMP "dictaphone-opencode-$Backend"
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $extract -Force

$releaseDir = Join-Path $extract "Release"
if (-not (Test-Path $releaseDir)) { $releaseDir = $extract }
$server = Join-Path $releaseDir "whisper-server.exe"
if (-not (Test-Path $server)) { throw "whisper-server.exe was not found in the archive." }

Get-ChildItem $binDir -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $releaseDir "*") $binDir -Recurse -Force
Write-Host "whisper.cpp installed in $binDir" -ForegroundColor Green

$modelPath = Join-Path $modelsDir $Model
# 1 MB only guards against empty or truncated files; valid models can be small
# (ggml-tiny is about 75 MB).
$needModel = $Force -or -not (Test-Path $modelPath) -or ((Get-Item $modelPath).Length -lt 1MB)
if ($needModel) {
    $modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$Model"
    $partial = "$modelPath.part"
    Write-Host "Downloading model $Model..." -ForegroundColor Cyan
    if (Test-Path $partial) { Remove-Item $partial -Force -ErrorAction SilentlyContinue }
    try {
        if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
            & curl.exe -L --fail --retry 3 --connect-timeout 30 -o $partial $modelUrl
            if ($LASTEXITCODE -ne 0) { throw "Download failed: $modelUrl" }
        } else {
            Invoke-WebRequest -Uri $modelUrl -OutFile $partial -UseBasicParsing
        }
        Move-Item $partial $modelPath -Force
    } finally {
        Remove-Item $partial -Force -ErrorAction SilentlyContinue
    }
}
if (-not (Test-Path $modelPath) -or (Get-Item $modelPath).Length -lt 1MB) {
    throw "The model download did not complete: $modelPath"
}
Write-Host "Model installed in $modelPath" -ForegroundColor Green

Remove-Item $zip -Force -ErrorAction SilentlyContinue
Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Done. Runtime files: $Root" -ForegroundColor Green
Write-Host ""
Write-Host "Add this plugin to ~/.config/opencode/opencode.json:"
Write-Host ""
Write-Host '  "plugins": [{'
Write-Host '    "package": "C:/path/to/dictaphone-opencode",'
Write-Host '    "options": { "language": "fr" }'
Write-Host '  }]'
Write-Host ""
if ($Backend -eq "cuda") {
    Write-Host "CUDA build selected: an NVIDIA GPU and a recent driver are required." -ForegroundColor DarkGray
} else {
    Write-Host "CPU build selected. Re-run with -Backend cuda for faster NVIDIA transcription." -ForegroundColor DarkGray
}
if ($Model -ne "ggml-large-v3-turbo-q5_0.bin") {
    Write-Host "Set options.whisperModel to: $modelPath" -ForegroundColor DarkGray
}

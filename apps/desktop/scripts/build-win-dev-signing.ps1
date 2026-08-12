$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "dist:win:dev must run on Windows because New-SelfSignedCertificate and Authenticode are Windows facilities."
}

$appRoot = Split-Path -Parent $PSScriptRoot
$signingRoot = Join-Path $appRoot ".dev-signing"
$pfxPath = Join-Path $signingRoot "AI-Learn-Dev.pfx"
$cerPath = Join-Path $signingRoot "AI-Learn-Dev.cer"

New-Item -ItemType Directory -Force -Path $signingRoot | Out-Null

$subject = "CN=AI Learn Development"
$existing = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object {
    $_.Subject -eq $subject -and
    $_.HasPrivateKey -and
    $_.NotAfter -gt (Get-Date).AddDays(30)
  } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1

if ($null -eq $existing) {
  $existing = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $subject `
    -FriendlyName "AI Learn Development Code Signing" `
    -CertStoreLocation Cert:\CurrentUser\My `
    -NotAfter (Get-Date).AddYears(5)
}

$passwordPath = Join-Path $signingRoot "password.txt"
if (Test-Path $passwordPath) {
  $password = (Get-Content -Raw $passwordPath).Trim()
}
else {
  $password = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
  Set-Content -Path $passwordPath -Value $password -NoNewline
}

$securePassword = ConvertTo-SecureString $password -AsPlainText -Force
Export-PfxCertificate -Cert $existing -FilePath $pfxPath -Password $securePassword -Force | Out-Null
Export-Certificate -Cert $existing -FilePath $cerPath -Force | Out-Null

# Trust only this development certificate for the current Windows user. This
# does not make the artifact trusted on other machines or remove SmartScreen.
$trusted = Get-ChildItem Cert:\CurrentUser\Root |
  Where-Object { $_.Thumbprint -eq $existing.Thumbprint }
if ($null -eq $trusted) {
  Import-Certificate -FilePath $cerPath -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
}

$env:WIN_CSC_LINK = $pfxPath
$env:WIN_CSC_KEY_PASSWORD = $password
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"

Push-Location $appRoot
try {
  # Reproduce prebuild:web with PowerShell-native file operations. The
  # package.json version uses mkdir/cp and is intended for Unix shells.
  $webRoot = Join-Path $appRoot "..\web"
  $env:NEXT_PUBLIC_COMPANION_PET_ENABLED = "true"
  $env:NEXT_PUBLIC_QUESTION_FIRST_UI_ENABLED = "true"
  $env:NEXT_PUBLIC_AI_QUESTION_V1_ENABLED = "true"
  $env:NEXT_PUBLIC_RUBRIC_EVALUATION_V1_ENABLED = "true"
  Push-Location $webRoot
  try {
    & npm.cmd install
    if ($LASTEXITCODE -ne 0) { throw "web npm install failed with exit code $LASTEXITCODE" }

    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "web build failed with exit code $LASTEXITCODE" }

    $standaloneWebRoot = Join-Path $webRoot ".next\standalone\apps\web"
    New-Item -ItemType Directory -Force -Path (Join-Path $standaloneWebRoot ".next\static") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $standaloneWebRoot "public") | Out-Null
    Copy-Item -Path (Join-Path $webRoot ".next\static\*") -Destination (Join-Path $standaloneWebRoot ".next\static") -Recurse -Force
    Copy-Item -Path (Join-Path $webRoot "public\*") -Destination (Join-Path $standaloneWebRoot "public") -Recurse -Force
  }
  finally {
    Pop-Location
  }

  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw "desktop build failed with exit code $LASTEXITCODE" }

  & npx.cmd electron-builder --win --x64
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed with exit code $LASTEXITCODE" }
}
finally {
  Pop-Location
}

Write-Host "Development-signed Windows artifacts are in $appRoot\release"
Write-Host "Certificate subject: $subject"
Write-Host "This certificate is local-only and is not suitable for public distribution."

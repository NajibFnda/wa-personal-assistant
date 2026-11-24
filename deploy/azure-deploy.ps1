param(
  [Parameter(Mandatory = $true)]
  [string]$VmIp,

  [string]$VmUser = "azureuser",

  [string]$KeyPath = "",

  [switch]$SyncData
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RemoteDir = "~/alarm-bot"

$SshOpts = @("-o", "StrictHostKeyChecking=accept-new")
if ($KeyPath -ne "") {
  if (-not (Test-Path $KeyPath)) {
    throw "File SSH key tidak ditemukan: $KeyPath"
  }
  $SshOpts += @("-i", $KeyPath)
}

Write-Host "=== Deploy Personal Assistant ke Azure VM ($VmUser@$VmIp) ===" -ForegroundColor Cyan

# Cek apakah WEB_PIN sudah diisi di .env sebelum online ke internet
$EnvPath = Join-Path $ProjectRoot ".env"
if (Test-Path $EnvPath) {
  $envContent = Get-Content $EnvPath -Raw
  if ($envContent -match "(?m)^WEB_PIN=\s*$") {
    Write-Warning "WEB_PIN di .env masih kosong! Sangat disarankan isi WEB_PIN agar Web Dashboard tidak bisa dibuka orang lain."
  }
}

# 1. Buat arsip kode bersih (tanpa node_modules)
$TempTar = Join-Path $env:TEMP "alarm-bot-deploy.tar.gz"
if (Test-Path $TempTar) { Remove-Item $TempTar -Force }

$IncludeItems = @("src", "public", "deploy", "package.json", "ecosystem.config.cjs", ".env")
if (Test-Path (Join-Path $ProjectRoot "package-lock.json")) {
  $IncludeItems += "package-lock.json"
}

if ($SyncData) {
  Write-Host "[Info] Mode -SyncData aktif: ikut mengunggah database SQLite, folder uploads, dan sesi WA." -ForegroundColor Yellow
  foreach ($extra in @("assistant.db", "uploads", "auth_info_baileys")) {
    if (Test-Path (Join-Path $ProjectRoot $extra)) {
      $IncludeItems += $extra
    }
  }
}

Write-Host "[1/3] Mengemas file proyek..."
Push-Location $ProjectRoot
try {
  & tar -czf $TempTar @IncludeItems
  if ($LASTEXITCODE -ne 0) { throw "Gagal membuat arsip tar.gz" }
} finally {
  Pop-Location
}

# 2. Upload arsip ke Azure VM
Write-Host "[2/3] Mengunggah ke Azure VM ($VmUser@$VmIp)..."
& ssh @SshOpts "$VmUser@$VmIp" "mkdir -p $RemoteDir"
if ($LASTEXITCODE -ne 0) { throw "Gagal terhubung via SSH ke $VmUser@$VmIp" }

& scp @SshOpts $TempTar "${VmUser}@${VmIp}:~/alarm-bot-deploy.tar.gz"
if ($LASTEXITCODE -ne 0) { throw "Gagal mengunggah arsip via SCP" }

Remove-Item $TempTar -Force

# 3. Ekstrak & jalankan setup/restart di server Ubuntu
Write-Host "[3/3] Menjalankan setup & memulai layanan 24/7 di Azure VM..."
$RemoteCmd = "tar -xzf ~/alarm-bot-deploy.tar.gz -C $RemoteDir && rm -f ~/alarm-bot-deploy.tar.gz && sed -i 's/\r$//' $RemoteDir/deploy/azure-setup.sh && chmod +x $RemoteDir/deploy/azure-setup.sh && APP_DIR=`$HOME/alarm-bot $RemoteDir/deploy/azure-setup.sh $VmIp"
& ssh @SshOpts "$VmUser@$VmIp" $RemoteCmd
if ($LASTEXITCODE -ne 0) { throw "Setup di Azure VM gagal." }

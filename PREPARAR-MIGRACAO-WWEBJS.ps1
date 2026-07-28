$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot

Write-Host '============================================'
Write-Host ' PREPARAR MIGRACAO DO BOT PARA WWEBJS'
Write-Host '============================================'
Write-Host ''

if (-not (Test-Path '.\.wwebjs_auth')) {
    throw 'Sessao .wwebjs_auth nao encontrada. Conecte primeiro pelo teste paliativo.'
}

$arquivosSessao = Get-ChildItem '.\.wwebjs_auth' -Recurse -File -ErrorAction SilentlyContinue
if (-not $arquivosSessao -or $arquivosSessao.Count -eq 0) {
    throw 'A pasta .wwebjs_auth esta vazia.'
}

$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$backupDir = Join-Path $PSScriptRoot "backups-locais\migracao-wwebjs_$timestamp"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

Copy-Item '.\server.js' (Join-Path $backupDir 'server.js') -Force
Copy-Item '.\package.json' (Join-Path $backupDir 'package.json') -Force
if (Test-Path '.\package-lock.json') {
    Copy-Item '.\package-lock.json' (Join-Path $backupDir 'package-lock.json') -Force
}
Copy-Item '.\.wwebjs_auth' (Join-Path $backupDir '.wwebjs_auth') -Recurse -Force

Write-Host "Backup criado em: $backupDir"
Write-Host ''
Write-Host 'Validando arquivos...'

node --check '.\server.js'
if ($LASTEXITCODE -ne 0) {
    throw 'server.js possui erro de sintaxe antes da migracao.'
}

node --check '.\scripts\testar-whatsapp-web.js'
if ($LASTEXITCODE -ne 0) {
    throw 'O teste whatsapp-web.js possui erro de sintaxe.'
}

Write-Host ''
Write-Host 'OK: sessao encontrada, backup criado e sintaxe validada.'
Write-Host 'Nao envie as pastas .wwebjs_auth ou backups-locais ao GitHub.'

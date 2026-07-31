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

Write-Host 'Fechando somente os processos do teste whatsapp-web.js...'

$processosTeste = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.Name -match '^(node|chrome|msedge)\.exe$') -and
    ($_.CommandLine -like '*testar-whatsapp-web.js*' -or $_.CommandLine -like '*.wwebjs_auth*')
}

foreach ($processo in $processosTeste) {
    try {
        Stop-Process -Id $processo.ProcessId -Force -ErrorAction Stop
        Write-Host "Processo encerrado: $($processo.Name) PID $($processo.ProcessId)"
    } catch {
        Write-Warning "Nao foi possivel encerrar PID $($processo.ProcessId): $($_.Exception.Message)"
    }
}

Start-Sleep -Seconds 3

$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$backupDir = Join-Path $PSScriptRoot "backups-locais\migracao-wwebjs_$timestamp"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

try {
    Copy-Item '.\server.js' (Join-Path $backupDir 'server.js') -Force
    Copy-Item '.\package.json' (Join-Path $backupDir 'package.json') -Force
    if (Test-Path '.\package-lock.json') {
        Copy-Item '.\package-lock.json' (Join-Path $backupDir 'package-lock.json') -Force
    }
    Copy-Item '.\.wwebjs_auth' (Join-Path $backupDir '.wwebjs_auth') -Recurse -Force
} catch {
    Remove-Item $backupDir -Recurse -Force -ErrorAction SilentlyContinue
    throw "Falha ao copiar a sessao. Feche a janela automatizada do WhatsApp e execute novamente. Detalhe: $($_.Exception.Message)"
}

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
Write-Host 'O WhatsApp continuara conectado no celular. O navegador automatizado foi fechado apenas para liberar os arquivos.'
Write-Host 'Nao envie as pastas .wwebjs_auth ou backups-locais ao GitHub.'
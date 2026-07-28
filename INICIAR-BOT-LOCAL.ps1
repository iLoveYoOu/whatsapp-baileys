$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host '============================================'
Write-Host ' BOT LOCAL - WHATSAPP-WEB.JS'
Write-Host '============================================'
Write-Host ''

if (-not (Test-Path '.\.wwebjs_auth')) {
    throw 'Sessao .wwebjs_auth nao encontrada. Nao foi criada uma nova sessao.'
}

if (-not (Test-Path '.\node_modules\whatsapp-web.js')) {
    Write-Host 'Instalando dependencias...'
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'Falha no npm install.' }
}

Write-Host 'Aplicando migracao idempotente no server.js...'
node '.\scripts\aplicar-migracao-wwebjs.js'
if ($LASTEXITCODE -ne 0) { throw 'Falha ao aplicar migracao.' }

Write-Host 'Validando sintaxe...'
node --check '.\server.js'
if ($LASTEXITCODE -ne 0) { throw 'server.js possui erro de sintaxe.' }
node --check '.\src\whatsapp\wwebjs-provider.js'
if ($LASTEXITCODE -ne 0) { throw 'wwebjs-provider.js possui erro de sintaxe.' }

$env:WHATSAPP_PROVIDER = 'wwebjs'
$env:WWEBJS_HEADLESS = 'false'

Write-Host ''
Write-Host 'Iniciando com a sessao existente em .wwebjs_auth...'
Write-Host 'Nao feche esta janela enquanto o bot estiver em uso.'
Write-Host ''

node '.\server.js'

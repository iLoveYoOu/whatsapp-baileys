$ErrorActionPreference = 'Stop'

Write-Host '============================================'
Write-Host ' TESTE PALIATIVO - WHATSAPP-WEB.JS'
Write-Host '============================================'
Write-Host ''

Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js nao encontrado no PATH.'
}

if (-not (Test-Path '.\node_modules\whatsapp-web.js')) {
    Write-Host 'Instalando dependencias do projeto...'
    npm install
    if ($LASTEXITCODE -ne 0) {
        throw 'Falha no npm install.'
    }
}

Write-Host ''
Write-Host 'O Chrome sera aberto para o login.'
Write-Host 'A pagina do QR tambem ficara em: http://localhost:3002/qr'
Write-Host 'Depois de conectar, envie /teste para o numero do bot.'
Write-Host ''

npm run test:wwebjs

$ErrorActionPreference = 'Stop'

Write-Host '============================================' -ForegroundColor Cyan
Write-Host '   AUTENTICAR WHATSAPP LOCALMENTE' -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor Cyan

if (-not (Test-Path '.\package.json')) {
    Write-Host 'Abra este PowerShell dentro da pasta do projeto.' -ForegroundColor Red
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js não encontrado no PATH.' -ForegroundColor Red
    exit 1
}

if (-not (Test-Path '.\node_modules')) {
    Write-Host 'Instalando dependências...' -ForegroundColor Yellow
    npm install
}

if (Test-Path '.\auth-local.zip') {
    Remove-Item '.\auth-local.zip' -Force
}

Write-Host ''
Write-Host 'O navegador abrirá no QR Code.' -ForegroundColor Green
Write-Host 'No celular: WhatsApp > Aparelhos conectados > Conectar aparelho.' -ForegroundColor Green
Write-Host ''

$processo = Start-Process powershell -PassThru -ArgumentList @(
    '-NoExit',
    '-Command',
    "Set-Location '$PWD'; node .\scripts\login-local.js"
)

Start-Sleep -Seconds 4
Start-Process 'http://localhost:3001/qr'

Write-Host 'Depois que aparecer "WhatsApp conectado localmente" na outra janela,' -ForegroundColor Yellow
Write-Host 'pressione ENTER aqui para criar o pacote da sessão.' -ForegroundColor Yellow
Read-Host

$credencial = '.\auth-local\creds.json'
if (-not (Test-Path $credencial)) {
    Write-Host 'A sessão ainda não foi criada. Escaneie o QR e tente novamente.' -ForegroundColor Red
    exit 1
}

$creds = Get-Content $credencial -Raw | ConvertFrom-Json
if (-not $creds.registered) {
    Write-Host 'A sessão existe, mas ainda não está registrada no WhatsApp.' -ForegroundColor Red
    exit 1
}

Compress-Archive -Path '.\auth-local\*' -DestinationPath '.\auth-local.zip' -Force

Write-Host ''
Write-Host '✅ Sessão autenticada e pacote criado:' -ForegroundColor Green
Write-Host "$PWD\auth-local.zip" -ForegroundColor Cyan
Write-Host ''
Write-Host 'NÃO envie esse ZIP para ninguém e NÃO coloque no GitHub.' -ForegroundColor Red
Write-Host 'Ele dá acesso à sessão do WhatsApp.' -ForegroundColor Red

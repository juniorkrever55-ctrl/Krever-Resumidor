@echo off
REM Atalho para iniciar Krever Resumidor
REM Coloque este arquivo na Área de Trabalho ou na pasta do projeto

title Krever Resumidor - Central de Conversas
color 0B

echo ========================================
echo   Krever Resumidor - Iniciando...
echo ========================================
echo.

REM Vai para a pasta do projeto (ajuste se necessário)
cd /d "%~dp0"

REM Verifica se node_modules existe
if not exist "node_modules" (
    echo Instalando dependencias...
    call npm install
)

REM Verifica se .env existe
if not exist ".env" (
    echo.
    echo [ERRO] Arquivo .env nao encontrado!
    echo Copie .env.example para .env e configure sua GROQ_API_KEY
    echo.
    pause
    exit /b
)

echo Iniciando servidor em http://localhost:3000
echo O Chrome vai abrir automaticamente...
echo Para parar, feche esta janela ou pressione Ctrl+C
echo.

call npm start

pause

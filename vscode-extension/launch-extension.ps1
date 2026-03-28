# Run from inside vscode-extension/ to compile and launch the extension

$extensionPath = $PSScriptRoot
$rootPath      = Split-Path $extensionPath -Parent

Write-Host "`n[ACP] Compiling extension..." -ForegroundColor Cyan

Push-Location $extensionPath
npm run compile
$compileExit = $LASTEXITCODE
Pop-Location

if ($compileExit -ne 0) {
    Write-Host "`n[ACP] Compile failed (exit $compileExit). Fix errors above and try again." -ForegroundColor Red
    exit $compileExit
}

Write-Host "[ACP] Compile OK.`n" -ForegroundColor Green
Write-Host "[ACP] Launching Extension Development Host..." -ForegroundColor Cyan
Write-Host "      Extension : $extensionPath" -ForegroundColor DarkGray
Write-Host "      Workspace  : $rootPath`n"   -ForegroundColor DarkGray

# Open VS Code with:
#   --extensionDevelopmentPath  = this folder (the extension under development)
#   second arg                  = project root (so traces/ is visible in the workspace)
code --extensionDevelopmentPath="$extensionPath" "$rootPath"

Write-Host "[ACP] VS Code launched!" -ForegroundColor Green
Write-Host "      Ctrl+Shift+P -> ACP: Open Trace  to load a trace" -ForegroundColor Cyan
Write-Host "      Ctrl+Shift+P -> ACP: Show Execution Graph  to open the graph`n" -ForegroundColor Cyan

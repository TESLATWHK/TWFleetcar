$candidates = @(
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe"
)
$python = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $python) { $python = "python" }
& $python (Join-Path $PSScriptRoot "app.py")

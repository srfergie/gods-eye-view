# Start the local speech-to-text server for God's Eye View voice control.
# First run creates the venv and installs faster-whisper; later runs reuse it.
# Whisper downloads its model to the HuggingFace cache on first launch.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path '.venv')) {
    Write-Host 'Creating virtual environment...'
    py -3.12 -m venv .venv
    .\.venv\Scripts\python -m pip install --upgrade pip
    .\.venv\Scripts\python -m pip install -r requirements.txt
}

Write-Host 'Starting local voice speech-to-text on http://127.0.0.1:5181 ...'
.\.venv\Scripts\python server.py

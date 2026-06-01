Feishu Codex Bridge Portable

Run:
  Double click FeishuCodexBridge.exe

Build launcher:
  powershell -ExecutionPolicy Bypass -File scripts\build-exe.ps1

Windows service:
  Run PowerShell as Administrator, then:
    .\install-service.ps1
  Other commands:
    .\status-service.ps1
    .\start-service.ps1
    .\stop-service.ps1
    .\uninstall-service.ps1

Admin:
  http://127.0.0.1:3457

Config:
  .env

Notes:
  - This portable folder includes Node runtime and npm dependencies.
  - If codex-bin\codex.exe exists, the launcher uses it first.
  - Codex authentication is still read from the current Windows user profile.
  - Runtime logs and chat/task history are not included in this package.
  - Do not share this folder if .env contains real Feishu credentials.

$ErrorActionPreference = "Stop"
$Repo = if ($env:AGENT_REPO) { $env:AGENT_REPO } else { "yanglongyun/agentic" }
$Version = if ($env:AGENT_VERSION) { $env:AGENT_VERSION.TrimStart("v") } else { "latest" }
$BinDir = if ($env:AGENT_BIN_DIR) { $env:AGENT_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "agentic\bin" }
$Arch = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) { "X64" { "amd64" }; "Arm64" { "arm64" }; default { throw "不支持的 CPU 架构：$_" } }
if ($Version -eq "latest") { $Url = "https://github.com/$Repo/releases/latest/download/agent_windows_$Arch.zip" } else { $Url = "https://github.com/$Repo/releases/download/v$Version/agent_windows_$Arch.zip" }
$Temp = Join-Path ([IO.Path]::GetTempPath()) ("agentic-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Temp | Out-Null
try {
    $Zip = Join-Path $Temp "agent.zip"
    Write-Host "下载 $Url"
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Zip
    Expand-Archive -Path $Zip -DestinationPath $Temp -Force
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    Copy-Item (Join-Path $Temp "agent.exe") (Join-Path $BinDir "agent.exe") -Force
} finally { Remove-Item $Temp -Recurse -Force -ErrorAction SilentlyContinue }
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($UserPath -split ";") -notcontains $BinDir) {
    $NewPath = if ($UserPath) { "$UserPath;$BinDir" } else { $BinDir }
    [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
    $env:Path = "$env:Path;$BinDir"
    Write-Host "已加入用户 PATH；其他终端需重新打开。"
}
Write-Host "已安装：$(Join-Path $BinDir 'agent.exe')"
Write-Host "下一步：agent config"

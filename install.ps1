# Nub-IA installer for Windows (PowerShell 5.1+ / 7).
#
#   irm https://raw.githubusercontent.com/sebamar88/nub-ia/main/install.ps1 | iex
#
# Clones (or updates) the repository into $env:NUB_IA_DIR
# (default %LOCALAPPDATA%\nub-ia\app), installs its dependencies (the
# postinstall downloads the pinned rtk binary, SHA-256 verified), and puts a
# `nub-ia` command on the user PATH via %LOCALAPPDATA%\nub-ia\bin\nub-ia.cmd.
# Idempotent: run it again to update. Never asks for elevation.
#
# Requirements: Git for Windows (Git Bash is what pi uses for its bash tool),
# Node.js >= 22.19, and pi (@earendil-works/pi-coding-agent). pnpm is used
# through corepack/npx when not installed.
#
# The clone uses HTTPS by default (works for a public repository with no
# setup). For a private repository, or to use your SSH key, set
#   $env:NUB_IA_REPO = "git@github.com:sebamar88/nub-ia.git"
# or $env:NUB_IA_PROTOCOL = "ssh".
$ErrorActionPreference = "Stop"

$GithubPath = "sebamar88/nub-ia"
$Repo = if ($env:NUB_IA_REPO) { $env:NUB_IA_REPO }
	elseif ($env:NUB_IA_PROTOCOL -eq "ssh") { "git@github.com:$GithubPath.git" }
	else { "https://github.com/$GithubPath.git" }
$Branch = if ($env:NUB_IA_BRANCH) { $env:NUB_IA_BRANCH } else { "main" }
$App = if ($env:NUB_IA_DIR) { $env:NUB_IA_DIR } else { Join-Path $env:LOCALAPPDATA "nub-ia\app" }
$Bin = if ($env:NUB_IA_BIN) { $env:NUB_IA_BIN } else { Join-Path $env:LOCALAPPDATA "nub-ia\bin" }

function Say($m) { Write-Host "nub-ia installer: $m" }
function Have($c) { return [bool](Get-Command $c -ErrorAction SilentlyContinue) }

if (-not (Have git)) { throw "git is required (https://git-scm.com/download/win)." }
if (-not (Have node)) { throw "Node.js >= 22.19 is required (https://nodejs.org)." }
$v = (node -p "process.versions.node").Split(".")
if ([int]$v[0] -lt 22 -or ([int]$v[0] -eq 22 -and [int]$v[1] -lt 19)) { throw "Node.js $(node --version) is too old; Nub-IA needs >= 22.19." }
# Package manager preference: pnpm (direct, or through corepack/npx), then npm.
# Used both for pi below and for this package's dependencies.
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"   # corepack must not ask "Do you want to continue?" in a piped install
$Pm = if (Have pnpm) { @("pnpm") } elseif (Have corepack) { @("corepack", "pnpm") } elseif (Have npx) { @("npx", "--yes", "pnpm@11") } else { @("npm") }
function RunPm { param([string[]]$PmArgs) & $Pm[0] @($Pm[1..($Pm.Length - 1)] + $PmArgs); return $LASTEXITCODE }

if (-not (Have pi)) {
	Say "pi is not on PATH. Installing it globally with $($Pm[0])..."
	if ($Pm[0] -eq "npm") {
		npm install -g @earendil-works/pi-coding-agent
		if ($LASTEXITCODE -ne 0) { throw "could not install pi; run: npm install -g @earendil-works/pi-coding-agent" }
	} else {
		# pnpm refuses global installs until its bin dir is on PATH. Point it at
		# the standard location for this session and persist it in the user
		# environment the way `pnpm setup` does.
		$PnpmHome = if ($env:PNPM_HOME) { $env:PNPM_HOME } else { Join-Path $env:LOCALAPPDATA "pnpm" }
		$env:PNPM_HOME = $PnpmHome
		New-Item -ItemType Directory -Force -Path $PnpmHome | Out-Null
		if (($env:Path -split ";") -notcontains $PnpmHome) { $env:Path = "$PnpmHome;$env:Path" }
		if (-not [Environment]::GetEnvironmentVariable("PNPM_HOME", "User")) { [Environment]::SetEnvironmentVariable("PNPM_HOME", $PnpmHome, "User") }
		$userPathNow = [Environment]::GetEnvironmentVariable("Path", "User")
		if (($userPathNow -split ";") -notcontains $PnpmHome) { [Environment]::SetEnvironmentVariable("Path", "$PnpmHome;$userPathNow", "User") }
		# Tell pnpm explicitly where its global bin dir is (a user config may point elsewhere).
		if ((RunPm @("add", "-g", "--config.global-bin-dir=$PnpmHome", "@earendil-works/pi-coding-agent")) -ne 0) { throw "could not install pi; try: pnpm setup; pnpm add -g @earendil-works/pi-coding-agent" }
	}
}

if (Test-Path (Join-Path $App ".git")) {
	Say "updating $App"
	git -C $App fetch -q origin $Branch
	git -C $App checkout -q $Branch
	git -C $App pull -q --ff-only origin $Branch
} else {
	Say "cloning $Repo into $App"
	New-Item -ItemType Directory -Force -Path (Split-Path $App) | Out-Null
	$env:GIT_TERMINAL_PROMPT = "0"
	git clone -q --branch $Branch $Repo $App
	if ($LASTEXITCODE -ne 0) {
		if ($Repo -like "https://*") { throw "clone failed. If the repository is private, use your SSH key: `$env:NUB_IA_PROTOCOL='ssh'; irm .../install.ps1 | iex  (or `$env:NUB_IA_REPO='git@github.com:$GithubPath.git')" }
		throw "clone failed over SSH: check that your GitHub key has access to $GithubPath (ssh -T git@github.com)"
	}
}
if ($LASTEXITCODE -ne 0) { throw "git failed" }

Say "installing dependencies (this downloads the pinned rtk binary)"
Push-Location $App
try {
	$code = if ($Pm[0] -eq "npm") { npm install; $LASTEXITCODE } else { RunPm @("install", "--frozen-lockfile") }
	if ($code -ne 0) { throw "dependency install failed" }
} finally { Pop-Location }

New-Item -ItemType Directory -Force -Path $Bin | Out-Null
# The wrapper never embeds the install path: %~dp0 is the directory of the .cmd
# itself, so non-ASCII user names and spaces (C:\Users\Sebastián Martinez\…)
# cannot be mangled by the file's encoding. App and bin dirs are siblings.
$Wrapper = Join-Path $Bin "nub-ia.cmd"
$RelativeApp = if ((Split-Path $App) -eq (Split-Path $Bin)) { "..\" + (Split-Path $App -Leaf) } else { $null }
$Target = if ($RelativeApp) { "%~dp0$RelativeApp\bin\nub-ia.mjs" } else { "$App\bin\nub-ia.mjs" }
$WrapperText = "@echo off`r`nrem Nub-IA launcher wrapper (generated by install.ps1)`r`nnode `"$Target`" %*`r`n"
[System.IO.File]::WriteAllText($Wrapper, $WrapperText, (New-Object System.Text.UTF8Encoding $false))

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $Bin) {
	[Environment]::SetEnvironmentVariable("Path", "$Bin;$userPath", "User")
	$env:Path = "$Bin;$env:Path"
	Say "added $Bin to your user PATH (open a new terminal for other windows to see it)"
}

Say "installed: $Wrapper"
Say "run: nub-ia          (first launch provisions the agent home; then /login your providers)"
Say "update later with: nub-ia update   (or rerun this installer)"

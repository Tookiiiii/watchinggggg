param(
  [string]$MonitorPassword = $env:MONITOR_PASSWORD,
  [string]$RedisUrl = $env:UPSTASH_REDIS_REST_URL,
  [string]$RedisToken = $env:UPSTASH_REDIS_REST_TOKEN,
  [string]$VercelToken = $env:VERCEL_TOKEN,
  [string]$ProjectName = "asti-local-monitor"
)

$ErrorActionPreference = "Stop"
$NodeExe = Join-Path $env:ProgramFiles "nodejs\node.exe"
$NpmCli = Join-Path $env:ProgramFiles "nodejs\node_modules\npm\bin\npm-cli.js"

if (!(Test-Path $NodeExe) -or !(Test-Path $NpmCli)) {
  $NodeExe = "node"
  $NpmCli = "npm"
}

$VercelBase = @("exec", "--yes", "--cache", ".\.npm-cache", "--package", "vercel", "--", "vercel")

function Invoke-Vercel {
  $cmdArgs = @($VercelBase) + @args
  if (![string]::IsNullOrWhiteSpace($VercelToken)) {
    $cmdArgs += @("--token", $VercelToken)
  }
  & $NodeExe $NpmCli @cmdArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Vercel command failed: $($args -join ' ')"
  }
}

function Set-VercelEnv {
  param(
    [string]$Name,
    [string]$Value,
    [string]$Environment
  )

  $cmdArgs = @($VercelBase) + @("env", "add", $Name, $Environment, "--force", "--yes")
  if (![string]::IsNullOrWhiteSpace($VercelToken)) {
    $cmdArgs += @("--token", $VercelToken)
  }
  $Value | & $NodeExe $NpmCli @cmdArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to set Vercel env var $Name for $Environment"
  }
}

function Require-Value($Name, $Value, $Help) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "$Name is required. $Help"
  }
}

Require-Value "MONITOR_PASSWORD" $MonitorPassword "Set `$env:MONITOR_PASSWORD or pass -MonitorPassword."
Require-Value "UPSTASH_REDIS_REST_URL" $RedisUrl "Set `$env:UPSTASH_REDIS_REST_URL or pass -RedisUrl."
Require-Value "UPSTASH_REDIS_REST_TOKEN" $RedisToken "Set `$env:UPSTASH_REDIS_REST_TOKEN or pass -RedisToken."

Write-Host "Checking Vercel login..."
try {
  Invoke-Vercel whoami | Out-Host
} catch {
  if ([string]::IsNullOrWhiteSpace($VercelToken)) {
    Write-Host "Not logged in. Starting Vercel login..."
    Invoke-Vercel login | Out-Host
  } else {
    throw
  }
}

Write-Host "Linking project..."
Invoke-Vercel link --yes --project $ProjectName | Out-Host

Write-Host "Writing production environment variables..."
Set-VercelEnv MONITOR_PASSWORD $MonitorPassword production | Out-Host
Set-VercelEnv UPSTASH_REDIS_REST_URL $RedisUrl production | Out-Host
Set-VercelEnv UPSTASH_REDIS_REST_TOKEN $RedisToken production | Out-Host

Write-Host "Writing preview environment variables..."
Set-VercelEnv MONITOR_PASSWORD $MonitorPassword preview | Out-Host
Set-VercelEnv UPSTASH_REDIS_REST_URL $RedisUrl preview | Out-Host
Set-VercelEnv UPSTASH_REDIS_REST_TOKEN $RedisToken preview | Out-Host

Write-Host "Deploying to production..."
Invoke-Vercel deploy --prod --yes | Tee-Object -FilePath ".\vercel-deploy-url.txt"

Write-Host ""
Write-Host "Done. Deployment URL is saved in vercel-deploy-url.txt"
Write-Host "Monitor page: <deployment-url>/monitor"

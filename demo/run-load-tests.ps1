# run-load-tests.ps1 - CollabSync k6 load test orchestrator.
#
# Runs the load test against:
#   1. Single instance  (server1 directly at :3001)
#   2. Two instances    (nginx at :80, round-robins to server1 + server2)
#
# Then parses both JSON result files and prints a comparison table.
#
# Usage (from repo root):
#   .\demo\run-load-tests.ps1

$ErrorActionPreference = 'Stop'
$K6   = ".\demo\k6.exe"
$DEMO = ".\demo"

function Write-Banner($text) {
    $line = '=' * ($text.Length + 4)
    Write-Host "`n+$line+" -ForegroundColor Cyan
    Write-Host "|  $text  |" -ForegroundColor Cyan
    Write-Host "+$line+`n" -ForegroundColor Cyan
}

# -- Run single-instance test --------------------------------------------------
Write-Banner "Phase 1/2 - Single Instance (localhost:3001)"
Write-Host "Target: http://localhost:3001 (server1 only - Redis + Mongo still active)" -ForegroundColor Yellow
Write-Host "Duration: ~4 min (ramp 0->50->100->200 VUs, hold at each level)`n"

& $K6 run `
    --env TARGET=http://localhost:3001 `
    --env DOC_ID=k6-1inst `
    --env VU_RUNTIME_MS=120000 `
    --summary-export "$DEMO\summary-1inst.json" `
    "$DEMO\k6-load-test.js"

Write-Host "`n[Phase 1 complete] Waiting 10s before Phase 2...`n" -ForegroundColor Green
Start-Sleep -Seconds 10

# -- Run two-instance test -----------------------------------------------------
Write-Banner "Phase 2/2 - Two Instances (localhost:80 via nginx)"
Write-Host "Target: http://localhost (nginx -> server1 + server2 round-robin)" -ForegroundColor Yellow
Write-Host "Duration: ~4 min (same ramp profile)`n"

& $K6 run `
    --env TARGET=http://localhost `
    --env DOC_ID=k6-2inst `
    --env VU_RUNTIME_MS=120000 `
    --summary-export "$DEMO\summary-2inst.json" `
    "$DEMO\k6-load-test.js"

Write-Host "`n[Phase 2 complete]`n" -ForegroundColor Green

# -- Parse results and print summary ------------------------------------------

function Get-Metric($jsonFile, $metricName, $statName) {
    if (-not (Test-Path $jsonFile)) { return 'N/A' }
    try {
        $json = Get-Content $jsonFile -Raw | ConvertFrom-Json
        $metric = $json.metrics.$metricName
        if ($null -eq $metric) { return 'N/A' }
        $val = $metric.$statName
        if ($null -ne $val) { return [math]::Round($val, 4) }
    } catch {}
    return 'N/A'
}

Write-Banner "Results Summary"

$metrics = @(
    @{ Label = "Connect time avg (ms)";   Metric = "ws_connect_ms";  Stat = "avg" },
    @{ Label = "Connect time p95 (ms)";   Metric = "ws_connect_ms";  Stat = "p(95)" },
    @{ Label = "RTT avg (ms)";            Metric = "ws_rtt_ms";      Stat = "avg" },
    @{ Label = "RTT p95 (ms)";            Metric = "ws_rtt_ms";      Stat = "p(95)" },
    @{ Label = "RTT p99 (ms)";            Metric = "ws_rtt_ms";      Stat = "p(99)" },
    @{ Label = "Messages received (total)";Metric = "ws_msgs_received";Stat = "count" },
    @{ Label = "Messages sent (total)";   Metric = "ws_msgs_sent";   Stat = "count" },
    @{ Label = "RTT samples";             Metric = "ws_rtt_samples"; Stat = "count" },
    @{ Label = "Error rate";              Metric = "ws_error_rate";  Stat = "value" }
)

$fmt = "{0,-35} {1,14} {2,14}"
Write-Host ($fmt -f "Metric", "1 Instance", "2 Instances") -ForegroundColor White
Write-Host ("-" * 65) -ForegroundColor DarkGray

foreach ($m in $metrics) {
    $v1 = Get-Metric "$DEMO\summary-1inst.json" $m.Metric $m.Stat
    $v2 = Get-Metric "$DEMO\summary-2inst.json" $m.Metric $m.Stat
    Write-Host ($fmt -f $m.Label, $v1, $v2)
}

Write-Host "`nFull JSON summaries saved to:"
Write-Host "  demo\summary-1inst.json"
Write-Host "  demo\summary-2inst.json"
Write-Host "`nRun the Node.js report generator next:"
Write-Host "  node demo\generate-report.js" -ForegroundColor Cyan

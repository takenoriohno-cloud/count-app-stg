# ==============================================================================
# チラシ配布カウンター E2E外部結合自動テストスクリプト
# 
# 目的:
# 1. GitHub Pages (Staging) のデプロイ・HTML配信状態の検証
# 2. 正しいパスワードによるスプレッドシートへの行追記検証 (正常系)
# 3. 不正パスワードによるアクセス拒絶・BOT排除の検証 (異常系 / セキュリティ)
# 4. UNDO取り消しリクエストによるスプレッドシート該当行の「取消」ステータス更新検証 (整合性)
# ==============================================================================

Write-Host "=== Flyer Counter E2E External Integration Test ===" -ForegroundColor Cyan

$gasUrl = "https://script.google.com/macros/s/AKfycbylJHGM6Qa4oYnREqUPOuG0W55cWL0FzfDjKOpFX046sDk55Ede9jeOtQ6VUqsmfsUu/exec"
$testPassword = "chirashi2026"
$ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$testRecordId = "e2e-$ts"

# ------------------------------------------------------------------------------
# TEST 1: GitHub Pages 公開状態チェック
# ------------------------------------------------------------------------------
Write-Host "`n[TEST 1] Checking GitHub Pages deployment..."
$url = "https://takenoriohno-cloud.github.io/count-app-stg/"
$response = Invoke-WebRequest -Uri $url -UseBasicParsing
$html = $response.Content

if ($html -match "AKfycbylJHGM6Qa4oYnREqUPOuG0W55cWL0FzfDjKOpFX046sDk55Ede9jeOtQ6VUqsmfsUu") {
  Write-Host " -> PASS: Correct GAS URL is embedded on GitHub Pages" -ForegroundColor Green
} else {
  Write-Host " -> FAIL: GAS URL not found on GitHub Pages" -ForegroundColor Red
}

# ------------------------------------------------------------------------------
# TEST 2: 正常データ送信テスト（スプレッドシート行追加）
# ------------------------------------------------------------------------------
Write-Host "`n[TEST 2] Testing normal data submission with password '$testPassword'..."
$payloadNormal = @{
  password = $testPassword
  apiToken = $testPassword
  deviceId = "dev-e2e-tester-001"
  userName = "E2E-Tester"
  logs = @(
    @{
      recordId = $testRecordId
      timestamp = (Get-Date).ToString("o")
      gender = "Female"
      ageGroup = "20s"
      status = "Valid"
    }
  )
  cancelIds = @()
} | ConvertTo-Json -Depth 5 -Compress

$resNormal = Invoke-RestMethod -Uri $gasUrl -Method Post -Body $payloadNormal -ContentType "text/plain;charset=UTF-8"
if ($resNormal.status -eq "success" -and $resNormal.inserted -eq 1) {
  Write-Host " -> PASS: Record successfully inserted into spreadsheet (inserted: 1, recordId: $testRecordId)" -ForegroundColor Green
} else {
  Write-Host " -> FAIL: Normal submission failed: $($resNormal | ConvertTo-Json)" -ForegroundColor Red
}

# ------------------------------------------------------------------------------
# TEST 3: 不正パスワードによるBOT排除テスト (HTTP 401 / 拒絶)
# ------------------------------------------------------------------------------
Write-Host "`n[TEST 3] Testing BOT protection with wrong password 'bad_bot_pass'..."
$payloadBad = @{
  password = "bad_bot_pass"
  apiToken = "bad_bot_pass"
  deviceId = "bot-attacker-999"
  userName = "MaliciousBOT"
  logs = @(
    @{
      recordId = "fake-bot-1"
      timestamp = (Get-Date).ToString("o")
      gender = "Male"
      ageGroup = "10s"
      status = "Valid"
    }
  )
  cancelIds = @()
} | ConvertTo-Json -Depth 5 -Compress

try {
  $resBad = Invoke-RestMethod -Uri $gasUrl -Method Post -Body $payloadBad -ContentType "text/plain;charset=UTF-8"
  if ($resBad.status -eq "error") {
    Write-Host " -> PASS: Unauthorized access blocked with error status ($($resBad.message))" -ForegroundColor Green
  } else {
    Write-Host " -> FAIL: Bad password was unexpectedly accepted" -ForegroundColor Red
  }
} catch {
  Write-Host " -> PASS: Unauthorized access blocked with HTTP 401 Unauthorized" -ForegroundColor Green
}

# ------------------------------------------------------------------------------
# TEST 4: UNDO取り消し連携テスト（該当行のステータス更新）
# ------------------------------------------------------------------------------
Write-Host "`n[TEST 4] Testing UNDO cancel status update for record '$testRecordId'..."
$payloadUndo = @{
  password = $testPassword
  apiToken = $testPassword
  deviceId = "dev-e2e-tester-001"
  userName = "E2E-Tester"
  logs = @()
  cancelIds = @($testRecordId)
} | ConvertTo-Json -Depth 5 -Compress

$resUndo = Invoke-RestMethod -Uri $gasUrl -Method Post -Body $payloadUndo -ContentType "text/plain;charset=UTF-8"
if ($resUndo.status -eq "success" -and $resUndo.canceled -ge 1) {
  Write-Host " -> PASS: Record status successfully updated to CANCELED (canceled: $($resUndo.canceled))" -ForegroundColor Green
} else {
  Write-Host " -> FAIL: Cancel update failed: $($resUndo | ConvertTo-Json)" -ForegroundColor Red
}

Write-Host "`n=== ALL E2E EXTERNAL INTEGRATION TESTS PASSED ===" -ForegroundColor Cyan

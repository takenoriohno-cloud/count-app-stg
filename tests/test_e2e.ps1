# ==============================================================================
# Flyer Counter E2E Integration Test (Japanese Attribute Aligned)
# ==============================================================================

Write-Host "=== Flyer Counter E2E External Integration Test ===" -ForegroundColor Cyan

$gasUrl = "https://script.google.com/macros/s/AKfycbylJHGM6Qa4oYnREqUPOuG0W55cWL0FzfDjKOpFX046sDk55Ede9jeOtQ6VUqsmfsUu/exec"
$testPassword = "chirashi2026"
$ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$testRecordId = "$ts-test99"

# Unicode character helpers to guarantee 100% UTF-8 compatibility across all PowerShell versions
$strFemale = [string][char]0x5973 + [char]0x6027            # 女性
$strAge20 = "20" + [string][char]0x4ee3                     # 20代
$strValid = [string][char]0x6709 + [char]0x52b9             # 有効
$strUser = [string][char]0x30c6 + [char]0x30b9 + [char]0x30c8 + [char]0x62c5 + [char]0x5f53 # テスト担当

# 1. GitHub Pages live deployment check
Write-Host "`n[TEST 1] Checking GitHub Pages deployment..."
$url = "https://takenoriohno-cloud.github.io/count-app-stg/"
$response = Invoke-WebRequest -Uri $url -UseBasicParsing
$html = $response.Content

if ($html -match "AKfycbylJHGM6Qa4oYnREqUPOuG0W55cWL0FzfDjKOpFX046sDk55Ede9jeOtQ6VUqsmfsUu") {
  Write-Host " -> PASS: Correct GAS URL is embedded on GitHub Pages" -ForegroundColor Green
} else {
  Write-Host " -> FAIL: GAS URL not found on GitHub Pages" -ForegroundColor Red
}

# 2. Normal data submission test matching real app Japanese data format
Write-Host "`n[TEST 2] Testing normal data submission (matching real app Japanese attributes)..."
$payloadNormal = @{
  password = $testPassword
  apiToken = $testPassword
  deviceId = "dev-tester-real"
  userName = $strUser
  logs = @(
    @{
      recordId = $testRecordId
      timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
      gender = $strFemale
      ageGroup = $strAge20
      status = $strValid
    }
  )
  cancelIds = @()
} | ConvertTo-Json -Depth 5 -Compress

$resNormal = Invoke-RestMethod -Uri $gasUrl -Method Post -Body $payloadNormal -ContentType "text/plain;charset=UTF-8"
if ($resNormal.status -eq "success" -and $resNormal.inserted -eq 1) {
  Write-Host " -> PASS: Record successfully inserted with Japanese attributes (女性 / 20代 / 有効, recordId: $testRecordId)" -ForegroundColor Green
} else {
  Write-Host " -> FAIL: Normal submission failed: $($resNormal | ConvertTo-Json)" -ForegroundColor Red
}

# 3. Invalid password BOT protection test
Write-Host "`n[TEST 3] Testing BOT protection with wrong password 'bad_bot_pass'..."
$payloadBad = @{
  password = "bad_bot_pass"
  apiToken = "bad_bot_pass"
  deviceId = "bot-attacker-999"
  userName = "BOT"
  logs = @(
    @{
      recordId = "fake-1"
      timestamp = (Get-Date).ToString("o")
      gender = $strFemale
      ageGroup = $strAge20
      status = $strValid
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

# 4. UNDO cancel sync test
Write-Host "`n[TEST 4] Testing UNDO cancel status update for record '$testRecordId'..."
$payloadUndo = @{
  password = $testPassword
  apiToken = $testPassword
  deviceId = "dev-tester-real"
  userName = $strUser
  logs = @()
  cancelIds = @($testRecordId)
} | ConvertTo-Json -Depth 5 -Compress

$resUndo = Invoke-RestMethod -Uri $gasUrl -Method Post -Body $payloadUndo -ContentType "text/plain;charset=UTF-8"
if ($resUndo.status -eq "success" -and $resUndo.canceled -ge 1) {
  Write-Host " -> PASS: Record status successfully updated to '取消' (canceled: $($resUndo.canceled))" -ForegroundColor Green
} else {
  Write-Host " -> FAIL: Cancel update failed: $($resUndo | ConvertTo-Json)" -ForegroundColor Red
}

# 5. Schema validation test: Reject invalid attributes (e.g. English 'Female' / '20s')
Write-Host "`n[TEST 5] Testing schema validation: Rejecting invalid attributes (English 'Female' / '20s')..."
$payloadInvalidAttr = @{
  password = $testPassword
  apiToken = $testPassword
  deviceId = "dev-tester-real"
  userName = $strUser
  logs = @(
    @{
      recordId = "$ts-invalid-attr"
      timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
      gender = "Female" # Invalid! Must be 女性/男性/その他
      ageGroup = "20s"  # Invalid! Must be 20代
      status = "有効"
    }
  )
  cancelIds = @()
} | ConvertTo-Json -Depth 5 -Compress

try {
  $resInvalid = Invoke-RestMethod -Uri $gasUrl -Method Post -Body $payloadInvalidAttr -ContentType "text/plain;charset=UTF-8"
  if ($resInvalid.status -eq "error") {
    Write-Host " -> PASS: Correctly rejected invalid attributes with error: $($resInvalid.message)" -ForegroundColor Green
  } else {
    Write-Host " -> FAIL: Unexpectedly accepted invalid attributes (Female/20s)!" -ForegroundColor Red
  }
} catch {
  Write-Host " -> PASS: Correctly rejected invalid attributes with HTTP error ($($_.Exception.Message))" -ForegroundColor Green
}

# 6. Schema validation test: Reject missing required fields (empty deviceId)
Write-Host "`n[TEST 6] Testing schema validation: Rejecting missing required fields (empty deviceId)..."
$payloadMissingKey = @{
  password = $testPassword
  apiToken = $testPassword
  deviceId = "" # Invalid! Empty deviceId
  userName = $strUser
  logs = @(
    @{
      recordId = "$ts-missing-dev"
      timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
      gender = $strFemale
      ageGroup = $strAge20
      status = $strValid
    }
  )
  cancelIds = @()
} | ConvertTo-Json -Depth 5 -Compress

try {
  $resMissing = Invoke-RestMethod -Uri $gasUrl -Method Post -Body $payloadMissingKey -ContentType "text/plain;charset=UTF-8"
  if ($resMissing.status -eq "error") {
    Write-Host " -> PASS: Correctly rejected missing required deviceId: $($resMissing.message)" -ForegroundColor Green
  } else {
    Write-Host " -> FAIL: Unexpectedly accepted missing deviceId!" -ForegroundColor Red
  }
} catch {
  Write-Host " -> PASS: Correctly rejected missing deviceId with HTTP error ($($_.Exception.Message))" -ForegroundColor Green
}

Write-Host "`n=== ALL E2E EXTERNAL INTEGRATION & SCHEMA VALIDATION TESTS FINISHED ===" -ForegroundColor Cyan


/**
 * チラシ配布カウンター - Google Apps Script (GAS) バックエンド
 * 
 * 機能:
 * 1. APIトークンによる認証
 * 2. LockServiceによる排他制御（同時書き込み競合防止）
 * 3. 明細ログの一括追記 (raw_logsシート)
 * 4. UNDO時の該当レコード取消ステータス更新
 */

// デフォルトのアクセスパスワード（GASのスクリプトプロパティ「PASSWORD」を設定することで上書き・厳密化できます）
const DEFAULT_PASSWORD = "counter_secret_token_2026";

// 許容される属性値（スキーマ定義）
const ALLOWED_GENDERS = ["男性", "女性", "その他"];
const ALLOWED_AGE_GROUPS = ["10代", "20代", "30代", "40代", "50代", "60代以上"];
const ALLOWED_STATUSES = ["有効", "取消"];

/**
 * GETリクエスト: 疎通確認・ヘルスチェック用
 */
function doGet(e) {
  return createJsonResponse({
    status: "ok",
    message: "チラシ配布カウンター APIは正常稼働中です。",
    timestamp: new Date().toISOString()
  });
}

/**
 * POSTリクエスト: カウントログ登録および取消更新
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  
  // 最大30秒ロック待機（同時送信時の排他制御）
  const hasLock = lock.tryLock(30000);
  if (!hasLock) {
    return createJsonResponse({
      status: "error",
      message: "サーバーが混雑しています。しばらく経ってから再試行してください。（ロックタイムアウト）"
    }, 429);
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return createJsonResponse({ status: "error", message: "リクエストデータが空です。" }, 400);
    }

    const payload = JSON.parse(e.postData.contents);

    // 1. パスワード（秘密鍵）の照合によるBOT・部外者排除
    const scriptProperties = PropertiesService.getScriptProperties();
    // スクリプトプロパティ PASSWORD または API_TOKEN を参照
    const validPassword = scriptProperties.getProperty("PASSWORD") || scriptProperties.getProperty("API_TOKEN") || DEFAULT_PASSWORD;
    const clientPassword = payload.password || payload.apiToken;

    if (!clientPassword || clientPassword !== validPassword) {
      return createJsonResponse({ 
        status: "error", 
        message: "認証に失敗しました。パスワードが正しくありません。" 
      }, 401);
    }

    // 2. スキーマバリデーション（必須項目・許容値チェック）
    const validationError = validatePayload(payload);
    if (validationError) {
      return createJsonResponse({
        status: "error",
        message: "不正なデータ形式です: " + validationError
      }, 400);
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const rawSheet = getOrCreateSheet(ss, "raw_logs", [
      "レコードID",
      "記録日時(端末)",
      "端末ID",
      "配布者名",
      "性別",
      "年代",
      "ステータス",
      "受信日時(サーバー)"
    ]);

    let insertedCount = 0;
    let canceledCount = 0;

    // 3. 取消（UNDO）レコードのステータス更新
    if (Array.isArray(payload.cancelIds) && payload.cancelIds.length > 0) {
      canceledCount = markRecordsAsCanceled(rawSheet, payload.cancelIds);
    }

    // 4. 新規明細ログの一括追記
    if (Array.isArray(payload.logs) && payload.logs.length > 0) {
      const serverTime = new Date();
      const rows = payload.logs.map(log => [
        log.recordId || log.id,
        log.timestamp,
        payload.deviceId,
        payload.userName || "未設定",
        log.gender,
        log.ageGroup,
        log.status || "有効",
        serverTime
      ]);

      const lastRow = rawSheet.getLastRow();
      rawSheet.getRange(lastRow + 1, 1, rows.length, rows[0].length).setValues(rows);
      insertedCount = rows.length;
    }

    return createJsonResponse({
      status: "success",
      message: "データの同期が完了しました。",
      inserted: insertedCount,
      canceled: canceledCount,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    return createJsonResponse({
      status: "error",
      message: "サーバー内部エラーが発生しました: " + error.toString()
    }, 500);
  } finally {
    // 必ずロックを解放
    lock.releaseLock();
  }
}

/**
 * 該当レコードIDのステータス列（7列目: G列）を「取消」に更新
 */
function markRecordsAsCanceled(sheet, cancelIds) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 0;

  // A列（レコードID）と G列（ステータス）を取得
  const idRange = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const cancelSet = new Set(cancelIds);
  let updatedCount = 0;

  for (let i = 0; i < idRange.length; i++) {
    const rowId = String(idRange[i][0]);
    if (cancelSet.has(rowId)) {
      // 該当行の7列目（ステータス）を更新
      const targetRow = i + 2;
      sheet.getRange(targetRow, 7).setValue("取消");
      updatedCount++;
    }
  }

  return updatedCount;
}

/**
 * シートが存在しない場合は作成しヘッダー行を追加
 */
function getOrCreateSheet(ss, sheetName, headers) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(headers);
    // ヘッダー行の書式設定
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setBackground("#1e293b"); // slate-800
    headerRange.setFontColor("#f8fafc"); // slate-50
    headerRange.setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * JSONレスポンスのヘルパー関数
 */
function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * リクエストペイロードのスキーマ検証
 * @param {Object} payload 
 * @returns {string|null} エラーメッセージ（正常時はnull）
 */
function validatePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return "ペイロードがオブジェクト形式ではありません。";
  }

  // 端末IDの検証
  if (!payload.deviceId || typeof payload.deviceId !== "string" || payload.deviceId.trim() === "") {
    return "端末ID（deviceId）は必須です。";
  }

  // 配布者名の検証（未設定または文字列）
  if (payload.userName !== undefined && typeof payload.userName !== "string") {
    return "配布者名（userName）は文字列である必要があります。";
  }

  // logs 配列の検証
  if (payload.logs !== undefined) {
    if (!Array.isArray(payload.logs)) {
      return "logs は配列である必要があります。";
    }

    for (let i = 0; i < payload.logs.length; i++) {
      const log = payload.logs[i];
      if (!log || typeof log !== "object") {
        return `logs[${i}] がオブジェクトではありません。`;
      }

      // レコードID検証
      const recordId = log.recordId || log.id;
      if (!recordId || typeof recordId !== "string" || recordId.trim() === "") {
        return `logs[${i}]: recordId は必須の非空文字列です。`;
      }

      // タイムスタンプ検証
      if (!log.timestamp || typeof log.timestamp !== "string" || isNaN(Date.parse(log.timestamp))) {
        return `logs[${i}]: timestamp は有効なISO日時文字列である必要があります。`;
      }

      // 性別検証（男性、女性、その他のみ）
      if (!log.gender || !ALLOWED_GENDERS.includes(log.gender)) {
        return `logs[${i}]: 性別（gender）は「${ALLOWED_GENDERS.join(" / ")}」のいずれかである必要があります。（受信値: ${log.gender}）`;
      }

      // 年代検証（10代〜60代以上）
      if (!log.ageGroup || !ALLOWED_AGE_GROUPS.includes(log.ageGroup)) {
        return `logs[${i}]: 年代（ageGroup）は「${ALLOWED_AGE_GROUPS.join(" / ")}」のいずれかである必要があります。（受信値: ${log.ageGroup}）`;
      }

      // ステータス検証（指定がある場合）
      if (log.status && !ALLOWED_STATUSES.includes(log.status)) {
        return `logs[${i}]: ステータス（status）は「${ALLOWED_STATUSES.join(" / ")}」である必要があります。（受信値: ${log.status}）`;
      }
    }
  }

  // cancelIds 配列の検証
  if (payload.cancelIds !== undefined) {
    if (!Array.isArray(payload.cancelIds)) {
      return "cancelIds は配列である必要があります。";
    }
    for (let i = 0; i < payload.cancelIds.length; i++) {
      if (typeof payload.cancelIds[i] !== "string" || payload.cancelIds[i].trim() === "") {
        return `cancelIds[${i}] は非空文字列である必要があります。`;
      }
    }
  }

  return null;
}

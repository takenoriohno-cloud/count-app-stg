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

    const headers = [
      "レコードID",
      "記録日時(端末)",
      "端末ID",
      "配布者名",
      "性別",
      "年代",
      "ステータス",
      "受信日時(サーバー)",
      "時間帯(時)"
    ];
    const rawSheet = getOrCreateSheet(ss, "raw_logs", headers);

    // 既存シートで9列目が未定義の場合はヘッダーを追加
    if (rawSheet.getLastColumn() < 9) {
      rawSheet.getRange(1, 9).setValue("時間帯(時)")
        .setBackground("#1e293b")
        .setFontColor("#f8fafc")
        .setFontWeight("bold");
    }

    let insertedCount = 0;
    let canceledCount = 0;

    // 3. 取消（UNDO）レコードのステータス更新
    if (Array.isArray(payload.cancelIds) && payload.cancelIds.length > 0) {
      canceledCount = markRecordsAsCanceled(rawSheet, payload.cancelIds);
    }

    // 4. 新規明細ログの一括追記
    if (Array.isArray(payload.logs) && payload.logs.length > 0) {
      const serverTime = new Date();
      const hour = serverTime.getHours();
      const rows = payload.logs.map(log => [
        log.recordId || log.id,
        log.timestamp,
        payload.deviceId,
        payload.userName || "未設定",
        log.gender,
        log.ageGroup,
        log.status || "有効",
        serverTime,
        hour
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

/**
 * スプレッドシートを開いた時にカスタムメニューを追加
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu("チラシ集計")
    .addItem("📊 ダッシュボードを作成/再構築", "setupDashboard")
    .addItem("🕒 生データに時間帯列を補完", "fillHoursInRawLogs")
    .addToUi();
}

/**
 * 過去の生データ（raw_logs）で時間帯列（I列）が空の行を補完
 */
function fillHoursInRawLogs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName("raw_logs");
  if (!rawSheet) return;

  const lastRow = rawSheet.getLastRow();
  if (lastRow <= 1) return;

  // H列（受信日時）とI列（時間帯）
  const data = rawSheet.getRange(2, 8, lastRow - 1, 2).getValues();
  for (let i = 0; i < data.length; i++) {
    const serverTime = data[i][0];
    if (serverTime instanceof Date && (data[i][1] === "" || data[i][1] === undefined)) {
      data[i][1] = serverTime.getHours();
    }
  }
  rawSheet.getRange(2, 8, data.length, 2).setValues(data);
  SpreadsheetApp.getActiveSpreadsheet().toast("時間帯列の補完が完了しました。", "完了", 3);
}

/**
 * リアルタイム集計ダッシュボードシート（dashboard）を作成・初期化
 */
function setupDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("dashboard");
  if (!sheet) {
    sheet = ss.insertSheet("dashboard", 0); // 先頭に挿入
  } else {
    sheet.clear();
  }

  // グリッド線を表示
  sheet.setHiddenGridlines(false);

  // 1. タイトルバナー
  sheet.getRange("A1:P1").merge()
    .setValue("📊 チラシ配布 リアルタイム集計ダッシュボード")
    .setBackground("#1e293b")
    .setFontColor("#f8fafc")
    .setFontSize(16)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
  sheet.setRowHeight(1, 45);

  // 2. KPIカード
  // 総有効配布枚数
  sheet.getRange("B3:C3").merge().setValue("総配布枚数 (有効)").setFontWeight("bold").setFontColor("#1e40af").setHorizontalAlignment("center");
  sheet.getRange("B4:C4").merge().setFormula('=COUNTIF(raw_logs!G:G, "有効")').setFontSize(22).setFontWeight("bold").setFontColor("#1e40af").setHorizontalAlignment("center").setVerticalAlignment("middle").setBackground("#eff6ff");
  sheet.getRange("B3:C4").setBorder(true, true, true, true, false, false, "#93c5fd", SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  // 稼働スタッフ数
  sheet.getRange("E3:F3").merge().setValue("稼働スタッフ数").setFontWeight("bold").setFontColor("#065f46").setHorizontalAlignment("center");
  sheet.getRange("E4:F4").merge().setFormula('=IFERROR(COUNTA(UNIQUE(FILTER(raw_logs!D2:D, raw_logs!G2:G="有効", raw_logs!D2:D<>""))), 0)').setFontSize(22).setFontWeight("bold").setFontColor("#065f46").setHorizontalAlignment("center").setVerticalAlignment("middle").setBackground("#ecfdf5");
  sheet.getRange("E3:F4").setBorder(true, true, true, true, false, false, "#a7f3d0", SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  // 最終受信日時
  sheet.getRange("H3:J3").merge().setValue("最終受信日時").setFontWeight("bold").setFontColor("#334155").setHorizontalAlignment("center");
  sheet.getRange("H4:J4").merge().setFormula('=IFERROR(TEXT(MAX(raw_logs!H:H), "yyyy/mm/dd hh:mm:ss"), "-")').setFontSize(14).setFontWeight("bold").setFontColor("#334155").setHorizontalAlignment("center").setVerticalAlignment("middle").setBackground("#f8fafc");
  sheet.getRange("H3:J4").setBorder(true, true, true, true, false, false, "#cbd5e1", SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  sheet.setRowHeight(3, 24);
  sheet.setRowHeight(4, 40);

  // 3. セクション1: 年代 × 性別 配布集計
  sheet.getRange("A6:F6").merge()
    .setValue("■ 年代・性別別 配布集計")
    .setBackground("#3b82f6")
    .setFontColor("#ffffff")
    .setFontWeight("bold")
    .setFontSize(11)
    .setVerticalAlignment("middle");
  sheet.setRowHeight(6, 28);

  const ageHeaders = [["年代", "男性", "女性", "その他", "合計", "構成比"]];
  sheet.getRange("A7:F7").setValues(ageHeaders)
    .setBackground("#f1f5f9")
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setBorder(true, true, true, true, true, true, "#cbd5e1", SpreadsheetApp.BorderStyle.SOLID);

  const ageGroups = ["10代", "20代", "30代", "40代", "50代", "60代以上"];
  const ageRows = [];
  for (let i = 0; i < ageGroups.length; i++) {
    const rowIdx = 8 + i;
    ageRows.push([
      ageGroups[i],
      `=COUNTIFS(raw_logs!$G:$G, "有効", raw_logs!$E:$E, B$7, raw_logs!$F:$F, $A${rowIdx})`,
      `=COUNTIFS(raw_logs!$G:$G, "有効", raw_logs!$E:$E, C$7, raw_logs!$F:$F, $A${rowIdx})`,
      `=COUNTIFS(raw_logs!$G:$G, "有効", raw_logs!$E:$E, D$7, raw_logs!$F:$F, $A${rowIdx})`,
      `=SUM(B${rowIdx}:D${rowIdx})`,
      `=IFERROR(E${rowIdx}/$E$14, 0)`
    ]);
  }
  sheet.getRange("A8:F13").setValues(ageRows)
    .setHorizontalAlignment("center")
    .setBorder(true, true, true, true, true, true, "#e2e8f0", SpreadsheetApp.BorderStyle.SOLID);
  sheet.getRange("F8:F13").setNumberFormat("0.0%");

  // 年代合計行
  const ageTotalRow = [
    ["合計", "=SUM(B8:B13)", "=SUM(C8:C13)", "=SUM(D8:D13)", "=SUM(E8:E13)", "=IFERROR(SUM(F8:F13), 1)"]
  ];
  sheet.getRange("A14:F14").setValues(ageTotalRow)
    .setBackground("#e2e8f0")
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setBorder(true, true, true, true, true, true, "#cbd5e1", SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sheet.getRange("F14").setNumberFormat("0.0%");

  // 4. セクション2: 時間帯別 × 配布者別 配布実績
  sheet.getRange("A16:P16").merge()
    .setValue("■ 時間帯別 × 配布者別 配布実績")
    .setBackground("#10b981")
    .setFontColor("#ffffff")
    .setFontWeight("bold")
    .setFontSize(11)
    .setVerticalAlignment("middle");
  sheet.setRowHeight(16, 28);

  const timeHeaders = ["配布者名"];
  for (let h = 8; h <= 21; h++) {
    timeHeaders.push(`${h}時台`);
  }
  timeHeaders.push("個人合計");

  sheet.getRange(17, 1, 1, timeHeaders.length).setValues([timeHeaders])
    .setBackground("#f1f5f9")
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setBorder(true, true, true, true, true, true, "#cbd5e1", SpreadsheetApp.BorderStyle.SOLID);

  // 最大10人分のスタッフ行枠を用意
  const staffRows = [];
  for (let s = 0; s < 10; s++) {
    const rowIdx = 18 + s;
    const rowFormula = [];
    // A列: ユニーク配布者名（上から順に自動取得）
    rowFormula.push(`=IFERROR(INDEX(SORT(UNIQUE(FILTER(raw_logs!$D$2:$D, raw_logs!$G$2:$G="有効", raw_logs!$D$2:$D<>""))), ${s + 1}), "")`);

    // B〜O列: 各時間帯の件数
    for (let h = 8; h <= 21; h++) {
      rowFormula.push(`=IF($A${rowIdx}="", "", COUNTIFS(raw_logs!$G:$G, "有効", raw_logs!$D:$D, $A${rowIdx}, raw_logs!$I:$I, ${h}))`);
    }
    // P列: 個人合計
    rowFormula.push(`=IF($A${rowIdx}="", "", SUM(B${rowIdx}:O${rowIdx}))`);
    staffRows.push(rowFormula);
  }

  sheet.getRange(18, 1, staffRows.length, timeHeaders.length).setValues(staffRows)
    .setHorizontalAlignment("center")
    .setBorder(true, true, true, true, true, true, "#e2e8f0", SpreadsheetApp.BorderStyle.SOLID);

  // 時間帯合計行
  const totalRowIdx = 18 + staffRows.length;
  const timeTotalRow = ["時間帯合計"];
  for (let c = 2; c <= 15; c++) {
    const colLetter = String.fromCharCode(64 + c);
    timeTotalRow.push(`=SUM(${colLetter}18:${colLetter}${totalRowIdx - 1})`);
  }
  timeTotalRow.push(`=SUM(P18:P${totalRowIdx - 1})`);

  sheet.getRange(totalRowIdx, 1, 1, timeHeaders.length).setValues([timeTotalRow])
    .setBackground("#e2e8f0")
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setBorder(true, true, true, true, true, true, "#cbd5e1", SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  // 列幅の調整
  sheet.setColumnWidth(1, 120); // A列: 配布者名 / 年代
  for (let c = 2; c <= 16; c++) {
    sheet.setColumnWidth(c, 75);
  }

  SpreadsheetApp.getActiveSpreadsheet().toast("ダッシュボードの構築が完了しました！", "成功", 5);
}


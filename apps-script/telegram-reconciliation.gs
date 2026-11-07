/**
 * Apps Script sink for the `shift-report-collector` Supabase Edge Function.
 *
 * Deliberately a SECOND, standalone Apps Script deployment rather than an addition to the
 * Shift Encoder's existing one: the Encoder's script is live and its row shape is driven by
 * its own `type:'shift'` payload, and this reconciliation feed has a completely different
 * shape. Keeping them separate means nothing here can break the Encoder's pipeline.
 *
 * Deploy: Extensions > Apps Script in the destination spreadsheet, paste this file, set
 * SECRET below, then Deploy > New deployment > Web app, "Execute as: Me",
 * "Who has access: Anyone". The /exec URL is the SHEETS_WEBHOOK_URL secret.
 */

/** Must match the SHEETS_WEBHOOK_SECRET Edge Function secret. Change this. */
var SECRET = 'CHANGE-ME-sheets-secret';

var DEFAULT_SHEET = 'Telegram Reconciliation';

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    if (!SECRET || body.secret !== SECRET) {
      return json({ ok: false, error: 'bad secret' });
    }

    var columns = body.columns;
    var rows = body.rows;
    if (!columns || !columns.length || !rows || !rows.length) {
      return json({ ok: false, error: 'no rows' });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var name = body.sheet || DEFAULT_SHEET;
    var sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);

    // Write the header once, from whatever columns the caller actually sent, so adding a
    // column on the Edge Function side needs no change here beyond a fresh tab.
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(columns);
      sheet.getRange(1, 1, 1, columns.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }

    var flaggedIdx = columns.indexOf('flagged');
    var startRow = sheet.getLastRow() + 1;

    var matrix = rows.map(function (row) {
      return columns.map(function (col) {
        var v = row[col];
        return v === null || v === undefined ? '' : v;
      });
    });

    sheet.getRange(startRow, 1, matrix.length, columns.length).setValues(matrix);

    // Visible marker in the sheet itself, not just the boolean column: a flagged row is
    // tinted red so it reads as "check this one" at a glance while scanning.
    if (flaggedIdx !== -1) {
      for (var i = 0; i < matrix.length; i++) {
        if (matrix[i][flaggedIdx] === true || String(matrix[i][flaggedIdx]) === 'true') {
          sheet
            .getRange(startRow + i, 1, 1, columns.length)
            .setBackground('#fce8e6')
            .setFontColor('#a50e0e');
        }
      }
    }

    return json({ ok: true, appended: matrix.length });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doGet() {
  return json({ ok: true, status: 'shift-report reconciliation sink is live' });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

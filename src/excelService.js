/**
 * excelService.js
 * Tạo file Excel xuất danh sách work items từ project "Work Progress"
 * Sheet 1: "Work Item Completed" — các task đã Hoàn thành
 * Sheet 2: "Work Item ToDo"      — các task Backlog / Todo / In Progress
 */

const ExcelJS = require("exceljs");

// Map trạng thái sang tiếng Việt
const STATUS_VI = {
  backlog:      "Chờ xử lý",
  unstarted:    "Chưa bắt đầu",
  started:      "Đang thực hiện",
  completed:    "Hoàn thành",
  cancelled:    "Đã hủy",
  "In Progress":"Đang thực hiện",
  Completed:    "Hoàn thành",
  Cancelled:    "Đã hủy",
  Backlog:      "Chờ xử lý",
  Todo:         "Chưa bắt đầu",
  todo:         "Chưa bắt đầu",
};

// Nhóm "Completed"
const COMPLETED_STATES = new Set(["Hoàn thành", "Completed", "completed", "done", "Done"]);
// Nhóm "ToDo" (tất cả không phải Completed/Cancelled)
const CANCELLED_STATES  = new Set(["Đã hủy", "Cancelled", "cancelled"]);

function normalizeStatus(s) {
  if (!s) return "N/A";
  return STATUS_VI[s] || s;
}

function isCompleted(item) {
  const norm = normalizeStatus(item.state);
  return COMPLETED_STATES.has(norm) || COMPLETED_STATES.has(item.state);
}

function isCancelled(item) {
  const norm = normalizeStatus(item.state);
  return CANCELLED_STATES.has(norm) || CANCELLED_STATES.has(item.state);
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  } catch {
    return dateStr;
  }
}

function formatEffort(days) {
  if (!days) return "";
  return `${days} man-day${days > 1 ? "s" : ""}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hàm dùng chung: ghi một sheet với tiêu đề + dữ liệu
// ─────────────────────────────────────────────────────────────────────────────
function buildSheet(workbook, sheetName, title, headerColor, items) {
  const sheet = workbook.addWorksheet(sheetName, {
    pageSetup: { paperSize: 9, orientation: "landscape" },
  });

  const COLS = 8;

  // ─── Tiêu đề chính ───
  sheet.mergeCells(`A1:H1`);
  const titleCell = sheet.getCell("A1");
  titleCell.value = title;
  titleCell.font = { bold: true, size: 13, color: { argb: "FFFFFFFF" } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: headerColor } };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(1).height = 32;

  // ─── Dòng xuất ngày ───
  sheet.mergeCells("A2:H2");
  const subCell = sheet.getCell("A2");
  subCell.value = `Ngày xuất: ${new Date().toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}  |  Tổng: ${items.length} công việc`;
  subCell.font = { italic: true, size: 10, color: { argb: "FF595959" } };
  subCell.alignment = { horizontal: "center" };
  sheet.getRow(2).height = 20;

  // ─── Headers ───
  const HEADER_ROW = 3;
  const headers = [
    { header: "#",                                 width: 6  },
    { header: "Các đầu việc đã / đang thực hiện", width: 45 },
    { header: "Ước tính Nỗ lực (PDS)",             width: 22 },
    { header: "Nỗ lực thực tế (PDS)",              width: 22 },
    { header: "Deadline",                           width: 14 },
    { header: "Phụ trách",                          width: 18 },
    { header: "Trạng thái",                         width: 18 },
    { header: "Ghi chú",                            width: 42 },
  ];

  sheet.columns = headers.map(h => ({ width: h.width }));

  const headerRow = sheet.getRow(HEADER_ROW);
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h.header;
    cell.font  = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
    cell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: headerColor } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      top:    { style: "thin", color: { argb: "FFBFBFBF" } },
      left:   { style: "thin", color: { argb: "FFBFBFBF" } },
      bottom: { style: "thin", color: { argb: "FFBFBFBF" } },
      right:  { style: "thin", color: { argb: "FFBFBFBF" } },
    };
  });
  headerRow.height = 36;

  // ─── Dữ liệu ───
  const sorted = [...items].sort((a, b) => {
    if (a.sequence_id && b.sequence_id) return a.sequence_id - b.sequence_id;
    return new Date(a.created_at || 0) - new Date(b.created_at || 0);
  });

  const CENTERED = [1, 3, 4, 5, 6, 7];

  sorted.forEach((item, idx) => {
    const stateNorm = normalizeStatus(item.state);
    const row = sheet.addRow([
      idx + 1,
      item.name        || "",
      formatEffort(item.effort_days),
      formatEffort(item.effort_days),
      formatDate(item.due_date),
      item.assignees   || "Chưa phân công",
      stateNorm,
      item.description || "",
    ]);

    const bgColor = idx % 2 === 0 ? "FFE2EFDA" : "FFF0F9F3";  // xanh lá nhạt cho completed
    const bgTodo  = idx % 2 === 0 ? "FFDAE3F3" : "FFEFF5FB";  // xanh dương nhạt cho todo

    const isCmp = COMPLETED_STATES.has(stateNorm) || COMPLETED_STATES.has(item.state);
    const rowBg = isCmp ? bgColor : bgTodo;

    row.eachCell({ includeEmpty: true }, (cell, colNum) => {
      cell.alignment = {
        horizontal: CENTERED.includes(colNum) ? "center" : "left",
        vertical:   "middle",
        wrapText:   true,
      };
      cell.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: rowBg } };
      cell.border = {
        top:    { style: "hair", color: { argb: "FFBFBFBF" } },
        left:   { style: "hair", color: { argb: "FFBFBFBF" } },
        bottom: { style: "hair", color: { argb: "FFBFBFBF" } },
        right:  { style: "hair", color: { argb: "FFBFBFBF" } },
      };
      cell.font = { size: 10 };
    });

    // Tô màu cột Trạng thái
    const stateCell = row.getCell(7);
    if (stateNorm.includes("Hoàn thành")) {
      stateCell.font = { bold: true, size: 10, color: { argb: "FF375623" } };
      stateCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2EFDA" } };
    } else if (stateNorm.includes("Đang")) {
      stateCell.font = { bold: true, size: 10, color: { argb: "FF243F60" } };
      stateCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDAE3F3" } };
    } else if (stateNorm.includes("Hủy")) {
      stateCell.font = { size: 10, color: { argb: "FF7F7F7F" } };
      stateCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
    } else {
      stateCell.font = { size: 10, color: { argb: "FF595959" } };
    }

    row.height = 28;
  });

  // ─── Freeze + filter ───
  sheet.views = [{ state: "frozen", ySplit: HEADER_ROW }];
  sheet.autoFilter = {
    from: { row: HEADER_ROW, column: 1 },
    to:   { row: HEADER_ROW, column: COLS },
  };

  return sheet;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hàm chính: tạo workbook 2-sheet
// ─────────────────────────────────────────────────────────────────────────────
async function generateExcel(allItems, projectName = "Work Progress") {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Plane Notifier";
  workbook.created = new Date();

  // Phân loại
  const completedItems = allItems.filter(isCompleted);
  const todoItems      = allItems.filter(item => !isCompleted(item) && !isCancelled(item));

  // Sheet 1 — Work Item Completed (header: xanh lá đậm)
  buildSheet(
    workbook,
    "Work Item Completed",
    `✅ CÔNG VIỆC ĐÃ HOÀN THÀNH — ${projectName.toUpperCase()}`,
    "FF217346",   // Excel green
    completedItems
  );

  // Sheet 2 — Work Item ToDo (header: xanh dương đậm)
  buildSheet(
    workbook,
    "Work Item ToDo",
    `📋 CÔNG VIỆC ĐANG THỰC HIỆN / CHỜ XỬ LÝ — ${projectName.toUpperCase()}`,
    "FF2E75B6",   // Excel blue
    todoItems
  );

  return workbook.xlsx.writeBuffer();
}

module.exports = { generateExcel };

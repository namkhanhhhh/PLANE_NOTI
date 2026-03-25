/**
 * eventStore.js
 * Lưu trữ work item events từ project "Work Progress" (không gửi Discord)
 * Dữ liệu được persist vào file JSON để không mất khi restart server
 */

const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "..", "data", "work_progress_events.json");

// Đảm bảo thư mục data tồn tại
function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Đọc dữ liệu từ file
function loadEvents() {
  try {
    ensureDataDir();
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

// Ghi dữ liệu vào file
function saveEvents(events) {
  try {
    ensureDataDir();
    fs.writeFileSync(DATA_FILE, JSON.stringify(events, null, 2), "utf-8");
  } catch (err) {
    console.error("[EventStore] ❌ Lỗi ghi file:", err.message);
  }
}

// In-memory cache
let _events = loadEvents();

/**
 * Upsert (thêm mới hoặc cập nhật) một work item vào store
 */
function upsertWorkItem(issueData) {
  const { issue, project, state, creator, assignees } = issueData;

  if (!issue?.id) return;

  // Tính số ngày từ start_date đến due_date
  let effortDays = null;
  if (issue.start_date && (issue.target_date || issue.due_date)) {
    const start = new Date(issue.start_date);
    const end = new Date(issue.target_date || issue.due_date);
    const diff = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
    if (diff > 0) effortDays = diff;
  }

  // Format tên assignees
  const assigneeNames = assignees && assignees.length > 0
    ? assignees.map(a => {
        if (!a) return "N/A";
        if (typeof a === "string") return a.slice(0, 8);
        const u = a.user || a.member || a;
        return u.display_name || u.name || u.full_name ||
          `${u.first_name || ""} ${u.last_name || ""}`.trim() ||
          u.username || u.email || "N/A";
      }).join(", ")
    : "Chưa phân công";

  // Format tên creator
  let creatorName = "N/A";
  if (creator) {
    if (typeof creator === "string") creatorName = creator.slice(0, 8);
    else {
      const u = creator.user || creator.member || creator;
      creatorName = u.display_name || u.name || u.full_name ||
        `${u.first_name || ""} ${u.last_name || ""}`.trim() ||
        u.username || u.email || "N/A";
    }
  }

  // Lấy mô tả sạch (bỏ HTML)
  const description = issue.description_stripped ||
    (issue.description_html
      ? issue.description_html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
      : "") || "";

  const record = {
    id: issue.id,
    sequence_id: issue.sequence_id,
    name: issue.name || "Không có tiêu đề",
    project_id: project?.id,
    project_name: project?.name || "N/A",
    state: state?.name || issue.state_detail?.name || "Backlog",
    priority: issue.priority || "none",
    creator: creatorName,
    assignees: assigneeNames,
    start_date: issue.start_date || null,
    due_date: issue.target_date || issue.due_date || null,
    effort_days: effortDays,          // Ước tính nỗ lực (PDS)
    description: description,         // Ghi chú
    created_at: issue.created_at,
    updated_at: issue.updated_at || new Date().toISOString(),
    last_action: issueData._action || "created",
  };

  const existingIdx = _events.findIndex(e => e.id === issue.id);
  if (existingIdx >= 0) {
    _events[existingIdx] = { ..._events[existingIdx], ...record };
  } else {
    _events.unshift(record);
  }

  saveEvents(_events);
  console.log(`[EventStore] 💾 Đã lưu work item: "${record.name}" (${record.last_action})`);
}

/**
 * Lấy tất cả work items đã lưu
 */
function getAllWorkItems() {
  return _events;
}

/**
 * Xóa một work item theo ID
 */
function deleteById(id) {
  const before = _events.length;
  _events = _events.filter(e => e.id !== id);
  if (_events.length < before) {
    saveEvents(_events);
    console.log(`[EventStore] 🗑️ Đã xóa work item: ${id}`);
    return true;
  }
  return false; // Không tìm thấy
}

/**
 * Xóa toàn bộ dữ liệu - bắt đầu lại từ đầu
 */
function clearAll() {
  _events = [];
  saveEvents(_events);
  console.log("[EventStore] 🗑️ Đã xóa toàn bộ dữ liệu work items");
}

/**
 * Reload từ file (dùng khi khởi động)
 */
function reload() {
  _events = loadEvents();
  return _events;
}

module.exports = { upsertWorkItem, getAllWorkItems, deleteById, clearAll, reload };

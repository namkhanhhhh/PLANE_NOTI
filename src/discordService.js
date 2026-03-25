/**
 * discordService.js
 * Service để gửi thông báo đẹp đến Discord qua Webhook
 * Sử dụng Discord Embed format để hiển thị đẹp
 */

const axios = require("axios");

// Màu sắc cho từng priority
const PRIORITY_COLORS = {
  urgent: 0xe74c3c, // Đỏ tươi
  high: 0xe67e22, // Cam
  medium: 0xf1c40f, // Vàng
  low: 0x2ecc71, // Xanh lá
  none: 0x95a5a6, // Xám
};

// Emoji cho priority
const PRIORITY_EMOJI = {
  urgent: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🟢",
  none: "⚪",
};

// Emoji cho state group
const STATE_EMOJI = {
  backlog: "📋",
  unstarted: "⭕",
  started: "🔄",
  completed: "✅",
  cancelled: "❌",
};

/**
 * Format ngày giờ theo định dạng Việt Nam
 */
function formatDate(dateStr) {
  if (!dateStr) return "Chưa xác định";
  try {
    const date = new Date(dateStr);
    return date.toLocaleString("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Ho_Chi_Minh",
    });
  } catch {
    return dateStr;
  }
}

/**
 * Format tên thành viên
 */
function formatMemberName(member) {
  if (!member) return "Chưa phân công";

  // Nếu là chuỗi (chưa lấy được chi tiết), in tạm ra UUID (8 ký tự đầu)
  if (typeof member === "string") return "Mã ID: " + member.slice(0, 8);

  const userObj = member.user || member.member || (member.id ? member : null);

  if (!userObj) return "Mã ID: " + member.slice(0, 8);

  const displayName =
    userObj.display_name ||
    userObj.name ||
    userObj.full_name ||
    `${userObj.first_name || ""} ${userObj.last_name || ""}`.trim() ||
    userObj.email ||
    userObj.username ||
    "Unknown User";

  return displayName;
}

/**
 * Lấy màu theo priority
 */
function getPriorityColor(priority) {
  return PRIORITY_COLORS[priority?.toLowerCase()] || PRIORITY_COLORS.none;
}

/**
 * Xây dựng Discord Embed message cho event tạo issue mới
 */
function buildIssueCreatedEmbed(data) {
  const { issue, project, state, creator, assignees, labels, workspaceSlug } = data;

  const priority = issue.priority || "none";
  const priorityEmoji = PRIORITY_EMOJI[priority.toLowerCase()] || "⚪";
  const stateEmoji =
    STATE_EMOJI[state?.group?.toLowerCase()] ||
    STATE_EMOJI[state?.name?.toLowerCase()] ||
    "📌";

  // Tạo URL đến issue trên Plane
  const wSlug = workspaceSlug || process.env.PLANE_WORKSPACE_SLUG;
  const issueUrl =
    project && issue
      ? `${process.env.PLANE_BASE_URL?.replace("api.", "") ||
      "https://app.plane.so"
      }/${wSlug}/projects/${project.id}/issues/${issue.id}`
      : null;

  // Tên assignees
  let assigneeNames = "Chưa phân công";
  if (assignees?.length > 0) {
    const names = assignees.map(formatMemberName);
    // Nếu trên 2 người, cho xuống dòng
    if (names.length >= 2) {
      assigneeNames = names.join("\n");
    } else {
      assigneeNames = names[0];
    }
  }

  // Labels
  const labelNames = labels?.length
    ? labels.map((l) => `\`${l.name}\``).join(", ")
    : null;

  // Build description (rút gọn nếu quá dài)
  const description = issue.description_stripped || issue.description_html
    ? (issue.description_stripped || "").slice(0, 300) +
    ((issue.description_stripped || "").length > 300 ? "..." : "")
    : null;

  // Xây dựng embed fields
  const fields = [
    {
      name: "🏢 Workspace",
      value: wSlug || "N/A",
      inline: true,
    },
    {
      name: "📁 Dự án",
      value: project?.name || "Unknown",
      inline: true,
    },
    {
      name: `${stateEmoji} Trạng thái`,
      value: state?.name || "Backlog",
      inline: true,
    },
    {
      name: "👤 Người tạo",
      value: formatMemberName(creator),
      inline: true,
    },
    {
      name: "👥 Được giao cho",
      value: assigneeNames,
      inline: true,
    },
    {
      name: `${priorityEmoji} Độ ưu tiên`,
      value: priority.charAt(0).toUpperCase() + priority.slice(1) || "None",
      inline: true,
    },
  ];

  // Thêm labels nếu có
  if (labelNames) {
    fields.push({
      name: "🏷️ Nhãn",
      value: labelNames,
      inline: false,
    });
  }

  // Thêm Ngày kết thúc nếu có
  const endDate = issue.target_date || issue.due_date;
  if (endDate) {
    fields.push({
      name: "📅 Ngày kết thúc",
      value: formatDate(endDate),
      inline: true,
    });
  }

  // Thêm start date nếu có
  if (issue.start_date) {
    fields.push({
      name: "🚀 Ngày bắt đầu",
      value: formatDate(issue.start_date),
      inline: true,
    });
  }

  // Thêm estimate nếu có
  if (issue.estimate_point !== null && issue.estimate_point !== undefined) {
    fields.push({
      name: "⏱️ Ước lượng",
      value: `${issue.estimate_point} điểm`,
      inline: true,
    });
  }

  const embed = {
    title: `✨ Công việc mới vừa được tạo!`,
    description: [
      `## ${issue.name || "Không có tiêu đề"}`,
      description ? `\n> ${description.replace(/\n/g, "\n> ")}` : null,
      issueUrl ? `\n[🔗 Xem chi tiết trên Plane](${issueUrl})` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    color: getPriorityColor(priority),
    fields,
    footer: {
      text: `Plane.so • Nền tảng Work Item • ${formatDate(issue.created_at)}`,
    },
    timestamp: issue.created_at || new Date().toISOString(),
  };

  return embed;
}

/**
 * Xây dựng embed cho event cập nhật issue
 */
function buildIssueUpdatedEmbed(data, changedFields = []) {
  const { issue, project, state, creator, assignees, workspaceSlug } = data;

  const priority = issue.priority || "none";
  const priorityEmoji = PRIORITY_EMOJI[priority.toLowerCase()] || "⚪";
  const stateEmoji =
    STATE_EMOJI[state?.group?.toLowerCase()] || "📌";

  const wSlug = workspaceSlug || process.env.PLANE_WORKSPACE_SLUG;
  const issueUrl =
    project && issue
      ? `${process.env.PLANE_BASE_URL?.replace("api.", "") ||
      "https://app.plane.so"
      }/${wSlug}/projects/${project.id}/issues/${issue.id}`
      : null;

  const assigneeNames = assignees?.length
    ? assignees.map(formatMemberName).join(", ")
    : "Chưa phân công";

  const fields = [
    {
      name: "🏢 Workspace",
      value: wSlug || "N/A",
      inline: true,
    },
    {
      name: "📁 Dự án",
      value: project?.name || "Unknown",
      inline: true,
    },
    {
      name: `${stateEmoji} Trạng thái`,
      value: state?.name || "Backlog",
      inline: true,
    },
    {
      name: "👤 Người tạo",
      value: formatMemberName(creator),
      inline: true,
    },
    {
      name: "👥 Được giao cho",
      value: assigneeNames,
      inline: true,
    },
    {
      name: `${priorityEmoji} Độ ưu tiên`,
      value: priority.charAt(0).toUpperCase() + priority.slice(1),
      inline: true,
    },
  ];

  // Thêm Ngày kết thúc nếu có
  const endDate = issue.target_date || issue.due_date;
  if (endDate) {
    fields.push({
      name: "📅 Ngày kết thúc",
      value: formatDate(endDate),
      inline: true,
    });
  }

  // Thêm Ngày bắt đầu nếu có
  if (issue.start_date) {
    fields.push({
      name: "🚀 Ngày bắt đầu",
      value: formatDate(issue.start_date),
      inline: true,
    });
  }

  if (changedFields && changedFields.length > 0) {
    const fieldNamesVi = {
      name: "Tên công việc", description: "Mô tả", state: "Trạng thái", 
      priority: "Độ ưu tiên", assignees: "Người được giao", labels: "Nhãn", 
      due_date: "Ngày kết thúc", target_date: "Ngày kết thúc", 
      start_date: "Ngày bắt đầu", estimate_point: "Ước lượng"
    };

    const formatVal = (val) => {
      if (val === null || val === undefined || val === "") return "Trống";
      if (Array.isArray(val)) return val.length ? `[${val.length} mục]` : "Trống";
      if (typeof val === "object") return "[Dữ liệu]";
      if (typeof val === "string" && val.match(/^\d{4}-\d{2}-\d{2}/)) return formatDate(val);
      const str = String(val);
      return str.length > 50 ? str.slice(0, 50) + "..." : str;
    };

    const changesText = changedFields.map(change => {
      const label = fieldNamesVi[change.field] || change.field;
      return `**${label}**: ~~${formatVal(change.old_value)}~~ ➡️ ${formatVal(change.new_value)}`;
    }).join("\n");

    fields.push({
      name: "📝 Chi tiết thay đổi",
      value: changesText,
      inline: false,
    });
  }

  return {
    title: `🔄 Work Item đã được cập nhật`,
    description: [
      `## ${issue.name || "Không có tiêu đề"}`,
      issueUrl ? `[🔗 Xem chi tiết trên Plane](${issueUrl})` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    color: 0x3498db, // Xanh dương
    fields,
    footer: {
      text: `Plane.so • Nền tảng Work Item • ${formatDate(issue.updated_at)}`,
    },
    timestamp: issue.updated_at || new Date().toISOString(),
  };
}

/**
 * Gửi embed message đến Discord webhook
 */
async function sendToDiscord(embeds, content = null) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("DISCORD_WEBHOOK_URL chưa được cấu hình!");
  }

  const payload = {
    username: "Plane.so Notifier",
    embeds: Array.isArray(embeds) ? embeds : [embeds],
  };

  if (content) {
    payload.content = content;
  }

  try {
    const res = await axios.post(webhookUrl, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
    });
    console.log("[Discord] ✅ Đã gửi thông báo thành công:", res.status);
    return true;
  } catch (err) {
    const errorData = err.response?.data;
    console.error(
      "[Discord] ❌ Lỗi khi gửi thông báo:",
      err.message,
      errorData ? JSON.stringify(errorData) : ""
    );
    throw err;
  }
}

/**
 * Gửi thông báo issue được tạo
 */
async function notifyIssueCreated(fullIssueData) {
  const embed = buildIssueCreatedEmbed(fullIssueData);
  const projectName = fullIssueData.project?.name || "Unknown";
  await sendToDiscord(embed, `🔔 **${projectName}** - Có work item mới được tạo!`);
}

/**
 * Gửi thông báo issue được cập nhật
 */
async function notifyIssueUpdated(fullIssueData, changedFields) {
  const embed = buildIssueUpdatedEmbed(fullIssueData, changedFields);
  await sendToDiscord(embed);
}

/**
 * Gửi thông báo lỗi (debug)
 */
async function notifyError(message, details = null) {
  const embed = {
    title: "⚠️ Lỗi hệ thống",
    description: message,
    color: 0xe74c3c,
    fields: details
      ? [{ name: "Chi tiết", value: `\`\`\`${JSON.stringify(details, null, 2).slice(0, 1000)}\`\`\`` }]
      : [],
    timestamp: new Date().toISOString(),
  };
  await sendToDiscord(embed);
}

module.exports = {
  notifyIssueCreated,
  notifyIssueUpdated,
  notifyError,
  sendToDiscord,
  buildIssueCreatedEmbed,
  buildIssueUpdatedEmbed,
};

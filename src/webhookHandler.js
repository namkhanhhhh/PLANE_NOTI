/**
 * webhookHandler.js
 * Xử lý các webhook event đến từ Plane.so
 * Xác thực payload, phân loại event, lấy dữ liệu đầy đủ và gửi Discord
 */

const crypto = require("crypto");
const planeService = require("./planeService");
const discordService = require("./discordService");

// Lưu log các event đã xử lý (in-memory, tối đa 100 entries)
const eventLog = [];
const MAX_LOG = 100;

function addToLog(entry) {
  eventLog.unshift({ ...entry, timestamp: new Date().toISOString() });
  if (eventLog.length > MAX_LOG) eventLog.pop();
}

function getEventLog() {
  return eventLog;
}

/**
 * Xác thực chữ ký webhook từ Plane (nếu có secret)
 */
function verifySignature(rawBody, signature) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return true; // Không cấu hình secret → bỏ qua xác thực

  if (!signature) {
    console.warn("[Webhook] ⚠️ Không có chữ ký nhưng SECRET đã cấu hình");
    return false;
  }

  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(rawBody);
  const digest = hmac.digest("hex");
  const expectedSig = `sha256=${digest}`;

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSig)
  );
}

/**
 * Xác định loại sự kiện từ headers và body
 */
function classifyEvent(headers, body) {
  const eventType = headers["x-plane-event"] || "";
  const activityType = body?.action || body?.event || "";

  return {
    eventType: eventType.toLowerCase(),
    action: activityType.toLowerCase(),
  };
}

/**
 * Lấy workspace slug từ nhiều nguồn
 */
function resolveWorkspaceSlug(body) {
  return (
    body?.workspace?.slug ||
    body?.workspace_slug ||
    body?.data?.workspace_slug ||
    process.env.PLANE_WORKSPACE_SLUG
  );
}

/**
 * Lấy project ID từ payload
 */
function resolveProjectId(body) {
  return (
    body?.project?.id ||
    body?.project_id ||
    body?.data?.project_id ||
    body?.issue?.project ||
    body?.data?.project
  );
}

/**
 * Lấy issue ID từ payload
 */
function resolveIssueId(body) {
  return (
    body?.issue?.id ||
    body?.id ||
    body?.data?.id
  );
}

/**
 * Handler chính cho webhook
 */
async function handleWebhook(req, res) {
  const startTime = Date.now();

  // 1. Xác thực chữ ký
  const signature = req.headers["x-plane-signature"];
  const rawBody = req.rawBody || JSON.stringify(req.body);

  if (!verifySignature(rawBody, signature)) {
    console.warn("[Webhook] ❌ Chữ ký không hợp lệ");
    addToLog({ event: "REJECTED", reason: "Invalid signature", status: 401 });
    return res.status(401).json({ error: "Invalid signature" });
  }

  // 2. Parse body
  const body = req.body;
  if (!body) {
    return res.status(400).json({ error: "Empty body" });
  }

  // 3. Phân loại event
  const { eventType, action } = classifyEvent(req.headers, body);
  console.log(`[Webhook] 📥 Event: type="${eventType}" action="${action}"`);

  // 4. Xác nhận nhận được (trả về 200 ngay để Plane không retry)
  res.status(200).json({ received: true, event: eventType, action });

  // 5. Xử lý bất đồng bộ sau khi đã trả lời
  try {
    await processEvent(body, eventType, action);
    const elapsed = Date.now() - startTime;
    addToLog({
      event: eventType,
      action,
      status: "success",
      elapsed: `${elapsed}ms`,
      issueId: resolveIssueId(body),
    });
  } catch (err) {
    console.error("[Webhook] ❌ Lỗi khi xử lý event:", err.message);
    addToLog({
      event: eventType,
      action,
      status: "error",
      error: err.message,
      issueId: resolveIssueId(body),
    });

    // Gửi thông báo lỗi đến Discord (nếu cần debug)
    if (process.env.NOTIFY_ERRORS === "true") {
      await discordService.notifyError(
        `Lỗi xử lý webhook: ${err.message}`,
        { event: eventType, action }
      ).catch(() => { });
    }
  }
}

const processedEvents = new Map();

/**
 * Xử lý event theo loại
 */
async function processEvent(body, eventType, action) {
  // Hỗ trợ cả "issue" và "work_item" event type
  const isIssueEvent =
    eventType === "issue" ||
    eventType === "work_item" ||
    eventType === "" ||
    eventType.includes("issue");

  if (!isIssueEvent) {
    console.log(`[Webhook] ℹ️ Bỏ qua event không phải issue: ${eventType}`);
    return;
  }

  // TẮT HOÀN TOÀN THÔNG BÁO XÓA (Kể cả khi thiếu dữ liệu)
  if (action === "deleted" || action === "delete") {
    console.log("[Webhook] 🗑️ Bỏ qua event xóa theo cấu hình (không thông báo)");
    return;
  }

  // Xác định workspace, project, issue
  const workspaceSlug = resolveWorkspaceSlug(body);
  const projectId = resolveProjectId(body);
  const issueId = resolveIssueId(body);

  if (!workspaceSlug || !projectId || !issueId) {
    console.warn("[Webhook] ⚠️ Thiếu thông tin workspace/project/issue:", {
      workspaceSlug,
      projectId,
      issueId,
    });

    // Thử gửi thông báo với dữ liệu thô từ payload
    await handleRawPayload(body, action);
    return;
  }

  console.log(
    `[Webhook] 🔍 Lấy dữ liệu: workspace="${workspaceSlug}" project="${projectId}" issue="${issueId}"`
  );

  // Lấy dữ liệu đầy đủ từ Plane API
  const fullData = await planeService.getFullIssueInfo(
    workspaceSlug,
    projectId,
    issueId
  );

  if (!fullData) {
    console.error("[Webhook] ❌ Không lấy được dữ liệu issue từ Plane API");
    return;
  }

  // Chống lặp (duplicate) cho TẤT CẢ event nhận được liên tiếp
  const cacheKey = `${issueId}_${action || "created"}`;
  const lastProcessed = processedEvents.get(cacheKey);
  if (lastProcessed && Date.now() - lastProcessed < 15000) {
    console.log(`[Webhook] ⏭️ Bỏ qua event ${action} bị trùng lặp (duplicate event gửi từ Plane)`);
    return;
  }
  processedEvents.set(cacheKey, Date.now());

  // Điều hướng theo action
  if (action === "created" || action === "create" || action === "") {
    console.log("[Webhook] ✨ Xử lý event: Issue Created");
    await discordService.notifyIssueCreated({ ...fullData, workspaceSlug });
  } else if (action === "updated" || action === "update") {
    // Chống spam: Nếu issue vừa được tạo trong vòng 60 giây, bỏ qua event update
    const createdTime = new Date(fullData.issue.created_at).getTime();
    if (Date.now() - createdTime < 60000) {
      console.log("[Webhook] ⏭️ Bỏ qua event update vì work item vừa mới tạo (tránh spam 3 tin nhắn)");
      return;
    }

    console.log("[Webhook] 🔄 Xử lý event: Issue Updated");
    const changedFields = extractChangedFields(body);
    if (changedFields.length === 0) {
      console.log("[Webhook] ⏭️ Bỏ qua event update vì không có thay đổi quan trọng");
      return;
    }
    await discordService.notifyIssueUpdated({ ...fullData, workspaceSlug }, changedFields);
  } else if (action === "deleted" || action === "delete") {
    console.log("[Webhook] 🗑️ Xử lý event: Issue Deleted (Người dùng yêu cầu bỏ thông báo)");
    // Đã vô hiệu hóa thông báo Discord theo yêu cầu của user
    // await handleIssueDeleted(body, fullData);
  } else {
    // Mặc định: coi như created
    console.log(`[Webhook] ℹ️ Action không xác định "${action}", coi như created`);
    await discordService.notifyIssueCreated(fullData);
  }
}

/**
 * Xử lý khi không đủ thông tin để gọi API → dùng payload thô
 */
async function handleRawPayload(body, action) {
  const issue = body.issue || body.data || body;
  const project = body.project || {};

  console.log("[Webhook] ⚠️ Gửi thông báo từ payload thô (không có API call)");

  const embed = {
    title: `✨ Work Item mới được tạo!`,
    description: `## ${issue.name || issue.title || "Không có tiêu đề"}`,
    color: 0x5865f2,
    fields: [
      {
        name: "📁 Dự án",
        value: project.name || project.identifier || "Unknown",
        inline: true,
      },
      {
        name: "🔢 Mã task",
        value: issue.sequence_id
          ? `\`${project.identifier || "TASK"}-${issue.sequence_id}\``
          : "N/A",
        inline: true,
      },
      {
        name: "🎯 Hành động",
        value: action || "created",
        inline: true,
      },
    ],
    footer: {
      text: `Plane.so • ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`,
    },
    timestamp: new Date().toISOString(),
  };

  await discordService.sendToDiscord(embed, "🔔 Có work item mới từ Plane.so!");
}

/**
 * Xử lý event xóa issue
 */
async function handleIssueDeleted(body, fullData) {
  const issue = fullData?.issue || body?.issue || body?.data || body;
  const project = fullData?.project || body?.project || body?.data?.project || {};
  const workspaceSlug = resolveWorkspaceSlug(body);

  const sequenceId =
    project.identifier && issue.sequence_id
      ? `${project.identifier}-${issue.sequence_id}`
      : null;

  const embed = {
    title: "🗑️ Work Item đã được Gỡ bỏ",
    description: `## ${issue.name || issue.title || "Không có tiêu đề"}`,
    color: 0xe74c3c, // Màu đỏ (Urgent Red)
    fields: [
      {
        name: "🏢 Workspace",
        value: workspaceSlug || "N/A",
        inline: true,
      },
      {
        name: "📁 Dự án",
        value: project.name || "Unknown",
        inline: true,
      },
      ...(sequenceId
        ? [{ name: "🔢 Mã task", value: `\`${sequenceId}\``, inline: true }]
        : []),
    ],
    footer: {
      text: `Plane.so • Đã gỡ bỏ lúc ${new Date().toLocaleString("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh",
      })}`,
    },
    timestamp: new Date().toISOString(),
  };

  await discordService.sendToDiscord(embed);
}

/**
 * Trích xuất chi tiết các trường đã thay đổi từ payload update
 * Trả về danh sách object: { field, old_value, new_value }
 */
function extractChangedFields(body) {
  const changed = [];
  const newData = body.issue || body.data || {};
  const oldData = body.old_value || body.previous_data || body.updates || {};

  const tracked = [
    "name", "description", "state", "priority",
    "assignees", "labels", "due_date", "start_date", "target_date",
    "estimate_point", "module", "cycle", "parent",
  ];

  for (const field of tracked) {
    if (
      oldData[field] !== undefined &&
      JSON.stringify(oldData[field]) !== JSON.stringify(newData[field])
    ) {
      changed.push({
        field: field,
        old_value: oldData[field],
        new_value: newData[field]
      });
    }
  }

  return changed;
}

module.exports = {
  handleWebhook,
  getEventLog,
};

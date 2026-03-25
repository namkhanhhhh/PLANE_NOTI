/**
 * server.js - Main Express Server
 * Điểm vào chính của ứng dụng
 * - /webhook  : nhận event từ Plane.so
 * - /         : Dashboard quản lý & cấu hình
 * - /api/*    : REST API cho dashboard
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const { handleWebhook, getEventLog } = require("./src/webhookHandler");
const discordService = require("./src/discordService");
const planeService = require("./src/planeService");
const eventStore = require("./src/eventStore");
const excelService = require("./src/excelService");

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// Lưu rawBody để xác thực chữ ký webhook
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf-8");
    },
  })
);

// Request logger
app.use((req, _res, next) => {
  const now = new Date().toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
  });
  console.log(`[${now}] ${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────────
// Webhook endpoint (Plane.so → đây)
// ─────────────────────────────────────────────
app.post("/webhook", handleWebhook);

// ─────────────────────────────────────────────
// API Endpoints cho Dashboard
// ─────────────────────────────────────────────

// Lấy thông tin cấu hình hiện tại (ẩn token)
app.get("/api/config", (_req, res) => {
  const maskToken = (token) => {
    if (!token) return "";
    return token.length > 8
      ? token.slice(0, 4) + "****" + token.slice(-4)
      : "****";
  };

  res.json({
    planeBaseUrl: process.env.PLANE_BASE_URL || "https://api.plane.so",
    planeWorkspaceSlug: process.env.PLANE_WORKSPACE_SLUG || "",
    planeApiToken: maskToken(process.env.PLANE_API_TOKEN),
    discordWebhookConfigured: !!process.env.DISCORD_WEBHOOK_URL,
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL
      ? process.env.DISCORD_WEBHOOK_URL.replace(
          /\/webhooks\/(\d+)\/.+/,
          "/webhooks/$1/****"
        )
      : "",
    port: PORT,
    webhookSecret: process.env.WEBHOOK_SECRET ? "✅ Đã cấu hình" : "⚠️ Chưa cấu hình",
    notifyErrors: process.env.NOTIFY_ERRORS === "true",
  });
});

// Lấy log events
app.get("/api/logs", (_req, res) => {
  res.json(getEventLog());
});

// Test gửi Discord
app.post("/api/test-discord", async (_req, res) => {
  try {
    const embed = {
      title: "🧪 Test kết nối Discord",
      description:
        "Nếu bạn thấy tin nhắn này, kết nối Discord Webhook đã hoạt động!",
      color: 0x2ecc71,
      fields: [
        {
          name: "⏰ Thời gian",
          value: new Date().toLocaleString("vi-VN", {
            timeZone: "Asia/Ho_Chi_Minh",
          }),
          inline: true,
        },
        {
          name: "🌐 Server",
          value: `Port ${PORT}`,
          inline: true,
        },
      ],
      footer: { text: "Plane → Discord Notifier" },
      timestamp: new Date().toISOString(),
    };

    await discordService.sendToDiscord(embed, "🔔 Test kết nối thành công!");
    res.json({ success: true, message: "Đã gửi test message đến Discord!" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Test kết nối Plane API
app.get("/api/test-plane", async (_req, res) => {
  const workspaceSlug = process.env.PLANE_WORKSPACE_SLUG;
  if (!workspaceSlug) {
    return res
      .status(400)
      .json({ success: false, error: "PLANE_WORKSPACE_SLUG chưa được cấu hình" });
  }

  try {
    const axios = require("axios");
    const planeApi = axios.create({
      baseURL: process.env.PLANE_BASE_URL || "https://api.plane.so",
      headers: { "X-API-Key": process.env.PLANE_API_TOKEN },
      timeout: 8000,
    });

    const res2 = await planeApi.get(
      `/api/v1/workspaces/${workspaceSlug}/projects/`
    );
    const projects = res2.data?.results || res2.data || [];
    const count = Array.isArray(projects) ? projects.length : 0;

    res.json({
      success: true,
      message: `Kết nối Plane thành công! Tìm thấy ${count} project(s).`,
      projects: Array.isArray(projects)
        ? projects.slice(0, 10).map((p) => ({
            id: p.id,
            name: p.name,
            identifier: p.identifier,
          }))
        : [],
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.response?.data?.detail || err.message,
    });
  }
});

// Simulate webhook (test tạo issue giả)
app.post("/api/simulate", async (req, res) => {
  const { workspaceSlug, projectId, issueId } = req.body;

  if (!workspaceSlug || !projectId || !issueId) {
    return res.status(400).json({
      success: false,
      error: "Cần cung cấp workspaceSlug, projectId, issueId",
    });
  }

  try {
    const fullData = await planeService.getFullIssueInfo(
      workspaceSlug,
      projectId,
      issueId
    );

    if (!fullData) {
      return res.status(404).json({
        success: false,
        error: "Không tìm thấy issue trên Plane",
      });
    }

    await discordService.notifyIssueCreated(fullData);
    res.json({
      success: true,
      message: "Đã gửi thông báo test đến Discord!",
      issue: {
        name: fullData.issue?.name,
        project: fullData.project?.name,
        state: fullData.state?.name,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// Work Items Store API (dành cho project Work Progress)
// ─────────────────────────────────────────────

// Lấy danh sách tất cả work items đã lưu
app.get("/api/work-items", (_req, res) => {
  res.set("Cache-Control", "no-store");
  const items = eventStore.getAllWorkItems();
  res.json({ success: true, total: items.length, items });
});

// Xóa toàn bộ dữ liệu store → bắt đầu lại từ đầu
app.delete("/api/work-items", (_req, res) => {
  eventStore.clearAll();
  res.json({ success: true, message: "Đã xóa toàn bộ dữ liệu. Hệ thống sẵn sàng thu thập lại." });
});

// Xóa một work item cụ thể theo ID
app.delete("/api/work-items/:id", (req, res) => {
  const { id } = req.params;
  const deleted = eventStore.deleteById(id);
  if (deleted) {
    res.json({ success: true, message: `Đã xóa work item ${id}` });
  } else {
    res.status(404).json({ success: false, error: "Không tìm thấy work item" });
  }
});

// Xuất file Excel
app.get("/api/export-excel", async (req, res) => {
  try {
    const items = eventStore.getAllWorkItems();
    if (items.length === 0) {
      return res.status(404).json({ success: false, error: "Chưa có dữ liệu để xuất" });
    }
    const projectName = req.query.project || "Work Progress";
    const buffer = await excelService.generateExcel(items, projectName);
    const filename = `work-items-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error("[Excel] Lỗi tạo file:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// Serve Dashboard UI
// ─────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "OK",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// 404 handler
// ─────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ─────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("\n╔═══════════════════════════════════════════╗");
  console.log("║    🚀 Plane → Discord Notifier Server     ║");
  console.log("╠═══════════════════════════════════════════╣");
  console.log(`║  📡 Server:    http://localhost:${PORT}       ║`);
  console.log(`║  🔗 Webhook:   http://localhost:${PORT}/webhook║`);
  console.log(`║  🖥️  Dashboard: http://localhost:${PORT}       ║`);
  console.log("╠═══════════════════════════════════════════╣");

  const planeOk = !!process.env.PLANE_API_TOKEN && !!process.env.PLANE_WORKSPACE_SLUG;
  const discordOk = !!process.env.DISCORD_WEBHOOK_URL;

  console.log(`║  Plane API:   ${planeOk ? "✅ Đã cấu hình" : "❌ Chưa cấu hình"}           ║`);
  console.log(`║  Discord:     ${discordOk ? "✅ Đã cấu hình" : "❌ Chưa cấu hình"}           ║`);
  console.log("╚═══════════════════════════════════════════╝\n");

  if (!planeOk || !discordOk) {
    console.warn("⚠️  Vui lòng cấu hình file .env trước khi sử dụng!\n");
  }
});

module.exports = app;

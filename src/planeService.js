/**
 * planeService.js
 * Service để giao tiếp với Plane.so API
 * Lấy thông tin chi tiết của work item, member, project, state, label, ...
 */

const axios = require("axios");

const planeApi = axios.create({
  baseURL: process.env.PLANE_BASE_URL || "https://api.plane.so",
  headers: {
    "X-API-Key": process.env.PLANE_API_TOKEN,
    "Content-Type": "application/json",
  },
  timeout: 10000,
});

// Cache đơn giản để giảm số lần gọi API
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 phút

function getFromCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

function setToCache(key, data) {
  cache.set(key, { data, time: Date.now() });
}

/**
 * Lấy thông tin chi tiết của một issue
 */
async function getIssueDetail(workspaceSlug, projectId, issueId) {
  try {
    const url = `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/`;
    const res = await planeApi.get(url);
    return res.data;
  } catch (err) {
    console.error("[PlaneService] Lỗi khi lấy issue detail:", err.message);
    return null;
  }
}

/**
 * Lấy thông tin project
 */
async function getProject(workspaceSlug, projectId) {
  const cacheKey = `project_${projectId}`;
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  try {
    const url = `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/`;
    const res = await planeApi.get(url);
    setToCache(cacheKey, res.data);
    return res.data;
  } catch (err) {
    console.error("[PlaneService] Lỗi khi lấy project:", err.message);
    return null;
  }
}

/**
 * Lấy thông tin state (trạng thái)
 */
async function getState(workspaceSlug, projectId, stateId) {
  if (!stateId) return null;
  const cacheKey = `state_${stateId}`;
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  try {
    const url = `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/states/${stateId}/`;
    const res = await planeApi.get(url);
    setToCache(cacheKey, res.data);
    return res.data;
  } catch (err) {
    console.error("[PlaneService] Lỗi khi lấy state:", err.message);
    return null;
  }
}

/**
 * Lấy thông tin member
 */
async function getMember(workspaceSlug, memberId) {
  if (!memberId) return null;
  const cacheKey = `member_${memberId}`;
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  try {
    const url = `/api/v1/workspaces/${workspaceSlug}/members/${memberId}/`;
    const res = await planeApi.get(url);
    setToCache(cacheKey, res.data);
    return res.data;
  } catch (err) {
    console.error("[PlaneService] Lỗi khi lấy member:", err.message);
    return null;
  }
}

/**
 * Lấy thông tin nhiều members cùng lúc
 */
async function getMembers(workspaceSlug, memberIds = []) {
  if (!memberIds.length) return [];
  const promises = memberIds.map((id) => getMember(workspaceSlug, id));
  const results = await Promise.allSettled(promises);
  return results
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value);
}

/**
 * Lấy tất cả labels của project
 */
async function getLabels(workspaceSlug, projectId) {
  const cacheKey = `labels_${projectId}`;
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  try {
    const url = `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/labels/`;
    const res = await planeApi.get(url);
    const labels = res.data?.results || res.data || [];
    setToCache(cacheKey, labels);
    return labels;
  } catch (err) {
    console.error("[PlaneService] Lỗi khi lấy labels:", err.message);
    return [];
  }
}

/**
 * Láy toàn bộ members của workspace (để fallback nếu getMember cá nhân bị lỗi)
 */
async function getWorkspaceMembers(workspaceSlug) {
  const cacheKey = `ws_members_${workspaceSlug}`;
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  try {
    const url = `/api/v1/workspaces/${workspaceSlug}/members/`;
    const res = await planeApi.get(url);
    const members = res.data?.results || res.data || [];
    setToCache(cacheKey, members);
    return members;
  } catch (err) {
    console.error("[PlaneService] Lỗi khi lấy workspace members:", err.message);
    return [];
  }
}

/**
 * Lấy thông tin đầy đủ của một work item (issue + related data)
 */
async function getFullIssueInfo(workspaceSlug, projectId, issueId) {
  const [issue, project] = await Promise.all([
    getIssueDetail(workspaceSlug, projectId, issueId),
    getProject(workspaceSlug, projectId),
  ]);

  if (!issue) return null;

  // Lấy dữ liệu thêm (nhưng nếu lỗi sẽ tự fallback)
  const [state, fetchedCreator, fetchedAssignees, labels, workspaceMembers] = await Promise.all([
    getState(workspaceSlug, projectId, issue.state),
    issue.created_by ? getMember(workspaceSlug, issue.created_by) : null,
    issue.assignees && issue.assignees.length > 0 ? getMembers(workspaceSlug, issue.assignees) : [],
    getLabels(workspaceSlug, projectId),
    getWorkspaceMembers(workspaceSlug),
  ]);

  // Fallback map: Ưu tiên created_by_details hoặc tìm trong workspace members
  let creator = issue.created_by_details || fetchedCreator;
  if (!creator && issue.created_by && workspaceMembers.length > 0) {
    // Tìm kiếm user ID hoặc member ID trong danh sách workspace members
    creator = workspaceMembers.find(m => m.id === issue.created_by || m.member?.id === issue.created_by || m.user?.id === issue.created_by);
  }
  // Nếu vẫn không thấy, mới gán chuỗi ID để formatMemberName xử lý fallback
  if (!creator) creator = issue.created_by;
  
  // Nếu mảng fetchedAssignees rỗng, lấy từ assignee_details có sẵn hoặc fallback về danh sách ID assignees
  let assignees = fetchedAssignees;
  if (!assignees || assignees.length === 0) {
    if (issue.assignee_details && issue.assignee_details.length > 0) {
      assignees = issue.assignee_details;
    } else if (issue.assignees && issue.assignees.length > 0) {
      // Tìm assignees trong workspace members
      assignees = issue.assignees.map(id => workspaceMembers.find(m => m.id === id || m.member?.id === id || m.user?.id === id) || id);
    } else {
      assignees = [];
    }
  }

  // Map label IDs sang label objects
  const issueLabels = (issue.label_ids || issue.labels || [])
    .map((labelId) => labels.find((l) => l.id === labelId))
    .filter(Boolean);

  return {
    issue,
    project,
    state,
    creator,
    assignees,
    labels: issueLabels,
    workspaceSlug,
  };
}

module.exports = {
  getIssueDetail,
  getProject,
  getState,
  getMember,
  getMembers,
  getLabels,
  getFullIssueInfo,
};

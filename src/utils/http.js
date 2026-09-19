export function ok(res, data = {}, message = "OK", status = 200) {
  return res.status(status).json({ success: true, message, data });
}

export function fail(res, message = "Request failed", status = 400, details = undefined) {
  return res.status(status).json({ success: false, message, details });
}

export function pageMeta(page, limit, total) {
  return { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) };
}

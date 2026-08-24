// Kleine, browser- und testbare Sicherheitsprimitive für das Dashboard.
export function safeHttpUrl(value) {
  const text = String(value || '');
  return /^https?:\/\//i.test(text) ? text : null;
}

export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

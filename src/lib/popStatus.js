function dateKey(value) {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function institutionalToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function effectivePopStatus(status, validUntil, now) {
  if (status === "rascunho" || status === "arquivado") return status;
  const end = Date.parse(`${dateKey(validUntil)}T00:00:00.000Z`);
  const today = Date.parse(`${now instanceof Date ? institutionalToday(now) : now ?? institutionalToday()}T00:00:00.000Z`);
  const days = Math.round((end - today) / 86400000);
  if (days < 0) return "vencido";
  if (days <= 30) return "vencendo";
  return "vigente";
}

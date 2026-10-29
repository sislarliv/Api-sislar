function asLocalDate(value) {
  if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function effectivePopStatus(status, validUntil, now = new Date()) {
  if (status === "rascunho" || status === "arquivado") return status;
  const end = asLocalDate(validUntil);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((end.getTime() - startToday.getTime()) / 86400000);
  if (days < 0) return "vencido";
  if (days <= 30) return "vencendo";
  return "vigente";
}

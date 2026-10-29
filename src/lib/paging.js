import { z } from "zod";

export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function pageMeta(page, limit, total) {
  return { page, limit, total, pages: Math.ceil(total / limit) || 0 };
}

export function offset(page, limit) {
  return (page - 1) * limit;
}

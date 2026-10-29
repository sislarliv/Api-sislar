import { Prisma, PrismaClient } from "@prisma/client";
import { config } from "../config.js";

export const prisma = new PrismaClient({
  datasourceUrl: config.databaseUrl,
});

export function present(value) {
  if (value == null) return value;
  if (Prisma.Decimal.isDecimal(value)) return Number(value);
  if (value instanceof Date) {
    const midnightUtc = value.getUTCHours() === 0
      && value.getUTCMinutes() === 0
      && value.getUTCSeconds() === 0
      && value.getUTCMilliseconds() === 0;
    if (midnightUtc) {
      const month = String(value.getUTCMonth() + 1).padStart(2, "0");
      const day = String(value.getUTCDate()).padStart(2, "0");
      return `${value.getUTCFullYear()}-${month}-${day}`;
    }
    return value.toISOString();
  }
  if (Array.isArray(value)) return value.map(present);
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const camel = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      out[camel] = present(item);
    }
    return out;
  }
  return value;
}

export async function disconnect() {
  await prisma.$disconnect();
}

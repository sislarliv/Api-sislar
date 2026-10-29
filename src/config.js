import dotenv from "dotenv";

dotenv.config();

const defaultUrl = "postgres://sislar:sislar@localhost:5432/sislar";

function databaseUrl() {
  const raw = process.env.DATABASE_URL || defaultUrl;
  if (process.env.NODE_ENV !== "test") return raw;
  const url = new URL(raw);
  url.pathname = "/sislar_test";
  return url.toString();
}

const jwtSecret = process.env.JWT_SECRET || "dev-only-change-me";

if (process.env.NODE_ENV === "production" && jwtSecret === "dev-only-change-me") {
  throw new Error("Defina JWT_SECRET no ambiente de produção.");
}

export const config = {
  env: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 3333),
  databaseUrl: databaseUrl(),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "8h",
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 10),
  corsOrigin: process.env.CORS_ORIGIN || "*",
  demoPassword: "Sislar@2026",
};

process.env.DATABASE_URL = config.databaseUrl;

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config.js";

const schemaPath = fileURLToPath(new URL("../../sql/schema.sql", import.meta.url));

export function databaseName(connectionString = config.databaseUrl) {
  const name = new URL(connectionString).pathname.replace(/^\//, "");
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error("Nome de banco inválido.");
  }
  return name;
}

export async function waitForDatabase(connectionString = config.databaseUrl, attempts = 30) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`PostgreSQL indisponível em ${connectionString}. ${lastError?.message || ""}`.trim());
}

export async function ensureDatabase(connectionString = config.databaseUrl) {
  const name = databaseName(connectionString);
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  const client = new pg.Client({ connectionString: adminUrl.toString() });
  await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (!exists.rowCount) {
    await client.query(`CREATE DATABASE ${name}`);
  }
  await client.end();
}

export async function resetDatabase(connectionString = config.databaseUrl) {
  const name = databaseName(connectionString);
  if (config.env === "test" && name !== "sislar_test") {
    throw new Error("Os testes só recriam o banco sislar_test.");
  }
  if (config.env !== "test" && name === "sislar_test") {
    throw new Error("db:setup não altera sislar_test.");
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("CREATE SCHEMA public");
  const schema = await readFile(schemaPath, "utf8");
  await client.query(schema);
  await client.end();
}

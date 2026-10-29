import { config } from "../src/config.js";
import { disconnect } from "../src/db/prisma.js";
import { ensureDatabase, resetDatabase, waitForDatabase } from "../src/db/reset.js";
import { seed } from "../src/db/seed.js";

let ready;

export function prepare() {
  ready ??= (async () => {
    if (config.env !== "test") {
      throw new Error("Rode os testes com npm test.");
    }
    const admin = new URL(config.databaseUrl);
    admin.pathname = "/postgres";
    await waitForDatabase(admin.toString());
    await ensureDatabase();
    await waitForDatabase();
    await resetDatabase();
    await seed();
  })();
  return ready;
}

export async function shutdown() {
  await disconnect();
}

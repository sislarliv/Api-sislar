import { config } from "../config.js";
import { disconnect } from "./prisma.js";
import { resetDatabase, waitForDatabase } from "./reset.js";
import { seed } from "./seed.js";

await waitForDatabase(config.databaseUrl);
await resetDatabase(config.databaseUrl);
await seed();
await disconnect();
console.log("Banco sislar pronto.");

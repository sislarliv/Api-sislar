import { app } from "./app.js";
import { config } from "./config.js";
import { iniciarJobs, pararJobs } from "./grupo3/jobs.js";

const server = app.listen(config.port, () => {
  console.log(`SISLAR API em http://localhost:${config.port}`);
});

if (process.env.JOBS_ENABLED === "true") {
  iniciarJobs();
  console.log("Jobs agendados ligados.");
}

function encerrar(sinal) {
  console.log(`${sinal} recebido, encerrando.`);
  pararJobs();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.once("SIGTERM", () => encerrar("SIGTERM"));
process.once("SIGINT", () => encerrar("SIGINT"));

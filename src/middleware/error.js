import { Prisma } from "@prisma/client";
import { HttpError } from "../lib/httpError.js";

export function notFound(_req, _res, next) {
  next(new HttpError(404, "Recurso não encontrado."));
}

export function errorHandler(err, _req, res, _next) {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    res.status(400).json({ error: { message: "JSON inválido." } });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { message: err.message, details: err.details ?? null },
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      res.status(409).json({ error: { message: "Registro duplicado.", details: err.meta ?? null } });
      return;
    }
    if (err.code === "P2003" || err.code === "P2004") {
      res.status(422).json({ error: { message: "Dados fora das regras do cadastro.", details: err.meta ?? null } });
      return;
    }
  }
  const driverCode = err.meta?.code || err.code;
  if (driverCode === "23505") {
    res.status(409).json({ error: { message: "Registro duplicado." } });
    return;
  }
  if (driverCode === "23503" || driverCode === "23514" || String(err.message || "").includes("23514")) {
    res.status(422).json({ error: { message: "Dados fora das regras do cadastro." } });
    return;
  }

  console.error(err);
  res.status(500).json({ error: { message: "Erro interno do servidor." } });
}

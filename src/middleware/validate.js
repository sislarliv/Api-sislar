import { ZodError } from "zod";
import { HttpError } from "../lib/httpError.js";

export function validate(schema, source = "body") {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) {
      next(new HttpError(422, "Dados inválidos", formatZod(parsed.error)));
      return;
    }
    req[source] = parsed.data;
    next();
  };
}

export function formatZod(error) {
  if (!(error instanceof ZodError)) return error;
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

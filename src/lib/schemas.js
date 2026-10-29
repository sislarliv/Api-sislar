import { z } from "zod";

export const idParam = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, "Identificador inválido."),
});

export const passwordSchema = z.string().min(8, "A senha precisa ter ao menos 8 caracteres.").max(72, "A senha pode ter no máximo 72 caracteres.");

export const emailSchema = z.string().trim().email("E-mail inválido.").max(160).transform((value) => value.toLowerCase());

export function likeTerm(value) {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { emailSchema, passwordSchema } from "../lib/schemas.js";
import { asyncHandler } from "../middleware/async.js";
import { loadUser, publicUser, requireAuth, signToken } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

router.post(
  "/login",
  validate(z.object({ email: emailSchema, password: z.string().min(1).max(72) })),
  asyncHandler(async (req, res) => {
    const found = await prisma.users.findUnique({ where: { email: req.body.email } });
    const matches = found ? await bcrypt.compare(req.body.password, found.password_hash) : false;
    if (!found || !matches) throw new HttpError(401, "E-mail ou senha inválidos.");
    if (!found.active) throw new HttpError(403, "Acesso bloqueado.");
    const user = await loadUser(found.id);
    res.json({ token: signToken(user.id), user: publicUser(user) });
  }),
);

router.get("/eu", requireAuth, asyncHandler(async (req, res) => {
  res.json({ user: publicUser(req.user) });
}));

router.post(
  "/recuperar-senha",
  validate(z.object({ email: emailSchema })),
  asyncHandler(async (req, res) => {
    const user = await prisma.users.findUnique({ where: { email: req.body.email } });
    const payload = { message: "Se o e-mail estiver cadastrado, o pedido de redefinição foi registrado." };
    if (!user || !user.active) {
      res.json(payload);
      return;
    }
    const token = randomBytes(32).toString("hex");
    await prisma.password_resets.create({
      data: {
        user_id: user.id,
        token_hash: tokenHash(token),
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    if (config.env !== "production") payload.resetToken = token;
    res.json(payload);
  }),
);

router.post(
  "/redefinir-senha",
  validate(z.object({ token: z.string().min(20), password: passwordSchema })),
  asyncHandler(async (req, res) => {
    const hash = tokenHash(req.body.token);
    const passwordHash = await bcrypt.hash(req.body.password, config.bcryptRounds);
    await prisma.$transaction(async (tx) => {
      const updated = await tx.password_resets.updateMany({
        where: { token_hash: hash, used_at: null, expires_at: { gt: new Date() } },
        data: { used_at: new Date() },
      });
      if (updated.count !== 1) throw new HttpError(400, "Pedido de redefinição inválido ou expirado.");
      const reset = await tx.password_resets.findUnique({ where: { token_hash: hash } });
      const user = await tx.users.findUnique({ where: { id: reset.user_id } });
      if (!user?.active) throw new HttpError(400, "Pedido de redefinição inválido ou expirado.");
      await tx.users.update({ where: { id: user.id }, data: { password_hash: passwordHash } });
    });
    res.json({ message: "Senha redefinida." });
  }),
);

export default router;

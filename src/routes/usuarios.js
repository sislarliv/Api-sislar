import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { config } from "../config.js";
import { audit } from "../db/helpers.js";
import { present, prisma } from "../db/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { ROLE_LABELS } from "../lib/permissions.js";
import { emailSchema, idParam, passwordSchema } from "../lib/schemas.js";
import { pageMeta, pageSchema } from "../lib/paging.js";
import { asyncHandler } from "../middleware/async.js";
import { loadUser, publicUser, requireAuth, requirePerm } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();
const profilesSchema = z.array(z.enum(Object.keys(ROLE_LABELS))).min(1).max(4);

router.use(requireAuth);

router.get("/perfil", asyncHandler(async (req, res) => {
  res.json({ user: publicUser(req.user) });
}));

router.patch(
  "/perfil",
  validate(z.object({
    name: z.string().trim().min(3).max(120).optional(),
    sector: z.string().trim().min(2).max(80).optional(),
    council: z.string().trim().max(80).nullish(),
  }).refine((body) => Object.keys(body).length > 0, "Informe ao menos um campo.")),
  asyncHandler(async (req, res) => {
    const data = {};
    if (req.body.name !== undefined) data.name = req.body.name;
    if (req.body.sector !== undefined) data.sector = req.body.sector;
    if (req.body.council !== undefined) data.council = req.body.council;
    await prisma.users.update({ where: { id: req.user.id }, data });
    res.json({ user: publicUser(await loadUser(req.user.id)) });
  }),
);

router.patch(
  "/perfil/senha",
  validate(z.object({ currentPassword: z.string().min(1).max(72), password: passwordSchema })),
  asyncHandler(async (req, res) => {
    const user = await prisma.users.findUnique({ where: { id: req.user.id } });
    const matches = await bcrypt.compare(req.body.currentPassword, user.password_hash);
    if (!matches) throw new HttpError(401, "Senha atual inválida.");
    await prisma.users.update({
      where: { id: req.user.id },
      data: { password_hash: await bcrypt.hash(req.body.password, config.bcryptRounds) },
    });
    res.json({ message: "Senha alterada." });
  }),
);

router.get(
  "/usuarios",
  requirePerm("usuarios.manage"),
  validate(pageSchema.extend({ q: z.string().trim().max(80).optional() }), "query"),
  asyncHandler(async (req, res) => {
    const { page, limit, q } = req.query;
    const where = q ? {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ],
    } : undefined;
    const [total, rows] = await Promise.all([
      prisma.users.count({ where }),
      prisma.users.findMany({
        where,
        include: { user_profiles: { orderBy: { profile: "asc" } } },
        orderBy: { name: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    res.json({
      data: rows.map((row) => publicUser({
        ...present(row),
        profiles: row.user_profiles.map((item) => item.profile),
        permissions: [],
      })),
      meta: pageMeta(page, limit, total),
    });
  }),
);

router.post(
  "/usuarios",
  requirePerm("usuarios.manage"),
  validate(z.object({
    name: z.string().trim().min(3).max(120),
    email: emailSchema,
    password: passwordSchema,
    roleLabel: z.string().trim().min(2).max(80),
    sector: z.string().trim().min(2).max(80),
    council: z.string().trim().max(80).nullish(),
    profiles: profilesSchema,
    active: z.boolean().optional(),
  })),
  asyncHandler(async (req, res) => {
    const id = `u-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
    await prisma.$transaction(async (tx) => {
      await tx.users.create({
        data: {
          id,
          name: req.body.name,
          email: req.body.email,
          password_hash: await bcrypt.hash(req.body.password, config.bcryptRounds),
          role_label: req.body.roleLabel,
          sector: req.body.sector,
          council: req.body.council ?? null,
          active: req.body.active ?? true,
          demo: false,
          user_profiles: { create: req.body.profiles.map((profile) => ({ profile })) },
        },
      });
      await audit(tx, { userId: req.user.id, action: "criar", entity: "usuario", entityId: id, payload: { email: req.body.email } });
    });
    res.status(201).json({ user: publicUser(await loadUser(id)) });
  }),
);

router.get(
  "/usuarios/:id",
  requirePerm("usuarios.manage"),
  validate(idParam, "params"),
  asyncHandler(async (req, res) => {
    const user = await loadUser(req.params.id);
    if (!user) throw new HttpError(404, "Registro não encontrado.");
    res.json({ user: publicUser(user) });
  }),
);

router.patch(
  "/usuarios/:id",
  requirePerm("usuarios.manage"),
  validate(idParam, "params"),
  validate(z.object({
    name: z.string().trim().min(3).max(120).optional(),
    roleLabel: z.string().trim().min(2).max(80).optional(),
    sector: z.string().trim().min(2).max(80).optional(),
    council: z.string().trim().max(80).nullish(),
    profiles: profilesSchema.optional(),
    active: z.boolean().optional(),
    password: passwordSchema.optional(),
  })),
  asyncHandler(async (req, res) => {
    if (req.params.id === req.user.id && req.body.active === false) {
      throw new HttpError(422, "Você não pode bloquear o próprio acesso.");
    }
    const current = await prisma.users.findUnique({ where: { id: req.params.id } });
    if (!current) throw new HttpError(404, "Registro não encontrado.");
    await prisma.$transaction(async (tx) => {
      const data = {};
      if (req.body.name !== undefined) data.name = req.body.name;
      if (req.body.roleLabel !== undefined) data.role_label = req.body.roleLabel;
      if (req.body.sector !== undefined) data.sector = req.body.sector;
      if (req.body.council !== undefined) data.council = req.body.council;
      if (req.body.active !== undefined) data.active = req.body.active;
      if (req.body.password) data.password_hash = await bcrypt.hash(req.body.password, config.bcryptRounds);
      await tx.users.update({ where: { id: req.params.id }, data });
      if (req.body.profiles) {
        await tx.user_profiles.deleteMany({ where: { user_id: req.params.id } });
        await tx.user_profiles.createMany({
          data: req.body.profiles.map((profile) => ({ user_id: req.params.id, profile })),
        });
      }
      await audit(tx, { userId: req.user.id, action: "atualizar", entity: "usuario", entityId: req.params.id, payload: { active: req.body.active ?? null } });
    });
    res.json({ user: publicUser(await loadUser(req.params.id)) });
  }),
);

export default router;

import { Router } from "express";
import { z } from "zod";
import { present, prisma } from "../db/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { idParam } from "../lib/schemas.js";
import { asyncHandler } from "../middleware/async.js";
import { requireAuth, requirePerm } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();
const roomBody = z.object({
  wing: z.string().trim().min(2).max(60),
  number: z.string().trim().min(1).max(20),
  active: z.boolean().default(true),
  beds: z.array(z.string().trim().min(1).max(20)).min(1).max(20).refine((items) => new Set(items).size === items.length, "Leitos repetidos.").default(["A", "B"]),
});
const roomPatch = roomBody.pick({ wing: true, number: true, active: true }).partial()
  .refine((body) => Object.keys(body).length > 0, "Informe ao menos um campo.");
const bedBody = z.object({ label: z.string().trim().min(1).max(20), active: z.boolean().default(true) });
const bedParams = z.object({ id: idParam.shape.id, bedId: idParam.shape.id });

async function roomOr404(tx, id) {
  const room = await tx.rooms.findUnique({ where: { id }, include: { beds: { orderBy: { label: "asc" } } } });
  if (!room) throw new HttpError(404, "Quarto não encontrado.");
  return room;
}

async function occupants(tx, room) {
  return tx.patients.findMany({
    where: { wing: room.wing, room: room.number, active: true },
    select: { id: true, code: true, name: true, bed: true, presence_status: true },
    orderBy: { bed: "asc" },
  });
}

function roomView(room, patients) {
  const byBed = new Map(patients.map((patient) => [patient.bed, patient]));
  return {
    id: room.id, wing: room.wing, number: room.number, active: room.active,
    createdAt: present(room.created_at),
    occupancy: patients.length,
    capacity: room.beds.filter((bed) => bed.active).length,
    beds: room.beds.map((bed) => ({
      id: bed.id, label: bed.label, active: bed.active,
      occupant: byBed.has(bed.label) ? present(byBed.get(bed.label)) : null,
    })),
  };
}

router.use(requireAuth);

router.get(
  "/",
  requirePerm("modulo.idosos", "prontuario.view"),
  validate(z.object({ wing: z.string().trim().max(60).optional(), active: z.enum(["true", "false"]).transform((value) => value === "true").optional() }), "query"),
  asyncHandler(async (req, res) => {
    const rooms = await prisma.rooms.findMany({
      where: {
        ...(req.query.wing ? { wing: req.query.wing } : {}),
        ...(req.query.active !== undefined ? { active: req.query.active } : {}),
      },
      include: { beds: { orderBy: { label: "asc" } } },
      orderBy: [{ wing: "asc" }, { number: "asc" }],
    });
    const patients = await prisma.patients.findMany({
      where: { active: true },
      select: { id: true, code: true, name: true, wing: true, room: true, bed: true, presence_status: true },
    });
    const byRoom = new Map();
    for (const patient of patients) {
      const key = `${patient.wing}|${patient.room}`;
      if (!byRoom.has(key)) byRoom.set(key, []);
      byRoom.get(key).push(patient);
    }
    res.json({ data: rooms.map((room) => roomView(room, byRoom.get(`${room.wing}|${room.number}`) ?? [])) });
  }),
);

router.post(
  "/",
  requirePerm("leitos.manage"),
  validate(roomBody),
  asyncHandler(async (req, res) => {
    const created = await prisma.rooms.create({
      data: {
        wing: req.body.wing, number: req.body.number, active: req.body.active,
        beds: { create: req.body.beds.map((label) => ({ label })) },
      },
      include: { beds: { orderBy: { label: "asc" } } },
    });
    res.status(201).json(roomView(created, []));
  }),
);

router.get(
  "/:id",
  requirePerm("modulo.idosos", "prontuario.view"),
  validate(idParam, "params"),
  asyncHandler(async (req, res) => {
    const room = await roomOr404(prisma, req.params.id);
    res.json(roomView(room, await occupants(prisma, room)));
  }),
);

router.patch(
  "/:id",
  requirePerm("leitos.manage"),
  validate(idParam, "params"),
  validate(roomPatch),
  asyncHandler(async (req, res) => {
    const result = await prisma.$transaction(async (tx) => {
      const room = await roomOr404(tx, req.params.id);
      const occupied = await occupants(tx, room);
      const locationChange = (req.body.wing !== undefined && req.body.wing !== room.wing)
        || (req.body.number !== undefined && req.body.number !== room.number);
      if (occupied.length && (locationChange || req.body.active === false)) {
        throw new HttpError(409, "Transfira os idosos antes de alterar ou inativar o quarto.");
      }
      const updated = await tx.rooms.update({ where: { id: room.id }, data: req.body, include: { beds: { orderBy: { label: "asc" } } } });
      return roomView(updated, occupied);
    });
    res.json(result);
  }),
);

router.post(
  "/:id/leitos",
  requirePerm("leitos.manage"),
  validate(idParam, "params"),
  validate(bedBody),
  asyncHandler(async (req, res) => {
    await roomOr404(prisma, req.params.id);
    const bed = await prisma.beds.create({ data: { room_id: req.params.id, label: req.body.label, active: req.body.active } });
    res.status(201).json(present(bed));
  }),
);

router.patch(
  "/:id/leitos/:bedId",
  requirePerm("leitos.manage"),
  validate(bedParams, "params"),
  validate(bedBody.partial().refine((body) => Object.keys(body).length > 0, "Informe ao menos um campo.")),
  asyncHandler(async (req, res) => {
    const result = await prisma.$transaction(async (tx) => {
      const room = await roomOr404(tx, req.params.id);
      const bed = room.beds.find((item) => item.id === req.params.bedId);
      if (!bed) throw new HttpError(404, "Leito não encontrado.");
      const occupied = await tx.patients.findFirst({
        where: { wing: room.wing, room: room.number, bed: bed.label, active: true },
        select: { id: true },
      });
      if (occupied && ((req.body.label !== undefined && req.body.label !== bed.label) || req.body.active === false)) {
        throw new HttpError(409, "Transfira o idoso antes de alterar ou inativar o leito.");
      }
      return tx.beds.update({ where: { id: bed.id }, data: req.body });
    });
    res.json(present(result));
  }),
);

export default router;

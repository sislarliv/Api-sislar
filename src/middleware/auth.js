import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { present, prisma } from "../db/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { ALL_PERMISSIONS } from "../lib/permissions.js";

export function signToken(userId) {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

export async function loadUser(id) {
  const row = await prisma.users.findUnique({
    where: { id },
    include: { user_profiles: { orderBy: { profile: "asc" } } },
  });
  if (!row) return null;
  const profiles = row.user_profiles.map((item) => item.profile);
  const grants = await prisma.role_permissions.findMany({
    where: { role_id: { in: profiles } },
    select: { permission_code: true },
  });
  const permissions = profiles.includes("admin")
    ? ALL_PERMISSIONS
    : [...new Set(grants.map((item) => item.permission_code))];
  return {
    ...present(row),
    profiles,
    permissions,
  };
}

export function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roleLabel: user.roleLabel,
    sector: user.sector,
    council: user.council,
    active: user.active,
    demo: user.demo,
    profiles: user.profiles,
    permissions: user.permissions,
  };
}

export function requireAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  const [, token] = header.split(" ");
  if (!token) {
    next(new HttpError(401, "Não autenticado."));
    return;
  }
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    next(new HttpError(401, "Sessão inválida ou expirada."));
    return;
  }
  loadUser(payload.sub)
    .then((user) => {
      if (!user || !user.active) {
        next(new HttpError(401, "Sessão inválida ou expirada."));
        return;
      }
      req.user = user;
      next();
    })
    .catch(next);
}

export function requirePerm(...codes) {
  return (req, _res, next) => {
    if (!req.user) {
      next(new HttpError(401, "Não autenticado."));
      return;
    }
    const allowed = codes.some((code) => req.user.permissions.includes(code));
    if (!allowed) {
      next(new HttpError(403, "Você não tem autorização para esta ação."));
      return;
    }
    next();
  };
}

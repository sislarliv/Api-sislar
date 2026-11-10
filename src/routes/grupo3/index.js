// Rotas do Grupo 3 (Agenda, atendimentos e profissionais), montadas em /api.
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import agendamentosRouter from "./agendamentos.js";
import clinicoRouter from "./clinico.js";
import colaboradoresRouter from "./colaboradores.js";
import escalasRouter from "./escalas.js";
import especialidadesRouter from "./especialidades.js";
import fisioterapiaRouter from "./fisioterapia.js";
import indicadoresRouter from "./indicadores.js";
import presencasRouter from "./presencas.js";
import relatoriosRouter from "./relatorios.js";
import tarefasRouter from "./tarefas.js";
import tiposAtendimentoRouter from "./tipos-atendimento.js";

const router = Router();

// Reaproveita a sessão já carregada por um router anterior em /api; senão autentica.
router.use((req, res, next) => (req.user ? next() : requireAuth(req, res, next)));
router.use(tiposAtendimentoRouter);
router.use(colaboradoresRouter);
router.use(agendamentosRouter);
router.use(especialidadesRouter);
router.use(escalasRouter);
router.use(presencasRouter);
router.use(clinicoRouter);
router.use(fisioterapiaRouter);
router.use(tarefasRouter);
router.use(indicadoresRouter);
router.use(relatoriosRouter);

export default router;

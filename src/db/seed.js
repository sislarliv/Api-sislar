import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { ALL_PERMISSIONS, PERMISSION_CATALOG, ROLE_DESCRIPTIONS, ROLE_LABELS, ROLE_PERMISSIONS } from "../lib/permissions.js";
import { buildPatients, loadNames } from "./patients.js";
import { prisma } from "./prisma.js";

const USERS = [
  ["s01", "Marta Oliveira Lima", "Administradora", "Administração", "admin", ["admin"], "marta.lima@lardoirmaovelho.example", null, true],
  ["s02", "Ricardo Almeida Teixeira", "Gestor assistencial", "Coordenação assistencial", "gestor", ["gestor", "enfermagem"], "ricardo.teixeira@lardoirmaovelho.example", null, true],
  ["s03", "Carla Beatriz Nunes", "Enfermeira responsável técnica", "Enfermagem", "enfermagem", ["enfermagem"], "carla.nunes@lardoirmaovelho.example", "COREN-SP 000.123 (fictício)", true],
  ["s04", "Joana Paiva Rocha", "Técnica de enfermagem", "Enfermagem", "tecnico", ["tecnico"], "joana.rocha@lardoirmaovelho.example", "COREN-SP 000.456 (fictício)", true],
  ["s05", "Dr. Paulo Ferraz Neto", "Médico geriatra", "Atendimento médico", "medico", ["medico"], "paulo.ferraz@lardoirmaovelho.example", "CRM-SP 000.789 (fictício)", true],
  ["s06", "Renata Gouveia", "Fisioterapeuta", "Fisioterapia", "fisioterapia", ["fisioterapia"], "renata.gouveia@lardoirmaovelho.example", "CREFITO-3 000.321 (fictício)", true],
  ["s07", "Dra. Luciana Prado", "Cirurgiã-dentista", "Odontologia", "odontologia", ["odontologia"], "luciana.prado@lardoirmaovelho.example", "CRO-SP 000.654 (fictício)", true],
  ["s08", "Tiago Menezes", "Farmacêutico", "Farmácia", "farmacia", ["farmacia"], "tiago.menezes@lardoirmaovelho.example", "CRF-SP 000.987 (fictício)", true],
  ["s09", "Aline Barros", "Recepcionista", "Recepção", "recepcao", ["recepcao"], "aline.barros@lardoirmaovelho.example", null, true],
  ["s10", "Sérgio Camargo", "Responsável pelo almoxarifado", "Estoque", "estoque", ["estoque"], "sergio.camargo@lardoirmaovelho.example", null, true],
  ["s11", "Helena Duarte", "Voluntária", "Voluntariado", "voluntario", ["voluntario"], "helena.duarte@lardoirmaovelho.example", null, true],
  ["s12", "Marcos Vinícius Teles", "Enfermeiro", "Enfermagem", "enfermagem", ["enfermagem"], "marcos.teles@lardoirmaovelho.example", "COREN-SP 000.234 (fictício)", false],
  ["s13", "Patrícia Souza Lacerda", "Técnica de enfermagem", "Enfermagem", "tecnico", ["tecnico"], "patricia.lacerda@lardoirmaovelho.example", "COREN-SP 000.567 (fictício)", false],
  ["s14", "Rosângela Pires", "Técnica de enfermagem", "Enfermagem", "tecnico", ["tecnico"], "rosangela.pires@lardoirmaovelho.example", "COREN-SP 000.678 (fictício)", false],
  ["s15", "Eliane Santos", "Cuidadora de idosos", "Cuidados diários", "tecnico", ["tecnico"], "eliane.santos@lardoirmaovelho.example", null, false],
  ["s16", "Dra. Beatriz Camargo", "Psicóloga", "Psicologia", "medico", ["medico"], "beatriz.camargo@lardoirmaovelho.example", "CRP-06 000.111 (fictício)", false],
  ["s17", "Fernanda Lopes", "Nutricionista", "Nutrição", "medico", ["medico"], "fernanda.lopes@lardoirmaovelho.example", "CRN-3 000.222 (fictício)", false],
];

const MODULES = [
  ["idosos", "Cadastro de idosos", "E02", "Grupo 1 · Plataforma e Core", "Cadastro, localização e dados cadastrais dos moradores.", "outros"],
  ["farmacia", "Farmácia e medicação", "E04", "Grupo 3 · Farmácia e Medicação", "Controle de medicamentos, prescrições e administração.", "g2"],
  ["estoque", "Estoque e almoxarifado", "E05", "Grupo 4 · Estoque e Insumos", "Entradas, saídas e inventário de insumos.", "g2"],
  ["temperatura", "Temperatura", "E06", "Grupo 4 · Estoque e Insumos", "Monitoramento de temperatura de geladeiras e ambientes.", "g2"],
  ["agenda", "Agenda", "E07", "Grupo 5 · Agenda e Atendimentos", "Agenda de cuidados, consultas e atendimentos.", "outros"],
  ["fisioterapia", "Fisioterapia", "E08", "Grupo 5 · Agenda e Atendimentos", "Atendimentos e acompanhamento de fisioterapia.", "outros"],
  ["medicina", "Medicina e odontologia", "E09", "Grupo 5 · Agenda e Atendimentos", "Atendimento médico e odontológico.", "outros"],
  ["funcionarios", "Funcionários e voluntários", "E10", "Grupo 6 · Pessoas, Eventos e Visitas", "Equipe, voluntários, tarefas e eventos.", "outros"],
  ["visitas", "Visitas", "E11", "Grupo 6 · Pessoas, Eventos e Visitas", "Controle de visitas de familiares e convidados.", "outros"],
  ["emergencias", "Emergências", "E12", "Grupo 7 · Emergência e Notificações", "Chamadas de emergência e comunicação.", "outros"],
  ["dashboard", "Dashboard e indicadores", "E13", "Grupo 8 · Dados, Relatórios e Insights", "Indicadores administrativos da instituição.", "outros"],
  ["relatorios", "Relatórios", "E13", "Grupo 8 · Dados, Relatórios e Insights", "Relatórios gerenciais e exportações.", "outros"],
  ["migracao", "Migração de dados", "E15", "Grupo 9 · Dados, Integrações e Operação", "Migração de prontuários e dados históricos.", "g2"],
];

function atDays(days, hours, minutes = 0) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function isoDay(daysFromToday) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function day(offset) {
  return new Date(`${isoDay(offset)}T00:00:00.000Z`);
}

function assertCatalog() {
  for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
    if (granted === "all") continue;
    for (const code of granted) {
      if (!ALL_PERMISSIONS.includes(code)) {
        throw new Error(`Permissão ${code} do perfil ${role} está fora do catálogo.`);
      }
    }
  }
}

async function insertMany(tx, model, rows) {
  if (!rows.length) return;
  await tx[model].createMany({ data: rows });
}

export async function seed() {
  assertCatalog();
  const names = await loadNames();
  const patients = buildPatients(names);
  const passwordHash = await bcrypt.hash(config.demoPassword, config.bcryptRounds);

  const roles = Object.entries(ROLE_LABELS).map(([id, label]) => ({ id, label, description: ROLE_DESCRIPTIONS[id] }));
  const permissions = PERMISSION_CATALOG.map(([group_name, code, label]) => ({ code, label, group_name }));
  const rolePermissions = [];
  for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
    const codes = granted === "all" ? ALL_PERMISSIONS : granted;
    for (const code of codes) rolePermissions.push({ role_id: role, permission_code: code });
  }
  const users = USERS.map(([id, name, role_label, sector, , , email, council, demo]) => ({
    id, name, email, password_hash: passwordHash, role_label, sector, council, demo,
  }));
  const profiles = USERS.flatMap(([id, , , , , list]) => list.map((profile) => ({ user_id: id, profile })));
  const modules = MODULES.map(([id, label, epic, group_name, description, scope]) => ({
    id, label, epic, group_name, description, scope,
  }));

  const tags = [];
  const alerts = [];
  const contacts = [];
  const careFields = [];
  const evolutions = [];
  const vitals = [];
  const occurrences = [];
  const history = [];
  const plans = [];
  const planActions = [];

  for (const patient of patients) {
    for (const tag of patient.tags) tags.push({ patient_id: patient.id, tag });
    for (const alert of patient.alerts) {
      alerts.push({ id: alert.id, patient_id: patient.id, label: alert.label, kind: alert.kind, detail: alert.detail });
    }
    for (const contact of patient.contacts) {
      contacts.push({
        patient_id: patient.id,
        name: contact.name,
        relation: contact.relation,
        phone: contact.phone,
        is_primary: contact.isPrimary,
      });
    }
    for (const field of patient.careFields) {
      careFields.push({
        patient_id: patient.id,
        section_id: field.sectionId,
        section_title: field.sectionTitle,
        label: field.label,
        value: field.value,
        sort_order: field.sortOrder,
      });
    }

    const quiet = patient.tags.includes("sem_registro_recente");
    const author = ["s03", "s04", "s12", "s13"][patient.index % 4];
    const shifts = quiet ? [12, 20] : [1, 4];
    for (const [offset, shiftDay] of shifts.entries()) {
      const draft = !quiet && patient.index % 11 === 2 && offset === 0;
      const when = atDays(shiftDay, offset === 0 ? 8 : 20, 10);
      evolutions.push({
        id: `ev-${patient.id}-${offset + 1}`,
        patient_id: patient.id,
        at: when,
        author_id: author,
        type: "rotina",
        title: draft ? "Evolução do plantão da manhã (rascunho)" : `Evolução do plantão ${offset === 0 ? "da manhã" : "da noite"}`,
        description: `${patient.treatment} aceitou as refeições e permaneceu acompanhado(a) pela equipe. Sem queixas novas no período.`,
        notes: offset === 0 ? "Equipe seguinte orientada a manter o acompanhamento." : null,
        alimentacao: "Aceitou bem",
        hidratacao: "Estimulada, aceitou",
        sono: "Tranquilo",
        humor: "Calmo(a)",
        mobilidade: "Deambulou com apoio",
        pele: "Sem alterações observadas",
        status: draft ? "rascunho" : "finalizado",
        closed_at: draft ? null : when,
      });
    }

    if (patient.tags.includes("hipertensao")) {
      vitals.push({
        id: `vt-${patient.id}-pa`,
        patient_id: patient.id,
        kind: "pa",
        at: atDays(1, 8, 15),
        systolic: 128 + (patient.index % 8),
        diastolic: 78,
        pulse: 72,
        context: "Rotina da manhã, em repouso",
        author_id: "s04",
      });
    }
    if (patient.tags.includes("diabetes")) {
      vitals.push({
        id: `vt-${patient.id}-gl`,
        patient_id: patient.id,
        kind: "glicemia",
        at: atDays(0, 7, 5),
        glucose: 110 + (patient.index % 15),
        context: "Jejum",
        author_id: "s04",
      });
    }

    if (patient.index % 7 === 0) {
      const occurrenceId = `oc-${patient.id}`;
      const when = atDays(patient.index === 0 ? 1 : 6, 9, 20);
      occurrences.push({
        id: occurrenceId,
        patient_id: patient.id,
        category: "Queda",
        title: "Queda sem lesão aparente",
        description: `${patient.treatment} foi encontrado(a) sentado(a) no chão ao lado da cama durante a ronda. Consciente, sem queixa de dor no momento.`,
        at: when,
        author_id: author,
        responsible_id: "s03",
        status: patient.index % 14 === 0 ? "aberta" : "acompanhamento",
        priority: patient.index % 8 === 0 ? "atencao" : "normal",
      });
      history.push({
        occurrence_id: occurrenceId,
        at: when,
        by_id: author,
        action: "abertura",
        text: "Ocorrência registrada pela equipe.",
      });
    }

    if (patient.index % 4 !== 0) {
      const planId = `cp-${patient.id}`;
      plans.push({
        id: planId,
        patient_id: patient.id,
        title: "Rotina de hidratação ao longo do dia",
        area: "Enfermagem",
        objective: "Manter oferta de líquidos em horários combinados, com registro na evolução.",
        responsible_id: "s03",
        start_date: day(-30),
        end_date: day(60),
        status: "ativo",
      });
      planActions.push({
        plan_id: planId,
        title: "Oferecer água ou chá a cada 2 horas",
        responsible_id: "s03",
        frequency: "Diária",
        done: false,
      });
    }
  }

  const handSections = [
    { title: "Objetivo", items: ["Reduzir a transmissão de microrganismos com a técnica correta."] },
    { title: "Passo a passo", items: ["Molhar as mãos", "Aplicar sabão", "Friccionar por 40 a 60 segundos", "Enxaguar e secar"] },
  ];
  const popRows = [
    ["pop1", "POP-ENF-001", "Higienização das mãos", "Enfermagem", "s03", -200, 180, "Reduzir a transmissão de microrganismos com a técnica correta nos momentos certos.", handSections],
    ["pop2", "POP-ENF-002", "Aferição e registro de pressão arterial", "Enfermagem", "s03", -120, 40, "Padronizar a medida da pressão arterial e o registro no SISLAR.", [{ title: "Passo a passo", items: ["Repouso de 5 minutos", "Braço na altura do coração", "Registrar sistólica, diastólica, pulso e contexto"] }]],
    ["pop3", "POP-ENF-003", "Verificação e registro de glicemia capilar", "Enfermagem", "s12", -90, 20, "Padronizar a verificação da glicemia capilar e o registro no prontuário.", [{ title: "Passo a passo", items: ["Conferir validade da tira", "Higienizar o dedo", "Registrar valor e contexto"] }]],
    ["pop4", "POP-ENF-004", "Rotina de segurança e prevenção de quedas", "Segurança do morador", "s03", -300, 15, "Manter rotinas de segurança que reduzam o risco de quedas.", [{ title: "Passo a passo", items: ["Manter o quarto livre de obstáculos", "Conferir dispositivo de apoio", "Acionar a equipe ao levantar"] }]],
    ["pop5", "POP-ENF-005", "Registro de evolução de enfermagem", "Enfermagem", "s03", -400, -2, "Padronizar o registro de evoluções no prontuário digital.", [{ title: "Registro", items: ["Descrever fatos observados", "Finalizar ao fim do plantão", "Corrigir com motivo, sem apagar o texto original"] }]],
    ["pop6", "POP-NUT-001", "Oferta de dieta conforme prescrição nutricional", "Nutrição", "s17", -60, 3, "Garantir a oferta da dieta vigente e o registro da aceitação.", [{ title: "Passo a passo", items: ["Conferir dieta do dia", "Oferecer conforme textura", "Registrar recusa na evolução"] }]],
  ];

  await prisma.$transaction(async (tx) => {
    await insertMany(tx, "roles", roles);
    await insertMany(tx, "permissions", permissions);
    await insertMany(tx, "role_permissions", rolePermissions);
    await insertMany(tx, "users", users);
    await insertMany(tx, "user_profiles", profiles);
    await insertMany(tx, "modules", modules);
    await insertMany(tx, "patients", patients.map((patient) => ({
      id: patient.id,
      code: patient.code,
      name: patient.name,
      treatment: patient.treatment,
      sex: patient.sex,
      birth_date: new Date(`${patient.birthDate}T00:00:00.000Z`),
      admission_date: new Date(`${patient.admissionDate}T00:00:00.000Z`),
      wing: patient.wing,
      room: patient.room,
      bed: patient.bed,
      status: patient.status,
    })));
    await insertMany(tx, "patient_tags", tags);
    await insertMany(tx, "patient_alerts", alerts);
    await insertMany(tx, "patient_contacts", contacts);
    await insertMany(tx, "patient_care_fields", careFields);
    await insertMany(tx, "evolutions", evolutions);
    await insertMany(tx, "vitals", vitals);
    await insertMany(tx, "occurrences", occurrences);
    await insertMany(tx, "occurrence_history", history);
    await insertMany(tx, "care_plans", plans);
    await insertMany(tx, "care_plan_actions", planActions);

    await insertMany(tx, "pops", popRows.map(([id, code, title, category, responsible_id, from, until, purpose, sections]) => ({
      id, code, title, category, version: 1, responsible_id, valid_from: day(from), valid_until: day(until), status: "vigente", purpose, sections, related: [{ kind: "modulo", label: category }],
    })));
    await insertMany(tx, "pop_versions", popRows.map(([id, , , , responsible_id, , until, , sections]) => ({
      pop_id: id, version: 1, by_id: responsible_id, summary: "Versão inicial.", valid_until: day(until), sections,
    })));

    await tx.pae_templates.create({
      data: {
        id: "pt1",
        name: "Segurança na mobilidade",
        description: "Organiza ações da equipe para apoiar a locomoção com segurança dentro da instituição.",
        version: 3,
        status: "vigente",
        pae_template_responsibles: { create: [{ user_id: "s03" }, { user_id: "s06" }] },
        pae_template_fields: {
          create: [
            ["f1", "Dispositivo de apoio utilizado", "selecao", true, ["Nenhum", "Bengala", "Andador", "Cadeira de rodas"]],
            ["f2", "Locais de maior circulação", "texto", false, []],
            ["f3", "Precisa de acompanhante para caminhar?", "sim_nao", true, []],
            ["f4", "Observações da equipe", "texto_longo", false, []],
          ].map(([id, label, field_type, required, options], sort_order) => ({ id, label, field_type, required, options, sort_order })),
        },
        pae_template_actions: {
          create: [
            { id: "a1", title: "Conferir se o ambiente do quarto está livre de obstáculos", role_label: "Enfermagem", sort_order: 0 },
            { id: "a2", title: "Caminhada assistida no corredor", role_label: "Fisioterapia", sort_order: 1 },
          ],
        },
      },
    });
    await tx.paes.create({
      data: {
        id: "pae-p02",
        patient_id: "p02",
        template_id: "pt1",
        status: "vigente",
        start_date: day(-20),
        review_date: day(1),
        responsible_id: "s03",
        created_by: "s03",
        version: 1,
        pae_values: {
          create: [
            { field_id: "f1", value: "Andador" },
            { field_id: "f2", value: "Quarto e corredor da ala" },
            { field_id: "f3", value: "sim" },
            { field_id: "f4", value: "Acompanhar na ida ao refeitório." },
          ],
        },
        pae_actions: {
          create: [
            { id: "paa1", template_action_id: "a1", title: "Conferir se o ambiente do quarto está livre de obstáculos", responsible_id: "s03", due_date: day(1), status: "pendente" },
            { id: "paa2", template_action_id: "a2", title: "Caminhada assistida no corredor", responsible_id: "s06", due_date: day(1), status: "pendente" },
          ],
        },
      },
    });

    const meds = [
      ["m01", "Losartana potássica", "Losartana", "Comprimido", "50 mg", "comprimido", 400, false],
      ["m02", "Metformina", "Cloridrato de metformina", "Comprimido", "850 mg", "comprimido", 500, false],
      ["m03", "Sinvastatina", "Sinvastatina", "Comprimido", "20 mg", "comprimido", 300, false],
      ["m04", "Ácido acetilsalicílico", "AAS", "Comprimido", "100 mg", "comprimido", 300, false],
      ["m05", "Omeprazol", "Omeprazol", "Cápsula", "20 mg", "cápsula", 300, false],
      ["m06", "Levotiroxina sódica", "Levotiroxina", "Comprimido", "50 mcg", "comprimido", 200, false],
      ["m07", "Insulina humana NPH", "Insulina NPH", "Frasco-ampola 10 mL", "100 UI/mL", "frasco", 10, true],
      ["m08", "Dipirona sódica", "Dipirona", "Solução oral", "500 mg/mL", "frasco", 10, false],
    ];
    await insertMany(tx, "medications", meds.map(([id, name, active_ingredient, form, strength, unit, min_qty, cold_chain]) => ({
      id, name, active_ingredient, form, strength, kind: "medicamento", unit, min_qty, location: "Farmácia", cold_chain,
    })));
    const lots = [
      ["m01a", "m01", "LP2411", 200, 620],
      ["m01b", "m01", "LP2503", 380, 900],
      ["m02a", "m02", "MF2408", 40, 180],
      ["m02b", "m02", "MF2502", 300, 240],
      ["m04a", "m04", "AS2410", -12, 150],
      ["m07a", "m07", "IN2412", 55, 6],
      ["m08a", "m08", "DP2505", 360, 24],
    ];
    await insertMany(tx, "medication_lots", lots.map(([id, medication_id, code, expiry, qty]) => ({
      id, medication_id, code, expiry: day(expiry), qty, supplier: "Distribuidora Vale Verde", received_at: day(-40),
    })));
    await tx.prescriptions.create({
      data: {
        id: "rx01",
        patient_id: "p02",
        medication_id: "m01",
        dose: "50 mg",
        route: "oral",
        frequency: "1 vez ao dia pela manhã",
        instructions: "Administrar após o café.",
        start_date: day(-15),
        status: "vigente",
        prescriber_id: "s05",
      },
    });

    const items = [
      ["st01", "Fralda geriátrica G", "Higiene", "pacote", 20, 48, "Almoxarifado"],
      ["st02", "Luva de procedimento M", "EPI", "caixa", 15, 8, "Almoxarifado"],
      ["st03", "Álcool 70%", "Higiene", "litro", 10, 18, "Enfermagem"],
      ["st04", "Gaze estéril", "Curativo", "pacote", 12, 30, "Enfermagem"],
    ];
    await insertMany(tx, "stock_items", items.map(([id, name, category, unit, min_qty, qty, location]) => ({
      id, name, category, unit, min_qty, qty, location,
    })));
    await insertMany(tx, "stock_movements", items.map(([id, , , , , qty]) => ({
      item_id: id, type: "entrada", qty, balance_after: qty, reason: "Saldo inicial", author_id: "s10",
    })));
    await tx.replenishments.create({
      data: { id: "rp01", item_id: "st02", qty: 20, status: "solicitada", requester_id: "s03", notes: "Estoque abaixo do mínimo." },
    });

    await insertMany(tx, "equipment", [
      { id: "eq01", name: "Geladeira da farmácia", location: "Farmácia", kind: "geladeira", min_temp: 2, max_temp: 8 },
      { id: "eq02", name: "Geladeira da copa", location: "Copa", kind: "geladeira", min_temp: 1, max_temp: 5 },
      { id: "eq03", name: "Enfermaria Ipê", location: "Ala Ipê", kind: "ambiente", min_temp: 20, max_temp: 26 },
    ]);
    await insertMany(tx, "sensors", [
      { id: "sn01", equipment_id: "eq01", code: "SNS-FARM-01" },
      { id: "sn02", equipment_id: "eq02", code: "SNS-COPA-01" },
      { id: "sn03", equipment_id: "eq03", code: "SNS-IPE-01" },
    ]);
    await insertMany(tx, "temperature_readings", [
      { id: "tr01", equipment_id: "eq01", sensor_id: "sn01", value: 5.2, at: atDays(0, 7, 0), author_id: "s08" },
      { id: "tr02", equipment_id: "eq02", sensor_id: "sn02", value: 9.4, at: atDays(0, 8, 30), author_id: "s10" },
    ]);
    await tx.temperature_alerts.create({
      data: {
        id: "ta01",
        equipment_id: "eq02",
        reading_id: "tr02",
        kind: "acima",
        message: "Geladeira da copa acima do limite (9.4°C).",
        status: "aberto",
        at: atDays(0, 8, 30),
      },
    });
    await insertMany(tx, "notifications", [
      { id: "n1", kind: "evolucao", title: "Evolução pendente", body: "Há rascunhos de evolução sem finalização.", read: false, link: "/prontuarios", at: atDays(0, 10, 5) },
      { id: "n2", kind: "pae", title: "Ação de PAE vence amanhã", body: "Segurança na mobilidade · Seu Antônio. Responsável: Carla Beatriz Nunes.", read: false, link: "/prontuarios/p02/pae", at: atDays(0, 9, 20) },
      { id: "n3", kind: "pop", title: "POP próximo do vencimento", body: "POP-NUT-001 vence em poucos dias.", read: false, link: "/pop/pop6", at: atDays(1, 9, 0) },
    ]);
    await tx.agenda_events.create({
      data: {
        id: "ag01",
        title: "Caminhada assistida",
        patient_id: "p02",
        professional_id: "s06",
        starts_at: atDays(-1, 15, 0),
        ends_at: atDays(-1, 15, 40),
        kind: "fisioterapia",
        status: "agendado",
      },
    });
    await tx.visits.create({
      data: { id: "vs01", patient_id: "p01", visitor_name: "Renato Ferreira", relation: "Filho", arrived_at: atDays(1, 14, 10), registered_by: "s09" },
    });
    await tx.emergencies.create({
      data: {
        id: "em01",
        patient_id: "p10",
        kind: "mal_estar",
        description: "Mal-estar referido no refeitório. Equipe acionada.",
        status: "aberta",
        opened_by: "s09",
        opened_at: atDays(0, 11, 40),
      },
    });
    await tx.appointments.create({
      data: {
        id: "at01",
        patient_id: "p02",
        specialty: "fisioterapia",
        professional_id: "s06",
        at: atDays(2, 15, 0),
        summary: "Caminhada assistida com andador, sem dor referida.",
        status: "finalizado",
      },
    });
  }, { timeout: 120_000, maxWait: 20_000 });
}

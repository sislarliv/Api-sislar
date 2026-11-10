// Dados de demonstração do Grupo 3 (agenda única, tipos de atendimento e equipe mínima).
import { gerarLembretes } from "../grupo3/lembretes.js";

const TIPOS = [
  // [nome, categoria, duração, exige motivo cancelar, exige motivo reagendar, permite sobreposição]
  ["Consulta médica", "consulta_medica", 30, true, true, false],
  ["Consulta odontológica", "consulta_odontologica", 40, true, true, false],
  ["Sessão de fisioterapia", "fisioterapia", 40, true, false, false],
  ["Fisioterapia em grupo", "fisioterapia", 60, true, false, true],
  ["Corte de cabelo", "cuidado_pessoal", 30, false, false, false],
  ["Barba", "cuidado_pessoal", 20, false, false, false],
  ["Unhas", "cuidado_pessoal", 30, false, false, false],
  ["Atendimento da farmácia", "farmacia", 15, true, false, false],
  ["Avaliação multiprofissional", "avaliacao", 60, true, true, false],
];

const ESPECIALIDADES = ["Clínica médica", "Odontologia", "Fisioterapia", "Farmácia", "Enfermagem"];

const COLABORADORES = [
  // [chave, nome, vínculo, usuário, cargo, setor, especialidade, registro, e-mail, telefone] — dados fictícios
  ["medico", "Dr. Paulo Ferraz Neto", "funcionario", "s05", "Médico geriatra", "Atendimento médico", "Clínica médica", "CRM-SP 000.789 (fictício)", "paulo.ferraz@lardoirmaovelho.example", "(11) 90000-0005"],
  ["fisio", "Renata Gouveia", "funcionario", "s06", "Fisioterapeuta", "Fisioterapia", "Fisioterapia", "CREFITO-3 000.321 (fictício)", "renata.gouveia@lardoirmaovelho.example", "(11) 90000-0006"],
  ["dentista", "Dra. Luciana Prado", "voluntario", "s07", "Cirurgiã-dentista voluntária", "Odontologia", "Odontologia", "CRO-SP 000.654 (fictício)", "luciana.prado@lardoirmaovelho.example", "(11) 90000-0007"],
  ["farmacia", "Tiago Menezes", "funcionario", "s08", "Farmacêutico", "Farmácia", "Farmácia", "CRF-SP 000.987 (fictício)", null, "(11) 90000-0008"],
  ["enfermeira", "Carla Beatriz Nunes", "funcionario", "s03", "Enfermeira responsável técnica", "Enfermagem", "Enfermagem", "COREN-SP 000.123 (fictício)", null, "(11) 90000-0003"],
  ["voluntaria", "Helena Duarte", "voluntario", "s11", "Voluntária de cuidados pessoais", "Voluntariado", null, null, null, "(11) 90000-0011"],
  ["cabeleireiro", "Jorge Matias (cabeleireiro)", "externo", null, "Cabeleireiro", "Cuidados pessoais", null, null, null, "(11) 90000-0099"],
  ["medico_voluntario", "Dra. Sônia Campos", "voluntario", null, "Médica clínica voluntária", "Atendimento médico", "Clínica médica", "CRM-SP 000.111 (fictício)", null, null],
];

function emDiaLocal(dias) {
  const date = new Date();
  date.setDate(date.getDate() + dias);
  const mes = String(date.getMonth() + 1).padStart(2, "0");
  const dia = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mes}-${dia}`;
}

function emDias(dias, horas, minutos = 0) {
  const date = new Date();
  date.setDate(date.getDate() + dias);
  date.setHours(horas, minutos, 0, 0);
  return date;
}

async function refDe(tx, tabela, id) {
  const rows = tabela === "users"
    ? await tx.$queryRaw`SELECT ref FROM public.users WHERE id = ${id}`
    : await tx.$queryRaw`SELECT ref FROM public.patients WHERE id = ${id}`;
  if (!rows[0]) throw new Error(`Sem UUID de ${tabela} ${id}.`);
  return rows[0].ref;
}

export async function seedGrupo3(tx) {
  const tipos = {};
  for (const [nome, categoria, duracao, motivoCancelar, motivoReagendar, sobreposicao] of TIPOS) {
    const rows = await tx.$queryRaw`
      INSERT INTO grupo3.tipo_atendimento (
        nome, categoria, duracao_padrao_min, exige_motivo_cancelamento, exige_motivo_reagendamento, permite_sobreposicao
      ) VALUES (${nome}, ${categoria}::grupo3.categoria_atendimento, ${duracao}, ${motivoCancelar}, ${motivoReagendar}, ${sobreposicao})
      RETURNING id
    `;
    tipos[nome] = { id: rows[0].id, duracao };
  }

  const especialidades = {};
  for (const nome of ESPECIALIDADES) {
    const rows = await tx.$queryRaw`INSERT INTO grupo3.especialidade (nome) VALUES (${nome}) RETURNING id`;
    especialidades[nome] = rows[0].id;
  }

  const colaboradores = {};
  for (const [chave, nome, vinculo, usuario, cargo, setor, especialidade, registro, email, telefone] of COLABORADORES) {
    const ref = usuario ? await refDe(tx, "users", usuario) : null;
    const especialidadeId = especialidade ? especialidades[especialidade] : null;
    const rows = await tx.$queryRaw`
      INSERT INTO grupo3.colaborador (nome, vinculo, usuario_ref, cargo, setor, especialidade_id, registro_profissional, email, telefone)
      VALUES (${nome}, ${vinculo}::grupo3.vinculo_colaborador, ${ref}::uuid, ${cargo}, ${setor}, ${especialidadeId}::uuid,
              ${registro}, ${email}, ${telefone})
      RETURNING id
    `;
    colaboradores[chave] = rows[0].id;
  }

  const autor = await refDe(tx, "users", "s01");

  // Plano de fisioterapia de p02 (Fatia 5): as sessões de fisioterapia individuais de p02 ficam ligadas a ele.
  const fisioRef = await refDe(tx, "users", "s06");
  const plano = (await tx.$queryRaw`
    INSERT INTO grupo3.plano_fisioterapia (idoso_ref, responsavel_id, objetivo, data_inicio, data_fim, frequencia_semanal, criado_por_ref)
    VALUES (${await refDe(tx, "patients", "p02")}::uuid, ${colaboradores.fisio}::uuid,
            'Melhorar a marcha e reduzir o risco de quedas.', ${emDiaLocal(-30)}::date, ${emDiaLocal(60)}::date, 2, ${fisioRef}::uuid)
    RETURNING id
  `)[0].id;
  const atividades = {};
  for (const [chave, descricao, duracao, intensidade] of [
    ["marcha", "Treino de marcha com andador", 15, "Leve"],
    ["equilibrio", "Exercícios de equilíbrio estático", 10, "Leve"],
  ]) {
    atividades[chave] = (await tx.$queryRaw`
      INSERT INTO grupo3.atividade_fisioterapia (plano_id, descricao, frequencia_semanal, duracao_min, intensidade, configuracao)
      VALUES (${plano}::uuid, ${descricao}, 2, ${duracao}, ${intensidade}, ${JSON.stringify({ apoio: "andador" })}::jsonb)
      RETURNING id
    `)[0].id;
  }

  const agendamentos = [
    // [idoso, tipo, colaborador, quando, status, observações]
    ["p02", "Sessão de fisioterapia", "fisio", emDias(-2, 15), "realizado", "Treino de marcha com andador."],
    ["p02", "Sessão de fisioterapia", "fisio", emDias(1, 15), "agendado", "Treino de marcha com andador."],
    ["p05", "Fisioterapia em grupo", "fisio", emDias(1, 9), "agendado", null],
    ["p07", "Fisioterapia em grupo", "fisio", emDias(1, 9), "agendado", null],
    ["p01", "Consulta médica", "medico", emDias(2, 10), "agendado", "Revisão de pressão arterial."],
    ["p03", "Consulta odontológica", "dentista", emDias(3, 14), "agendado", "Avaliação de prótese."],
    ["p03", "Consulta odontológica", "dentista", emDias(-20, 14), "realizado", "Revisão semestral."],
    ["p04", "Corte de cabelo", "cabeleireiro", emDias(1, 10), "agendado", null],
    ["p06", "Unhas", "voluntaria", emDias(1, 14), "agendado", null],
    ["p08", "Atendimento da farmácia", "farmacia", emDias(0, 16), "agendado", null],
  ];
  const criados = [];
  for (const [idoso, tipo, colaborador, inicio, status, observacoes] of agendamentos) {
    const idosoRef = await refDe(tx, "patients", idoso);
    const encerrado = status !== "agendado";
    const local = tipo.startsWith("Consulta") ? (tipo.includes("odonto") ? "Consultório odontológico" : "Consultório 1") : null;
    const planoId = idoso === "p02" && tipo === "Sessão de fisioterapia" ? plano : null;
    const rows = await tx.$queryRaw`
      INSERT INTO grupo3.agendamento (
        idoso_ref, tipo_id, profissional_id, inicio, duracao_min, local, observacoes, plano_fisioterapia_id, status,
        responsavel_realizacao_id, concluido_em, registrado_por_ref, criado_por_ref
      ) VALUES (
        ${idosoRef}::uuid, ${tipos[tipo].id}::uuid, ${colaboradores[colaborador]}::uuid, ${inicio}, ${tipos[tipo].duracao},
        ${local}, ${observacoes}, ${planoId}::uuid, ${status}::grupo3.status_agendamento,
        ${encerrado ? colaboradores[colaborador] : null}::uuid, ${encerrado ? inicio : null},
        ${encerrado ? autor : null}::uuid, ${autor}::uuid
      ) RETURNING id
    `;
    await tx.$executeRaw`
      INSERT INTO grupo3.historico_agendamento (agendamento_id, acao, novo, autor_ref)
      VALUES (${rows[0].id}::uuid, 'criado', ${JSON.stringify({ status: "agendado" })}::jsonb, ${autor}::uuid)
    `;
    if (!encerrado) await gerarLembretes(tx, rows[0].id);
    criados.push({ idoso, idosoRef, tipo, colaborador, inicio, status, id: rows[0].id });
  }

  // Execução e evolução da sessão realizada de p02. A fisioterapeuta não tem evolucao.create: a evolução
  // fica aguardando permissão para ir ao prontuário.
  const sessaoFeita = criados.find((a) => a.idoso === "p02" && a.status === "realizado");
  for (const [chave, statusExecucao] of [["marcha", "realizada"], ["equilibrio", "parcial"]]) {
    await tx.$executeRaw`
      INSERT INTO grupo3.execucao_atividade (agendamento_id, atividade_id, profissional_id, status, registrado_por_ref)
      VALUES (${sessaoFeita.id}::uuid, ${atividades[chave]}::uuid, ${colaboradores.fisio}::uuid,
              ${statusExecucao}::grupo3.status_execucao_atividade, ${fisioRef}::uuid)
    `;
  }
  await tx.$executeRaw`
    INSERT INTO grupo3.evolucao_fisioterapia (plano_id, agendamento_id, texto, registrado_em, autor_ref, publicacao_status)
    VALUES (${plano}::uuid, ${sessaoFeita.id}::uuid, 'Caminhou 20 m com andador sem dor; equilíbrio ainda instável.',
            ${sessaoFeita.inicio}, ${fisioRef}::uuid, 'aguardando_permissao')
  `;

  // Tarefas (Fatia 6): uma atrasada, uma aberta e uma concluída.
  const gestorRef = await refDe(tx, "users", "s02");
  for (const [titulo, chave, prazo, prioridade, statusTarefa] of [
    ["Revisar escala de fisioterapia da semana", "fisio", emDias(-1, 18), "alta", "pendente"],
    ["Conferir estoque de luvas do posto", "enfermeira", emDias(2, 12), "media", "em_andamento"],
    ["Atualizar contatos dos voluntários", "voluntaria", emDias(-3, 12), "baixa", "concluida"],
  ]) {
    const tarefa = (await tx.$queryRaw`
      INSERT INTO grupo3.tarefa (titulo, responsavel_id, prazo, prioridade, status, concluida_em, criado_por_ref)
      VALUES (${titulo}, ${colaboradores[chave]}::uuid, ${prazo}, ${prioridade}::grupo3.prioridade_tarefa,
              ${statusTarefa}::grupo3.status_tarefa, ${statusTarefa === "concluida" ? emDias(-4, 10) : null}, ${gestorRef}::uuid)
      RETURNING id
    `)[0].id;
    await tx.$executeRaw`
      INSERT INTO grupo3.historico_tarefa (tarefa_id, evento, status_anterior, status_novo, observacao, autor_ref)
      VALUES (${tarefa}::uuid, 'criada', NULL, 'pendente', 'Tarefa criada.', ${gestorRef}::uuid)
    `;
    if (statusTarefa !== "pendente") {
      await tx.$executeRaw`
        INSERT INTO grupo3.historico_tarefa (tarefa_id, status_anterior, status_novo, autor_ref)
        VALUES (${tarefa}::uuid, 'pendente', ${statusTarefa}::grupo3.status_tarefa, ${gestorRef}::uuid)
      `;
    }
  }

  // Atendimento odontológico (Fatia 4): acompanhamento, registro finalizado publicado no prontuário e
  // um tratamento externo.
  const dentistaRef = await refDe(tx, "users", "s07");
  const p03 = criados.find((a) => a.idoso === "p03" && a.status === "realizado");
  const acompanhamento = await tx.$queryRaw`
    INSERT INTO grupo3.acompanhamento_odontologico (idoso_ref, responsavel_id, plano, periodicidade_dias, situacao, criado_por_ref)
    VALUES (${p03.idosoRef}::uuid, ${colaboradores.dentista}::uuid, 'Revisão de prótese e higiene oral a cada seis meses.', 180,
            'em_acompanhamento', ${dentistaRef}::uuid)
    RETURNING id
  `;
  const registro = await tx.$queryRaw`
    INSERT INTO grupo3.registro_clinico (agendamento_id, acompanhamento_id, idoso_ref, area, profissional_id, tipo, realizado_em, resumo, autor_ref)
    VALUES (${p03.id}::uuid, ${acompanhamento[0].id}::uuid, ${p03.idosoRef}::uuid, 'odontologica', ${colaboradores.dentista}::uuid,
            'Consulta odontológica', ${p03.inicio}, 'Prótese bem adaptada, sem lesões em mucosa. Reforçada a higiene noturna.', ${dentistaRef}::uuid)
    RETURNING id
  `;
  // A dentista não tem evolucao.create: o registro fica finalizado no G3, aguardando permissão para publicar.
  await tx.$executeRaw`
    UPDATE grupo3.registro_clinico
    SET status = 'finalizado', finalizado_em = ${p03.inicio}, finalizado_por_ref = ${dentistaRef}::uuid,
        publicacao_status = 'aguardando_permissao'
    WHERE id = ${registro[0].id}::uuid
  `;
  await tx.$executeRaw`
    INSERT INTO grupo3.tratamento_externo (idoso_ref, area, tipo, local_externo, data, instituicao, observacoes, criado_por_ref)
    VALUES (${await refDe(tx, "patients", "p05")}::uuid, 'odontologica', 'Extração dentária', 'Centro de Especialidades Odontológicas',
            ${emDiaLocal(-30)}::date, 'CEO Municipal (fictício)', 'Sem intercorrências.', ${autor}::uuid)
  `;

  // Disponibilidade declarada (dia ISO: 1 = segunda).
  const disponibilidades = [
    ["medico", 1, "08:00", "12:00"], ["medico", 3, "08:00", "12:00"], ["medico", 5, "08:00", "12:00"],
    ["medico_voluntario", 2, "08:00", "12:00"],
    ["dentista", 2, "13:00", "17:00"], ["dentista", 4, "13:00", "17:00"],
    ["voluntaria", 1, "14:00", "17:00"], ["voluntaria", 4, "14:00", "17:00"],
  ];
  for (const [chave, diaSemana, inicio, fim] of disponibilidades) {
    await tx.$executeRaw`
      INSERT INTO grupo3.disponibilidade_colaborador (colaborador_id, dia_semana, hora_inicio, hora_fim)
      VALUES (${colaboradores[chave]}::uuid, ${diaSemana}, ${inicio}::time, ${fim}::time)
    `;
  }

  // Necessidade mínima: clínico de segunda a sexta de manhã; odontologia terça e quinta à tarde.
  const coberturas = [
    ...[1, 2, 3, 4, 5].map((diaSemana) => ["Clínica médica", diaSemana, "08:00", "12:00", 1]),
    ["Odontologia", 2, "13:00", "17:00", 1],
    ["Odontologia", 4, "13:00", "17:00", 1],
  ];
  for (const [especialidade, diaSemana, inicio, fim, minimo] of coberturas) {
    await tx.$executeRaw`
      INSERT INTO grupo3.cobertura_necessaria (especialidade_id, dia_semana, hora_inicio, hora_fim, quantidade_minima)
      VALUES (${especialidades[especialidade]}::uuid, ${diaSemana}, ${inicio}::time, ${fim}::time, ${minimo})
    `;
  }

  // Escala dos próximos 14 dias conforme a disponibilidade (deixa lacunas onde não há ninguém).
  const escalaIds = {};
  for (let offset = 0; offset < 14; offset += 1) {
    const data = emDiaLocal(offset);
    const diaSemana = ((new Date(`${data}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    for (const [chave, dia, inicio, fim] of disponibilidades) {
      if (dia !== diaSemana || !["medico", "medico_voluntario", "dentista"].includes(chave)) continue;
      const especialidade = especialidades[chave === "dentista" ? "Odontologia" : "Clínica médica"];
      const rows = await tx.$queryRaw`
        INSERT INTO grupo3.escala (colaborador_id, especialidade_id, local, inicio, fim, situacao, criado_por_ref)
        VALUES (${colaboradores[chave]}::uuid, ${especialidade}::uuid, ${chave === "dentista" ? "Consultório odontológico" : "Consultório 1"},
                (${data}::date + ${inicio}::time) AT TIME ZONE grupo3.fuso_horario(),
                (${data}::date + ${fim}::time) AT TIME ZONE grupo3.fuso_horario(), 'confirmada', ${autor}::uuid)
        RETURNING id
      `;
      escalaIds[`${chave}:${offset}`] = rows[0].id;
    }
  }

  // Presença de hoje: quem está trabalhando.
  const hoje = emDiaLocal(0);
  const presencas = [
    ["enfermeira", "presente", "07:00", null, "Plantão diurno", null],
    ["farmacia", "presente", "08:00", null, "Dispensação", null],
    ["voluntaria", "presente", "14:00", "16:30", "Cuidados pessoais", null],
    ["cabeleireiro", "ausente", null, null, null, "Remarcou para a próxima semana."],
  ];
  for (const [chave, situacao, entrada, saida, atividade, justificativa] of presencas) {
    await tx.$executeRaw`
      INSERT INTO grupo3.presenca (colaborador_id, data, situacao, entrada_em, saida_em, atividade, justificativa, registrado_por_ref)
      VALUES (${colaboradores[chave]}::uuid, ${hoje}::date, ${situacao}::grupo3.situacao_presenca,
              (${hoje}::date + ${entrada}::time) AT TIME ZONE grupo3.fuso_horario(),
              (${hoje}::date + ${saida}::time) AT TIME ZONE grupo3.fuso_horario(), ${atividade}, ${justificativa}, ${autor}::uuid)
    `;
  }
}

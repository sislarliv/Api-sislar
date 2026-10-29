function isoDay(offset) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function atDays(days, hours, minutes = 0) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

async function refOf(tx, table, id) {
  const rows = table === "users"
    ? await tx.$queryRaw`SELECT ref FROM users WHERE id = ${id}`
    : await tx.$queryRaw`SELECT ref FROM patients WHERE id = ${id}`;
  if (!rows[0]) throw new Error(`Sem UUID de ${table} ${id}.`);
  return rows[0].ref;
}

async function local(tx, nome, tipo) {
  const rows = await tx.$queryRaw`
    INSERT INTO grupo2.local_armazenamento (nome, tipo)
    VALUES (${nome}, ${tipo})
    RETURNING id
  `;
  return rows[0].id;
}

async function produto(tx, { nome, categoria, unidade, localId, minima, medicamento, responsavel, lotes }) {
  const created = await tx.$queryRaw`
    INSERT INTO grupo2.produto (nome, categoria, unidade)
    VALUES (${nome}, ${categoria}::grupo2.categoria_produto, ${unidade})
    RETURNING id
  `;
  const id = created[0].id;
  if (medicamento) {
    await tx.$executeRaw`
      INSERT INTO grupo2.medicamento (produto_id, principio_ativo, apresentacao, concentracao, controlado, cadeia_frio)
      VALUES (
        ${id}::uuid,
        ${medicamento.principio},
        ${medicamento.apresentacao},
        ${medicamento.concentracao},
        ${medicamento.controlado},
        ${medicamento.cadeiaFrio}
      )
    `;
  }
  await tx.$executeRaw`
    INSERT INTO grupo2.produto_local_estoque (produto_id, local_id, quantidade_minima)
    VALUES (${id}::uuid, ${localId}::uuid, ${minima})
  `;
  for (const lote of lotes) {
    const row = await tx.$queryRaw`
      INSERT INTO grupo2.lote_estoque (produto_id, local_id, codigo, validade, fornecedor, saldo)
      VALUES (${id}::uuid, ${localId}::uuid, ${lote.codigo}, ${lote.validade}::date, ${"Distribuidora Vale Verde"}, 0)
      RETURNING id
    `;
    await tx.$executeRaw`
      INSERT INTO grupo2.movimentacao_estoque (
        produto_id, local_id, lote_id, tipo, quantidade, variacao, motivo, responsavel_ref, chave_idempotencia
      ) VALUES (
        ${id}::uuid,
        ${localId}::uuid,
        ${row[0].id}::uuid,
        'entrada'::grupo2.tipo_movimentacao,
        ${lote.quantidade},
        ${lote.quantidade},
        ${"Saldo inicial"},
        ${responsavel}::uuid,
        ${`seed:${nome}:${lote.codigo}`}
      )
    `;
  }
  return id;
}

export async function seedGrupo2(tx) {
  const estoque = await refOf(tx, "users", "s10");
  const farmaceutico = await refOf(tx, "users", "s08");
  const medico = await refOf(tx, "users", "s05");
  const idoso = await refOf(tx, "patients", "p02");
  const farmacia = await local(tx, "Farmácia", "farmacia");
  const almoxarifado = await local(tx, "Almoxarifado", "geral");
  const enfermagem = await local(tx, "Enfermagem", "posto_enfermagem");

  const meds = [
    ["Losartana potássica", "Losartana", "Comprimido", "50 mg", "comprimido", 400, false, [["LP2411", 200, 620], ["LP2503", 380, 900]]],
    ["Metformina", "Cloridrato de metformina", "Comprimido", "850 mg", "comprimido", 500, false, [["MF2408", 40, 180], ["MF2502", 300, 240]]],
    ["Sinvastatina", "Sinvastatina", "Comprimido", "20 mg", "comprimido", 300, false, []],
    ["Ácido acetilsalicílico", "AAS", "Comprimido", "100 mg", "comprimido", 300, false, [["AS2410", -12, 150]]],
    ["Omeprazol", "Omeprazol", "Cápsula", "20 mg", "cápsula", 300, false, []],
    ["Levotiroxina sódica", "Levotiroxina", "Comprimido", "50 mcg", "comprimido", 200, false, []],
    ["Insulina humana NPH", "Insulina NPH", "Frasco-ampola 10 mL", "100 UI/mL", "frasco", 10, true, [["IN2412", 55, 6]]],
    ["Dipirona sódica", "Dipirona", "Solução oral", "500 mg/mL", "frasco", 10, false, [["DP2505", 360, 24]]],
  ];
  let losartanaId;
  for (const [nome, principio, apresentacao, concentracao, unidade, minima, cadeiaFrio, lotes] of meds) {
    const id = await produto(tx, {
      nome,
      categoria: "medicamento",
      unidade,
      localId: farmacia,
      minima,
      responsavel: farmaceutico,
      medicamento: { principio, apresentacao, concentracao, controlado: false, cadeiaFrio },
      lotes: lotes.map(([codigo, validade, quantidade]) => ({ codigo, validade: isoDay(validade), quantidade })),
    });
    if (nome === "Losartana potássica") losartanaId = id;
  }

  const insumos = [
    ["Fralda geriátrica G", "higiene", "pacote", 20, 48, almoxarifado],
    ["Luva de procedimento M", "epi", "caixa", 15, 8, almoxarifado],
    ["Álcool 70%", "limpeza", "litro", 10, 18, enfermagem],
    ["Gaze estéril", "insumo_enfermagem", "pacote", 12, 30, enfermagem],
  ];
  for (const [nome, categoria, unidade, minima, quantidade, localId] of insumos) {
    await produto(tx, {
      nome,
      categoria,
      unidade,
      localId,
      minima,
      responsavel: estoque,
      lotes: [{ codigo: "LOTE-INICIAL", validade: isoDay(400), quantidade }],
    });
  }

  const prescricao = await tx.$queryRaw`
    INSERT INTO grupo2.prescricao (idoso_ref, prescritor_ref, registrado_por_ref, inicio_em)
    VALUES (${idoso}::uuid, ${medico}::uuid, ${medico}::uuid, ${isoDay(-15)}::date)
    RETURNING id
  `;
  const item = await tx.$queryRaw`
    INSERT INTO grupo2.item_prescricao (prescricao_id, produto_id, texto_dose, unidades_por_dose, via_administracao, instrucoes)
    VALUES (${prescricao[0].id}::uuid, ${losartanaId}::uuid, ${"50 mg"}, ${1}, ${"oral"}, ${"Administrar após o café."})
    RETURNING id
  `;
  await tx.$executeRaw`
    INSERT INTO grupo2.agenda_dose (item_prescricao_id, horario)
    VALUES (${item[0].id}::uuid, ${"08:00"}::time)
  `;

  const equipamentos = [
    ["Geladeira da farmácia", "geladeira", "Farmácia", 2, 8, "SNS-FARM-01", farmaceutico, 5.2, 7, 0],
    ["Geladeira da copa", "geladeira", "Copa", 1, 5, "SNS-COPA-01", estoque, 9.4, 8, 30],
    ["Enfermaria Ipê", "ambiente", "Ala Ipê", 20, 26, "SNS-IPE-01", null, null, null, null],
  ];
  for (const [nome, tipo, localizacao, minima, maxima, rotulo, responsavel, valor, hora, minuto] of equipamentos) {
    const equipamento = await tx.$queryRaw`
      INSERT INTO grupo2.equipamento (nome, tipo, localizacao, temperatura_minima_c, temperatura_maxima_c)
      VALUES (${nome}, ${tipo}::grupo2.tipo_equipamento, ${localizacao}, ${minima}, ${maxima})
      RETURNING id, temperatura_minima_c, temperatura_maxima_c
    `;
    const sensor = await tx.$queryRaw`
      INSERT INTO grupo2.configuracao_sensor (equipamento_id, rotulo, ativo)
      VALUES (${equipamento[0].id}::uuid, ${rotulo}, true)
      RETURNING id
    `;
    if (valor == null) continue;
    await tx.$executeRaw`
      INSERT INTO grupo2.leitura_temperatura (
        equipamento_id, medido_em, temperatura_c, origem, limite_minimo_c, limite_maximo_c,
        responsavel_ref, configuracao_sensor_id, chave_idempotencia
      ) VALUES (
        ${equipamento[0].id}::uuid,
        ${atDays(0, hora, minuto)},
        ${valor},
        'manual'::grupo2.origem_leitura,
        ${minima},
        ${maxima},
        ${responsavel}::uuid,
        ${sensor[0].id}::uuid,
        ${null}
      )
    `;
  }
}

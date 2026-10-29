BEGIN;

CREATE SCHEMA IF NOT EXISTS grupo2;
SET search_path = grupo2, pg_catalog;

CREATE TYPE categoria_produto AS ENUM ('medicamento','insumo_enfermagem','higiene','alimentacao','limpeza','epi','utilitario');
CREATE TYPE tipo_movimentacao AS ENUM ('entrada','saida','saida_excepcional','descarte','ajuste','reversao');
CREATE TYPE situacao_prescricao AS ENUM ('ativa','suspensa','encerrada');
CREATE TYPE situacao_dose AS ENUM ('administrada','recusada','adiada','nao_administrada','cancelada');
CREATE TYPE situacao_inventario AS ENUM ('em_andamento','concluida','cancelada');
CREATE TYPE tipo_equipamento AS ENUM ('freezer','geladeira','camara','ambiente');
CREATE TYPE origem_leitura AS ENUM ('manual','sensor','importacao');
CREATE TYPE situacao_ocorrencia AS ENUM ('aberta','reconhecida','resolvida');

-- Configuração do banco compartilhado; as referências de usuários e idosos continuam externas.
CREATE FUNCTION fuso_horario_valido(text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1)
$$;
CREATE TABLE configuracao_institucional (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  fuso_horario text NOT NULL DEFAULT 'America/Sao_Paulo',
  CHECK (fuso_horario_valido(fuso_horario))
);
INSERT INTO configuracao_institucional(id) VALUES (true);
CREATE FUNCTION fuso_horario_institucional() RETURNS text LANGUAGE sql STABLE SET search_path = grupo2, pg_catalog AS $$
  SELECT fuso_horario FROM configuracao_institucional WHERE id = true
$$;
CREATE FUNCTION data_institucional(timestamptz) RETURNS date LANGUAGE sql STABLE SET search_path = grupo2, pg_catalog AS $$
  SELECT ($1 AT TIME ZONE fuso_horario_institucional())::date
$$;

-- Catálogo geral de produtos, com categoria e unidade de controle. O nome não pode se repetir para a mesma unidade.
CREATE TABLE produto (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL CHECK (length(trim(nome)) > 0),
  categoria categoria_produto NOT NULL,
  unidade text NOT NULL CHECK (length(trim(unidade)) > 0),
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (nome, unidade)
);
CREATE UNIQUE INDEX indice_produto_nome ON produto (lower(nome), unidade);
-- Complementa um produto do catálogo com dados farmacêuticos; cada medicamento corresponde a um único produto.
CREATE TABLE medicamento (
  produto_id uuid PRIMARY KEY REFERENCES produto(id) ON DELETE RESTRICT,
  principio_ativo text,
  apresentacao text NOT NULL CHECK (length(trim(apresentacao)) > 0),
  concentracao text,
  controlado boolean NOT NULL DEFAULT false,
  cadeia_frio boolean NOT NULL DEFAULT false,
  CHECK (produto_id IS NOT NULL)
);
CREATE FUNCTION validar_categoria_medicamento() RETURNS trigger LANGUAGE plpgsql SET search_path = grupo2, pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM produto WHERE id = NEW.produto_id AND categoria = 'medicamento') THEN
    RAISE EXCEPTION 'Medicamento deve referenciar produto da categoria medicamento';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validar_categoria_medicamento_antes_de_gravar
  BEFORE INSERT OR UPDATE ON medicamento
  FOR EACH ROW EXECUTE FUNCTION validar_categoria_medicamento();
-- Cadastro dos locais de armazenamento, como farmácia, almoxarifado e posto de enfermagem.
CREATE TABLE local_armazenamento (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL UNIQUE,
  tipo text NOT NULL CHECK (tipo IN ('farmacia','geral','posto_enfermagem','cozinha','outro')),
  ativo boolean NOT NULL DEFAULT true
);
-- Define quais produtos são mantidos em cada local e o saldo mínimo usado para identificar reposição.
CREATE TABLE produto_local_estoque (
  produto_id uuid NOT NULL REFERENCES produto(id) ON DELETE RESTRICT,
  local_id uuid NOT NULL REFERENCES local_armazenamento(id) ON DELETE RESTRICT,
  quantidade_minima numeric(14,3) NOT NULL DEFAULT 0 CHECK (quantidade_minima >= 0),
  PRIMARY KEY (produto_id, local_id)
);
-- Registra lote, validade, fornecedor e saldo por produto e local. O saldo é atualizado pelas movimentações; negativo somente com autorização excepcional válida.
CREATE TABLE lote_estoque (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id uuid NOT NULL,
  local_id uuid NOT NULL,
  codigo text NOT NULL,
  validade date,
  fornecedor text,
  recebido_em timestamptz NOT NULL DEFAULT now(),
  saldo numeric(14,3) NOT NULL DEFAULT 0,
  FOREIGN KEY (produto_id, local_id) REFERENCES produto_local_estoque(produto_id, local_id) ON DELETE RESTRICT,
  UNIQUE (produto_id, local_id, codigo)
);
CREATE INDEX indice_lote_produto_local ON lote_estoque(produto_id, local_id);
CREATE INDEX indice_lote_validade ON lote_estoque(validade) WHERE saldo > 0;
-- Autoriza uma saída excepcional específica, limitada por lote, quantidade e validade.
CREATE TABLE autorizacao_saida_excepcional (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lote_id uuid NOT NULL REFERENCES lote_estoque(id) ON DELETE RESTRICT,
  quantidade_maxima numeric(14,3) NOT NULL CHECK (quantidade_maxima > 0),
  motivo text NOT NULL CHECK (length(trim(motivo)) > 0),
  autorizador_ref uuid NOT NULL,
  autorizada_em timestamptz NOT NULL DEFAULT now(),
  expira_em timestamptz NOT NULL,
  quantidade_utilizada numeric(14,3) NOT NULL DEFAULT 0 CHECK (quantidade_utilizada >= 0 AND quantidade_utilizada <= quantidade_maxima),
  CHECK (expira_em > autorizada_em)
);
-- Registro imutável com motivo, responsável e saldo após o lançamento. O gatilho serializa operações por lote e permite saldo negativo somente com autorização excepcional registrada.
CREATE TABLE movimentacao_estoque (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id uuid NOT NULL,
  local_id uuid NOT NULL,
  lote_id uuid NOT NULL REFERENCES lote_estoque(id) ON DELETE RESTRICT,
  tipo tipo_movimentacao NOT NULL,
  quantidade numeric(14,3) NOT NULL CHECK (quantidade > 0),
  variacao numeric(14,3) NOT NULL,
  saldo_apos numeric(14,3),
  motivo text NOT NULL CHECK (length(trim(motivo)) > 0),
  documento_ref text,
  idoso_ref uuid,
  responsavel_ref uuid NOT NULL,
  conferente_ref uuid,
  ocorrido_em timestamptz NOT NULL DEFAULT now(),
  chave_idempotencia text NOT NULL UNIQUE,
  estorna_movimentacao_id uuid REFERENCES movimentacao_estoque(id) ON DELETE RESTRICT,
  autorizacao_excepcional_id uuid UNIQUE REFERENCES autorizacao_saida_excepcional(id) ON DELETE RESTRICT,
  FOREIGN KEY (produto_id, local_id) REFERENCES produto_local_estoque(produto_id, local_id) ON DELETE RESTRICT,
  CHECK (quantidade = abs(variacao)),
  CHECK ((tipo = 'entrada' AND variacao > 0) OR (tipo IN ('saida','saida_excepcional','descarte') AND variacao < 0) OR (tipo IN ('ajuste','reversao') AND variacao <> 0)),
  CHECK ((tipo = 'reversao') = (estorna_movimentacao_id IS NOT NULL)),
  CHECK ((tipo = 'saida_excepcional') = (autorizacao_excepcional_id IS NOT NULL))
);
CREATE UNIQUE INDEX indice_reversao_unica ON movimentacao_estoque(estorna_movimentacao_id) WHERE estorna_movimentacao_id IS NOT NULL;
CREATE INDEX indice_historico_movimentacao ON movimentacao_estoque(produto_id, local_id, ocorrido_em DESC);
CREATE INDEX indice_movimentacao_idoso ON movimentacao_estoque(idoso_ref, ocorrido_em DESC) WHERE idoso_ref IS NOT NULL;
CREATE FUNCTION aplicar_movimentacao_estoque() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = grupo2, pg_catalog AS $$
DECLARE current_balance numeric(14,3); new_balance numeric(14,3); lot_expiry date;
  authorization_row autorizacao_saida_excepcional%ROWTYPE; original movimentacao_estoque%ROWTYPE;
  inventory_item_id uuid; inventory_id uuid; counted_balance numeric(14,3);
BEGIN
  SELECT saldo, saldo + NEW.variacao, validade INTO current_balance, new_balance, lot_expiry FROM lote_estoque
    WHERE id = NEW.lote_id AND produto_id = NEW.produto_id AND local_id = NEW.local_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'O lote nao corresponde ao produto e local'; END IF;
  SELECT ii.id, ii.inventario_id, ii.quantidade_contada INTO inventory_item_id, inventory_id, counted_balance
  FROM item_inventario ii JOIN inventario inv ON inv.id = ii.inventario_id
  WHERE ii.lote_id = NEW.lote_id AND inv.situacao = 'em_andamento';
  IF FOUND AND (NEW.tipo <> 'ajuste' OR NEW.item_inventario_id IS DISTINCT FROM inventory_item_id
     OR counted_balance IS NULL
     OR NEW.chave_idempotencia <> 'inventario-ajuste:' || inventory_id::text || ':' || NEW.lote_id::text
     OR new_balance <> counted_balance) THEN
    RAISE EXCEPTION 'Lote bloqueado durante inventario em andamento';
  END IF;
  IF lot_expiry < data_institucional(now()) AND NEW.tipo IN ('saida','saida_excepcional') THEN
    RAISE EXCEPTION 'Lote vencido deve ser descartado, nao dispensado';
  END IF;
  IF NEW.tipo = 'saida_excepcional' THEN
    SELECT * INTO authorization_row FROM autorizacao_saida_excepcional
      WHERE id = NEW.autorizacao_excepcional_id AND lote_id = NEW.lote_id FOR UPDATE;
    IF NOT FOUND OR authorization_row.expira_em <= now()
       OR NEW.quantidade > authorization_row.quantidade_maxima - authorization_row.quantidade_utilizada THEN
      RAISE EXCEPTION 'Autorizacao excepcional ausente, vencida ou insuficiente';
    END IF;
    PERFORM set_config('grupo2.movimentacao_interna', '1', true);
    UPDATE autorizacao_saida_excepcional
       SET quantidade_utilizada = quantidade_utilizada + NEW.quantidade
     WHERE id = authorization_row.id;
    PERFORM set_config('grupo2.movimentacao_interna', '0', true);
  ELSIF new_balance < 0 THEN
    RAISE EXCEPTION 'Estoque insuficiente';
  END IF;
  IF NEW.tipo = 'reversao' THEN
    SELECT * INTO original FROM movimentacao_estoque WHERE id = NEW.estorna_movimentacao_id FOR UPDATE;
     IF NOT FOUND OR original.lote_id <> NEW.lote_id OR original.produto_id <> NEW.produto_id
       OR original.local_id <> NEW.local_id OR original.variacao <> -NEW.variacao OR original.tipo = 'reversao' THEN
      RAISE EXCEPTION 'Reversao nao corresponde a movimentacao original';
    END IF;
  END IF;
  PERFORM set_config('grupo2.movimentacao_interna', '1', true);
  UPDATE lote_estoque SET saldo = new_balance WHERE id = NEW.lote_id;
  PERFORM set_config('grupo2.movimentacao_interna', '0', true);
  NEW.saldo_apos := new_balance;
  RETURN NEW;
END $$;
CREATE TRIGGER aplicar_movimentacao_estoque_antes_de_gravar BEFORE INSERT ON movimentacao_estoque
  FOR EACH ROW EXECUTE FUNCTION aplicar_movimentacao_estoque();

CREATE FUNCTION impedir_alteracao_movimentacao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'O historico de movimentacoes so permite inclusoes';
END $$;
CREATE TRIGGER impedir_alteracao_movimentacao_antes_de_gravar BEFORE UPDATE OR DELETE ON movimentacao_estoque
  FOR EACH ROW EXECUTE FUNCTION impedir_alteracao_movimentacao();

CREATE FUNCTION proteger_saldo_lote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.saldo <> 0 THEN
    RAISE EXCEPTION 'Saldo inicial deve ser registrado como movimentacao de entrada';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.saldo IS DISTINCT FROM OLD.saldo
      AND current_setting('grupo2.movimentacao_interna', true) IS DISTINCT FROM '1'
      AND current_user = session_user THEN
    RAISE EXCEPTION 'Saldo do lote deve ser alterado por movimentacao de estoque';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER proteger_saldo_lote_antes_de_alterar BEFORE INSERT OR UPDATE OF saldo ON lote_estoque
  FOR EACH ROW EXECUTE FUNCTION proteger_saldo_lote();

CREATE FUNCTION proteger_autorizacao_saida() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Autorizacao excepcional e seus limites sao historicos';
  END IF;
  IF NEW.lote_id IS DISTINCT FROM OLD.lote_id
     OR NEW.quantidade_maxima IS DISTINCT FROM OLD.quantidade_maxima
     OR NEW.motivo IS DISTINCT FROM OLD.motivo
     OR NEW.autorizador_ref IS DISTINCT FROM OLD.autorizador_ref
     OR NEW.autorizada_em IS DISTINCT FROM OLD.autorizada_em
     OR NEW.expira_em IS DISTINCT FROM OLD.expira_em THEN
    RAISE EXCEPTION 'Autorizacao excepcional e seus limites sao historicos';
  END IF;
    IF NEW.quantidade_utilizada IS DISTINCT FROM OLD.quantidade_utilizada
      AND current_setting('grupo2.movimentacao_interna', true) IS DISTINCT FROM '1'
      AND current_user = session_user THEN
    RAISE EXCEPTION 'Uso da autorizacao so pode ser alterado por movimentacao';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER proteger_autorizacao_saida_antes_de_alterar BEFORE UPDATE OR DELETE ON autorizacao_saida_excepcional
  FOR EACH ROW EXECUTE FUNCTION proteger_autorizacao_saida();

-- Guarda situação e período de prescrições. As referências de idoso e prescritor são UUIDs externos, pois essas entidades ainda não existem neste banco.
CREATE TABLE prescricao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idoso_ref uuid NOT NULL,
  prescritor_ref uuid NOT NULL,
  registrado_por_ref uuid NOT NULL,
  responsavel_situacao_ref uuid,
  situacao situacao_prescricao NOT NULL DEFAULT 'ativa',
  motivo_situacao text,
  inicio_em date NOT NULL,
  termino_em date,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (termino_em IS NULL OR termino_em >= inicio_em)
);
CREATE INDEX indice_prescricao_idoso_situacao ON prescricao(idoso_ref, situacao);
-- Linha do tempo imutável de criação e mudanças de situação da prescrição.
CREATE TABLE historico_prescricao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prescricao_id uuid NOT NULL REFERENCES prescricao(id) ON DELETE RESTRICT,
  situacao_anterior situacao_prescricao,
  situacao_nova situacao_prescricao NOT NULL,
  motivo text,
  responsavel_ref uuid NOT NULL,
  ocorrido_em timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION registrar_historico_prescricao() RETURNS trigger LANGUAGE plpgsql SET search_path = grupo2, pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO historico_prescricao(prescricao_id,situacao_nova,motivo,responsavel_ref)
    VALUES(NEW.id,NEW.situacao,NEW.motivo_situacao,NEW.registrado_por_ref);
  ELSIF NEW.situacao IS DISTINCT FROM OLD.situacao THEN
    IF NEW.responsavel_situacao_ref IS NULL OR length(trim(coalesce(NEW.motivo_situacao,''))) = 0 THEN
      RAISE EXCEPTION 'Mudanca de situacao exige responsavel e motivo';
    END IF;
    INSERT INTO historico_prescricao(prescricao_id,situacao_anterior,situacao_nova,motivo,responsavel_ref)
    VALUES(NEW.id,OLD.situacao,NEW.situacao,NEW.motivo_situacao,NEW.responsavel_situacao_ref);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER registrar_historico_prescricao_apos_gravar AFTER INSERT OR UPDATE OF situacao ON prescricao
  FOR EACH ROW EXECUTE FUNCTION registrar_historico_prescricao();
-- Relaciona cada prescrição aos medicamentos prescritos, incluindo dose, quantidade por dose, via e instruções.
CREATE TABLE item_prescricao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prescricao_id uuid NOT NULL REFERENCES prescricao(id) ON DELETE RESTRICT,
  produto_id uuid NOT NULL REFERENCES medicamento(produto_id) ON DELETE RESTRICT,
  texto_dose text NOT NULL CHECK (length(trim(texto_dose)) > 0),
  unidades_por_dose numeric(14,3) NOT NULL CHECK (unidades_por_dose > 0),
  via_administracao text NOT NULL CHECK (length(trim(via_administracao)) > 0),
  instrucoes text,
  UNIQUE (prescricao_id, produto_id)
);
CREATE FUNCTION impedir_prescricao_ativa_duplicada() RETURNS trigger LANGUAGE plpgsql SET search_path = grupo2, pg_catalog AS $$
DECLARE patient_id uuid; rx_status situacao_prescricao;
BEGIN
  SELECT idoso_ref, situacao INTO patient_id, rx_status FROM prescricao WHERE id = NEW.prescricao_id;
  IF rx_status = 'ativa' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(patient_id::text || ':' || NEW.produto_id::text, 0));
    IF EXISTS (
      SELECT 1 FROM item_prescricao i JOIN prescricao p ON p.id = i.prescricao_id
      WHERE p.idoso_ref = patient_id AND p.situacao = 'ativa' AND i.produto_id = NEW.produto_id
        AND i.id <> coalesce(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
    ) THEN RAISE EXCEPTION 'Ja existe prescricao ativa deste medicamento para o idoso'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER impedir_prescricao_ativa_duplicada_antes_de_gravar BEFORE INSERT OR UPDATE ON item_prescricao
  FOR EACH ROW EXECUTE FUNCTION impedir_prescricao_ativa_duplicada();
CREATE FUNCTION validar_ativacao_prescricao() RETURNS trigger LANGUAGE plpgsql SET search_path = grupo2, pg_catalog AS $$
DECLARE item item_prescricao%ROWTYPE;
BEGIN
  IF NEW.situacao = 'ativa' AND (OLD.situacao <> 'ativa' OR NEW.idoso_ref IS DISTINCT FROM OLD.idoso_ref) THEN
    FOR item IN SELECT * FROM item_prescricao WHERE prescricao_id = NEW.id LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(NEW.idoso_ref::text || ':' || item.produto_id::text, 0));
      IF EXISTS (SELECT 1 FROM item_prescricao i JOIN prescricao p ON p.id=i.prescricao_id
        WHERE p.idoso_ref=NEW.idoso_ref AND p.situacao='ativa' AND i.produto_id=item.produto_id AND p.id<>NEW.id) THEN
        RAISE EXCEPTION 'Ja existe prescricao ativa deste medicamento para o idoso';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validar_ativacao_prescricao_antes_de_atualizar BEFORE UPDATE OF situacao, idoso_ref ON prescricao
  FOR EACH ROW EXECUTE FUNCTION validar_ativacao_prescricao();
-- Armazena os horários diários definidos para cada item da prescrição; não gera orientação clínica.
CREATE TABLE agenda_dose (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_prescricao_id uuid NOT NULL REFERENCES item_prescricao(id) ON DELETE RESTRICT,
  horario time NOT NULL,
  UNIQUE (item_prescricao_id, horario)
);
-- Registro original por dose e horário. Evita duplicidade, confere o idoso da prescrição e exige motivo para recusa, adiamento ou não administração.
CREATE TABLE administracao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_prescricao_id uuid NOT NULL REFERENCES item_prescricao(id) ON DELETE RESTRICT,
  idoso_ref uuid NOT NULL,
  agendado_em timestamptz NOT NULL,
  agendado_data date NOT NULL,
  agendado_horario time NOT NULL,
  situacao situacao_dose NOT NULL,
  quantidade_administrada numeric(14,3),
  motivo text,
  responsavel_ref uuid NOT NULL,
  conferente_ref uuid,
  registrado_em timestamptz NOT NULL DEFAULT now(),
  chave_idempotencia text UNIQUE,
  UNIQUE (item_prescricao_id, agendado_data, agendado_horario),
  CHECK (situacao NOT IN ('recusada','adiada','nao_administrada','cancelada') OR length(trim(coalesce(motivo,''))) > 0),
  CHECK (quantidade_administrada IS NULL OR quantidade_administrada > 0)
);
CREATE INDEX indice_administracao_agendada ON administracao(agendado_em, situacao);
CREATE INDEX indice_historico_administracao_idoso ON administracao(idoso_ref, agendado_em DESC);
-- Retificações preservam o registro original e anotam o estado corrigido, motivo e responsável.
CREATE TABLE correcao_administracao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  administracao_id uuid NOT NULL REFERENCES administracao(id) ON DELETE RESTRICT,
  situacao_corrigida situacao_dose NOT NULL,
  quantidade_corrigida numeric(14,3),
  motivo text NOT NULL CHECK (length(trim(motivo)) > 0),
  responsavel_ref uuid NOT NULL,
  chave_idempotencia text NOT NULL UNIQUE,
  corrigido_em timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION validar_correcao_administracao() RETURNS trigger LANGUAGE plpgsql SET search_path = grupo2, pg_catalog AS $$
DECLARE prescribed_qty numeric(14,3);
BEGIN
  SELECT ip.unidades_por_dose INTO prescribed_qty
  FROM administracao a JOIN item_prescricao ip ON ip.id = a.item_prescricao_id
  WHERE a.id = NEW.administracao_id;
  IF NEW.situacao_corrigida = 'administrada'
     AND (NEW.quantidade_corrigida IS NULL OR NEW.quantidade_corrigida <= 0 OR NEW.quantidade_corrigida > prescribed_qty) THEN
    RAISE EXCEPTION 'Correcao para administrada exige quantidade valida';
  END IF;
  IF NEW.situacao_corrigida <> 'administrada' AND NEW.quantidade_corrigida IS NOT NULL THEN
    RAISE EXCEPTION 'Quantidade corrigida so pode existir para dose administrada';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validar_correcao_administracao_antes_de_gravar
  BEFORE INSERT ON correcao_administracao
  FOR EACH ROW EXECUTE FUNCTION validar_correcao_administracao();
CREATE FUNCTION impedir_alteracao_historico() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Registro historico nao pode ser alterado ou excluido';
END $$;
CREATE TRIGGER preservar_administracao_antes_de_alterar BEFORE UPDATE OR DELETE ON administracao
  FOR EACH ROW EXECUTE FUNCTION impedir_alteracao_historico();
CREATE TRIGGER preservar_correcao_administracao_antes_de_alterar BEFORE UPDATE OR DELETE ON correcao_administracao
  FOR EACH ROW EXECUTE FUNCTION impedir_alteracao_historico();
CREATE TRIGGER preservar_historico_prescricao_antes_de_alterar BEFORE UPDATE OR DELETE ON historico_prescricao
  FOR EACH ROW EXECUTE FUNCTION impedir_alteracao_historico();
CREATE TRIGGER preservar_prescricao_antes_de_excluir BEFORE DELETE ON prescricao
  FOR EACH ROW EXECUTE FUNCTION impedir_alteracao_historico();
CREATE VIEW administracao_atual AS
SELECT a.id, a.item_prescricao_id, a.idoso_ref, a.agendado_em,
       coalesce(c.situacao_corrigida,a.situacao) AS situacao,
      coalesce(c.quantidade_corrigida,a.quantidade_administrada) AS quantidade_administrada,
       coalesce(c.motivo,a.motivo) AS motivo,
       a.responsavel_ref, a.registrado_em,
       c.responsavel_ref AS responsavel_correcao, c.corrigido_em
FROM administracao a
LEFT JOIN LATERAL (SELECT ca.situacao_corrigida,ca.quantidade_corrigida,ca.motivo,ca.responsavel_ref,ca.corrigido_em
  FROM correcao_administracao ca WHERE ca.administracao_id=a.id ORDER BY ca.corrigido_em DESC,ca.id DESC LIMIT 1) c ON true;

-- Cabeçalho da dispensação com idoso, responsável, prescrição opcional e chave para reenvios seguros.
CREATE TABLE dispensacao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idoso_ref uuid NOT NULL,
  responsavel_ref uuid NOT NULL,
  conferente_ref uuid,
  dispensado_em timestamptz NOT NULL DEFAULT now(),
  chave_idempotencia text NOT NULL UNIQUE,
  observacao text
);
-- Itens entregues por lote; cada inclusão gera a saída de estoque correspondente.
CREATE TABLE item_dispensacao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispensacao_id uuid NOT NULL REFERENCES dispensacao(id) ON DELETE RESTRICT,
  item_prescricao_id uuid REFERENCES item_prescricao(id) ON DELETE RESTRICT,
  produto_id uuid NOT NULL REFERENCES produto(id) ON DELETE RESTRICT,
  lote_id uuid NOT NULL REFERENCES lote_estoque(id) ON DELETE RESTRICT,
  quantidade numeric(14,3) NOT NULL CHECK (quantidade > 0),
  UNIQUE (dispensacao_id, lote_id, produto_id)
);
CREATE TRIGGER preservar_dispensacao_antes_de_alterar BEFORE UPDATE OR DELETE ON dispensacao
  FOR EACH ROW EXECUTE FUNCTION impedir_alteracao_historico();
CREATE TRIGGER preservar_item_dispensacao_antes_de_alterar BEFORE UPDATE OR DELETE ON item_dispensacao
  FOR EACH ROW EXECUTE FUNCTION impedir_alteracao_historico();
ALTER TABLE movimentacao_estoque ADD COLUMN item_dispensacao_id uuid UNIQUE REFERENCES item_dispensacao(id) ON DELETE RESTRICT;

CREATE FUNCTION registrar_saida_dispensacao() RETURNS trigger LANGUAGE plpgsql SET search_path = grupo2, pg_catalog AS $$
DECLARE disp dispensacao%ROWTYPE; lot lote_estoque%ROWTYPE; rx_product uuid; rx_patient uuid;
BEGIN
  SELECT * INTO disp FROM dispensacao WHERE id = NEW.dispensacao_id;
  SELECT * INTO lot FROM lote_estoque WHERE id = NEW.lote_id;
  IF lot.produto_id <> NEW.produto_id THEN RAISE EXCEPTION 'Produto nao corresponde ao lote'; END IF;
  IF NEW.item_prescricao_id IS NOT NULL THEN
    SELECT i.produto_id, p.idoso_ref INTO rx_product, rx_patient
      FROM item_prescricao i JOIN prescricao p ON p.id = i.prescricao_id WHERE i.id = NEW.item_prescricao_id;
    IF rx_product IS DISTINCT FROM NEW.produto_id OR rx_patient IS DISTINCT FROM disp.idoso_ref THEN
      RAISE EXCEPTION 'Produto ou idoso nao corresponde ao item prescrito';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM prescricao p JOIN item_prescricao i ON i.prescricao_id=p.id
      WHERE i.id=NEW.item_prescricao_id AND p.situacao='ativa' AND p.inicio_em <= data_institucional(disp.dispensado_em)
        AND (p.termino_em IS NULL OR p.termino_em >= data_institucional(disp.dispensado_em))) THEN
      RAISE EXCEPTION 'Prescricao inativa ou fora do periodo de validade';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM medicamento WHERE produto_id=NEW.produto_id) THEN
    RAISE EXCEPTION 'Dispensacao aceita somente produtos cadastrados como medicamento';
  END IF;
  INSERT INTO movimentacao_estoque(produto_id,local_id,lote_id,tipo,quantidade,variacao,motivo,idoso_ref,responsavel_ref,conferente_ref,chave_idempotencia,item_dispensacao_id)
  VALUES(NEW.produto_id,lot.local_id,NEW.lote_id,'saida',NEW.quantidade,-NEW.quantidade,'Dispensacao',disp.idoso_ref,disp.responsavel_ref,disp.conferente_ref,NEW.id::text,NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER registrar_saida_dispensacao_apos_item AFTER INSERT ON item_dispensacao
  FOR EACH ROW EXECUTE FUNCTION registrar_saida_dispensacao();

CREATE FUNCTION validar_idoso_administracao() RETURNS trigger LANGUAGE plpgsql SET search_path = grupo2, pg_catalog AS $$
DECLARE expected_patient uuid; rx_status situacao_prescricao; rx_start date; rx_end date; prescribed_qty numeric(14,3);
BEGIN
  NEW.agendado_data := data_institucional(NEW.agendado_em);
  NEW.agendado_horario := date_trunc('minute',NEW.agendado_em AT TIME ZONE fuso_horario_institucional())::time;
  NEW.agendado_em := (NEW.agendado_data + NEW.agendado_horario) AT TIME ZONE fuso_horario_institucional();
  SELECT p.idoso_ref, p.situacao, p.inicio_em, p.termino_em, i.unidades_por_dose
    INTO expected_patient, rx_status, rx_start, rx_end, prescribed_qty FROM item_prescricao i
    JOIN prescricao p ON p.id = i.prescricao_id WHERE i.id = NEW.item_prescricao_id;
  IF expected_patient IS NULL OR expected_patient IS DISTINCT FROM NEW.idoso_ref THEN
    RAISE EXCEPTION 'Idoso da administracao nao corresponde a prescricao';
  END IF;
  IF rx_status <> 'ativa' OR rx_start > data_institucional(NEW.agendado_em)
     OR (rx_end IS NOT NULL AND rx_end < data_institucional(NEW.agendado_em)) THEN
    RAISE EXCEPTION 'Prescricao inativa ou fora do periodo de validade';
  END IF;
  IF NEW.situacao = 'administrada' THEN
    IF NEW.quantidade_administrada IS NULL OR NEW.quantidade_administrada > prescribed_qty THEN
      RAISE EXCEPTION 'Quantidade administrada deve ser positiva e nao exceder a dose prescrita';
    END IF;
  ELSIF NEW.quantidade_administrada IS NOT NULL THEN
    RAISE EXCEPTION 'Quantidade administrada so pode ser informada para dose administrada';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM item_prescricao i JOIN prescricao p ON p.id=i.prescricao_id
    JOIN agenda_dose d ON d.item_prescricao_id=i.id
    WHERE i.id=NEW.item_prescricao_id
      AND p.inicio_em <= data_institucional(NEW.agendado_em)
      AND (p.termino_em IS NULL OR p.termino_em >= data_institucional(NEW.agendado_em))
      AND d.horario = NEW.agendado_horario) THEN
    RAISE EXCEPTION 'Horario da administracao nao corresponde a agenda da prescricao';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validar_idoso_administracao_antes_de_gravar BEFORE INSERT OR UPDATE ON administracao
  FOR EACH ROW EXECUTE FUNCTION validar_idoso_administracao();

-- Cabeçalho do inventário, com responsável, local, situação e horários de início e encerramento.
CREATE TABLE inventario (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo text NOT NULL,
  local_id uuid REFERENCES local_armazenamento(id) ON DELETE RESTRICT,
  situacao situacao_inventario NOT NULL DEFAULT 'em_andamento',
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  encerrado_em timestamptz,
  responsavel_ref uuid NOT NULL,
  CHECK ((situacao = 'em_andamento' AND encerrado_em IS NULL) OR (situacao <> 'em_andamento' AND encerrado_em IS NOT NULL))
);
-- Guarda saldo de sistema capturado do lote e quantidade contada. Divergências exigem justificativa e geram movimentação de ajuste ao concluir o inventário.
CREATE TABLE item_inventario (
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  inventario_id uuid NOT NULL REFERENCES inventario(id) ON DELETE RESTRICT,
  lote_id uuid NOT NULL REFERENCES lote_estoque(id) ON DELETE RESTRICT,
  quantidade_sistema numeric(14,3) NOT NULL,
  quantidade_contada numeric(14,3) CHECK (quantidade_contada >= 0),
  justificativa text,
  PRIMARY KEY (inventario_id, lote_id),
  CHECK (quantidade_contada IS NULL OR quantidade_contada = quantidade_sistema OR length(trim(coalesce(justificativa,''))) > 0)
);
ALTER TABLE movimentacao_estoque ADD COLUMN item_inventario_id uuid UNIQUE REFERENCES item_inventario(id) ON DELETE RESTRICT;

CREATE FUNCTION proteger_item_inventario() RETURNS trigger LANGUAGE plpgsql SET search_path = grupo2, pg_catalog AS $$
DECLARE inventory_status situacao_inventario; inventory_location uuid; lot_location uuid; current_qty numeric(14,3); target_inventory_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN target_inventory_id := NEW.inventario_id; ELSE target_inventory_id := OLD.inventario_id; END IF;
  SELECT situacao, local_id INTO inventory_status, inventory_location FROM inventario
    WHERE id = target_inventory_id FOR UPDATE;
  IF inventory_status <> 'em_andamento' THEN RAISE EXCEPTION 'Inventario encerrado nao pode ser alterado'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT saldo, local_id INTO current_qty, lot_location FROM lote_estoque WHERE id=NEW.lote_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Lote do inventario nao encontrado'; END IF;
    IF EXISTS (SELECT 1 FROM item_inventario ii JOIN inventario inv ON inv.id=ii.inventario_id
      WHERE ii.lote_id=NEW.lote_id AND inv.situacao='em_andamento' AND ii.inventario_id<>NEW.inventario_id) THEN
      RAISE EXCEPTION 'Lote ja esta em outro inventario em andamento';
    END IF;
    IF inventory_location IS NOT NULL AND inventory_location <> lot_location THEN
      RAISE EXCEPTION 'O lote nao pertence ao local deste inventario';
    END IF;
    NEW.quantidade_sistema := current_qty;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.inventario_id <> OLD.inventario_id OR NEW.lote_id <> OLD.lote_id OR NEW.quantidade_sistema <> OLD.quantidade_sistema) THEN
    RAISE EXCEPTION 'Identificacao e saldo de sistema do item sao historicos';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER proteger_item_inventario_antes_de_alterar BEFORE INSERT OR UPDATE OR DELETE ON item_inventario
  FOR EACH ROW EXECUTE FUNCTION proteger_item_inventario();

CREATE FUNCTION fechar_inventario_com_ajustes() RETURNS trigger LANGUAGE plpgsql SET search_path = grupo2, pg_catalog AS $$
DECLARE line item_inventario%ROWTYPE; lot lote_estoque%ROWTYPE; difference numeric(14,3);
BEGIN
  IF OLD.situacao <> 'em_andamento' THEN RAISE EXCEPTION 'Inventario encerrado nao pode ser reaberto ou alterado'; END IF;
  IF OLD.situacao = 'em_andamento' AND NEW.situacao <> 'em_andamento' THEN
    NEW.encerrado_em := coalesce(NEW.encerrado_em, now());
  END IF;
  IF OLD.situacao = 'em_andamento' AND NEW.situacao = 'concluida' THEN
    IF EXISTS (SELECT 1 FROM item_inventario WHERE inventario_id = NEW.id AND quantidade_contada IS NULL) THEN
      RAISE EXCEPTION 'Todas as linhas devem ser contadas para concluir o inventario';
    END IF;
    FOR line IN SELECT * FROM item_inventario WHERE inventario_id = NEW.id LOOP
      SELECT * INTO lot FROM lote_estoque WHERE id = line.lote_id FOR UPDATE;
      difference := line.quantidade_contada - lot.saldo;
      IF difference <> 0 THEN
        INSERT INTO movimentacao_estoque(produto_id,local_id,lote_id,tipo,quantidade,variacao,motivo,responsavel_ref,chave_idempotencia,item_inventario_id)
        VALUES(lot.produto_id,lot.local_id,lot.id,'ajuste',abs(difference),difference,'Ajuste de inventario ' || NEW.id,NEW.responsavel_ref,
               'inventario-ajuste:' || NEW.id::text || ':' || line.lote_id::text,line.id);
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fechar_inventario_apos_atualizar BEFORE UPDATE OF situacao ON inventario
  FOR EACH ROW EXECUTE FUNCTION fechar_inventario_com_ajustes();

-- Cadastro de equipamentos e limites mínimo e máximo configurados para cada um; nenhum limite padrão é presumido.
CREATE TABLE equipamento (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  tipo tipo_equipamento NOT NULL,
  localizacao text NOT NULL,
  conteudo text,
  temperatura_minima_c numeric(6,2) NOT NULL,
  temperatura_maxima_c numeric(6,2) NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  CHECK (temperatura_minima_c <= temperatura_maxima_c)
);
-- Configuração preparatória para associar um dispositivo ao equipamento, sem ativar ou presumir protocolo de integração.
CREATE TABLE configuracao_sensor (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipamento_id uuid NOT NULL REFERENCES equipamento(id) ON DELETE RESTRICT,
  rotulo text NOT NULL,
  dispositivo_externo_ref text,
  protocolo text,
  intervalo_minutos integer CHECK (intervalo_minutos IS NULL OR intervalo_minutos > 0),
  ativo boolean NOT NULL DEFAULT false,
  criado_em timestamptz NOT NULL DEFAULT now()
);
-- Histórico imutável de medições com instante, valor, origem e responsável quando manual. Registra os limites vigentes na leitura e preserva valores fora da faixa.
CREATE TABLE leitura_temperatura (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipamento_id uuid NOT NULL REFERENCES equipamento(id) ON DELETE RESTRICT,
  medido_em timestamptz NOT NULL,
  temperatura_c numeric(6,2) NOT NULL,
  origem origem_leitura NOT NULL DEFAULT 'manual',
  limite_minimo_c numeric(6,2) NOT NULL,
  limite_maximo_c numeric(6,2) NOT NULL,
  responsavel_ref uuid,
  configuracao_sensor_id uuid REFERENCES configuracao_sensor(id) ON DELETE RESTRICT,
  chave_idempotencia text UNIQUE,
  observacao text,
  CHECK ((origem = 'manual' AND responsavel_ref IS NOT NULL) OR origem <> 'manual'),
  CHECK ((origem = 'sensor' AND configuracao_sensor_id IS NOT NULL AND chave_idempotencia IS NOT NULL) OR origem <> 'sensor'),
  CHECK (limite_minimo_c <= limite_maximo_c)
);
CREATE INDEX indice_historico_leitura_temperatura ON leitura_temperatura(equipamento_id, medido_em DESC);
CREATE FUNCTION preparar_leitura_temperatura() RETURNS trigger LANGUAGE plpgsql SET search_path = grupo2, pg_catalog AS $$
DECLARE equipment_row equipamento%ROWTYPE; sensor_equipment uuid;
BEGIN
  SELECT * INTO equipment_row FROM equipamento WHERE id = NEW.equipamento_id;
  NEW.limite_minimo_c := equipment_row.temperatura_minima_c;
  NEW.limite_maximo_c := equipment_row.temperatura_maxima_c;
  IF NEW.origem = 'sensor' THEN
    SELECT equipamento_id INTO sensor_equipment FROM configuracao_sensor
      WHERE id = NEW.configuracao_sensor_id AND ativo;
    IF sensor_equipment IS DISTINCT FROM NEW.equipamento_id THEN RAISE EXCEPTION 'Sensor nao corresponde ao equipamento'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preparar_leitura_temperatura_antes_de_gravar BEFORE INSERT ON leitura_temperatura
  FOR EACH ROW EXECUTE FUNCTION preparar_leitura_temperatura();
CREATE FUNCTION preservar_leitura_temperatura() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Leituras de temperatura sao historicas e nao podem ser alteradas ou excluidas';
END $$;
CREATE TRIGGER preservar_leitura_temperatura_antes_de_alterar BEFORE UPDATE OR DELETE ON leitura_temperatura
  FOR EACH ROW EXECUTE FUNCTION preservar_leitura_temperatura();
-- Ocorrência vinculada a uma leitura fora dos limites do equipamento, com situação e dados de reconhecimento e resolução.
CREATE TABLE ocorrencia_temperatura (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leitura_id uuid NOT NULL UNIQUE REFERENCES leitura_temperatura(id) ON DELETE RESTRICT,
  situacao situacao_ocorrencia NOT NULL DEFAULT 'aberta',
  reconhecido_por_ref uuid,
  reconhecido_em timestamptz,
  resolvido_por_ref uuid,
  resolvido_em timestamptz,
  motivo_reconhecimento text,
  motivo_resolucao text,
  CHECK ((reconhecido_por_ref IS NULL) = (reconhecido_em IS NULL)),
  CHECK ((situacao = 'aberta') = (reconhecido_por_ref IS NULL)),
  CHECK (situacao = 'aberta' OR length(trim(coalesce(motivo_reconhecimento,''))) > 0),
  CHECK (situacao <> 'resolvida' OR length(trim(coalesce(motivo_resolucao,''))) > 0),
  CHECK ((situacao = 'resolvida') = (resolvido_por_ref IS NOT NULL AND resolvido_em IS NOT NULL))
);
CREATE TABLE historico_ocorrencia_temperatura (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ocorrencia_id uuid NOT NULL REFERENCES ocorrencia_temperatura(id) ON DELETE RESTRICT,
  situacao_anterior situacao_ocorrencia,
  situacao_nova situacao_ocorrencia NOT NULL,
  responsavel_ref uuid,
  ocorrido_em timestamptz NOT NULL DEFAULT now(),
  motivo text
);
-- Registro cronológico das providências adotadas para tratar uma ocorrência, com responsável e horário.
CREATE TABLE acao_corretiva (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ocorrencia_id uuid NOT NULL REFERENCES ocorrencia_temperatura(id) ON DELETE RESTRICT,
  responsavel_ref uuid NOT NULL,
  acao text NOT NULL CHECK (length(trim(acao)) > 0),
  ocorrido_em timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER preservar_acao_corretiva_antes_de_alterar BEFORE UPDATE OR DELETE ON acao_corretiva
  FOR EACH ROW EXECUTE FUNCTION impedir_alteracao_historico();

CREATE FUNCTION validar_transicao_ocorrencia_temperatura() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.situacao <> 'aberta' OR NEW.reconhecido_por_ref IS NOT NULL OR NEW.reconhecido_em IS NOT NULL
       OR NEW.resolvido_por_ref IS NOT NULL OR NEW.resolvido_em IS NOT NULL
       OR NEW.motivo_reconhecimento IS NOT NULL OR NEW.motivo_resolucao IS NOT NULL THEN
      RAISE EXCEPTION 'Nova ocorrencia de temperatura deve iniciar aberta';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.leitura_id IS DISTINCT FROM OLD.leitura_id THEN
    RAISE EXCEPTION 'Leitura vinculada a ocorrencia e historica';
  END IF;
  IF NEW.situacao = OLD.situacao AND (NEW.reconhecido_por_ref IS DISTINCT FROM OLD.reconhecido_por_ref
     OR NEW.reconhecido_em IS DISTINCT FROM OLD.reconhecido_em
     OR NEW.resolvido_por_ref IS DISTINCT FROM OLD.resolvido_por_ref
     OR NEW.resolvido_em IS DISTINCT FROM OLD.resolvido_em) THEN
    RAISE EXCEPTION 'Dados de ocorrencia so mudam durante a transicao de estado';
  END IF;
  IF OLD.situacao = 'resolvida' OR (OLD.situacao = 'aberta' AND NEW.situacao <> 'reconhecida')
     OR (OLD.situacao = 'reconhecida' AND NEW.situacao <> 'resolvida') THEN
    RAISE EXCEPTION 'Transicao de ocorrencia de temperatura invalida';
  END IF;
    IF NEW.situacao = 'reconhecida' AND (NEW.reconhecido_por_ref IS NULL OR NEW.reconhecido_em IS NULL
      OR length(trim(coalesce(NEW.motivo_reconhecimento,''))) = 0) THEN
    RAISE EXCEPTION 'Reconhecimento exige responsavel e horario';
  END IF;
    IF NEW.situacao = 'resolvida' AND (NEW.resolvido_por_ref IS NULL OR NEW.resolvido_em IS NULL
      OR length(trim(coalesce(NEW.motivo_resolucao,''))) = 0) THEN
    RAISE EXCEPTION 'Resolucao exige responsavel e horario';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validar_transicao_ocorrencia_temperatura_antes_de_atualizar
  BEFORE INSERT OR UPDATE ON ocorrencia_temperatura
  FOR EACH ROW EXECUTE FUNCTION validar_transicao_ocorrencia_temperatura();

CREATE FUNCTION registrar_historico_ocorrencia_temperatura() RETURNS trigger LANGUAGE plpgsql SET search_path = grupo2, pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO historico_ocorrencia_temperatura(ocorrencia_id,situacao_nova,responsavel_ref,motivo)
    VALUES(NEW.id,NEW.situacao,coalesce(NEW.reconhecido_por_ref,NEW.resolvido_por_ref),coalesce(NEW.motivo_reconhecimento,NEW.motivo_resolucao));
  ELSE
    INSERT INTO historico_ocorrencia_temperatura(ocorrencia_id,situacao_anterior,situacao_nova,responsavel_ref,motivo)
    VALUES(NEW.id,OLD.situacao,NEW.situacao,coalesce(NEW.resolvido_por_ref,NEW.reconhecido_por_ref),coalesce(NEW.motivo_resolucao,NEW.motivo_reconhecimento));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER registrar_historico_ocorrencia_temperatura_apos_gravar
  AFTER INSERT OR UPDATE OF situacao ON ocorrencia_temperatura
  FOR EACH ROW EXECUTE FUNCTION registrar_historico_ocorrencia_temperatura();
CREATE TRIGGER preservar_historico_ocorrencia_temperatura_antes_de_alterar
  BEFORE UPDATE OR DELETE ON historico_ocorrencia_temperatura
  FOR EACH ROW EXECUTE FUNCTION impedir_alteracao_historico();

CREATE FUNCTION criar_ocorrencia_temperatura() RETURNS trigger LANGUAGE plpgsql SET search_path = grupo2, pg_catalog AS $$
DECLARE lo numeric(6,2); hi numeric(6,2);
BEGIN
  SELECT limite_minimo_c, limite_maximo_c INTO lo, hi FROM leitura_temperatura WHERE id = NEW.id;
  IF NEW.temperatura_c < lo OR NEW.temperatura_c > hi THEN
    INSERT INTO ocorrencia_temperatura(leitura_id) VALUES (NEW.id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verificar_leitura_temperatura_apos_gravar AFTER INSERT ON leitura_temperatura
  FOR EACH ROW EXECUTE FUNCTION criar_ocorrencia_temperatura();

CREATE VIEW estoque_abaixo_minimo AS
SELECT p.id AS produto_id, p.nome AS produto, l.id AS local_id, l.nome AS nome_local,
       e.quantidade_minima,
  coalesce(sum(CASE WHEN lote.validade IS NULL OR lote.validade >= data_institucional(now()) THEN greatest(lote.saldo, 0) ELSE 0 END),0)::numeric(14,3) AS saldo_utilizavel
FROM produto_local_estoque e
JOIN produto p ON p.id=e.produto_id
JOIN local_armazenamento l ON l.id=e.local_id
LEFT JOIN lote_estoque lote ON lote.produto_id=e.produto_id AND lote.local_id=e.local_id
GROUP BY p.id,p.nome,l.id,l.nome,e.quantidade_minima
HAVING coalesce(sum(CASE WHEN lote.validade IS NULL OR lote.validade >= data_institucional(now()) THEN greatest(lote.saldo, 0) ELSE 0 END),0) = 0
  OR coalesce(sum(CASE WHEN lote.validade IS NULL OR lote.validade >= data_institucional(now()) THEN greatest(lote.saldo, 0) ELSE 0 END),0) < e.quantidade_minima;

CREATE VIEW necessidade_semanal_medicamento AS
SELECT p.idoso_ref, ip.produto_id,
       sum(ip.unidades_por_dose)::numeric(14,3) AS unidades_previstas_proximos_sete_dias,
      (SELECT coalesce(sum(greatest(lote.saldo, 0)),0)::numeric(14,3) FROM lote_estoque lote
       WHERE lote.produto_id=ip.produto_id AND (lote.validade IS NULL OR lote.validade >= data_institucional(now()))) AS saldo_utilizavel_total
FROM prescricao p
JOIN item_prescricao ip ON ip.prescricao_id=p.id
JOIN agenda_dose ad ON ad.item_prescricao_id=ip.id
JOIN generate_series(data_institucional(now()), data_institucional(now()) + 6, interval '1 day') AS dias(data)
  ON dias.data::date >= p.inicio_em AND (p.termino_em IS NULL OR dias.data::date <= p.termino_em)
WHERE p.situacao='ativa'
GROUP BY p.idoso_ref,ip.produto_id;

CREATE VIEW medicacao_atual_idoso AS
SELECT p.idoso_ref, p.id AS prescricao_id, ip.produto_id, ip.texto_dose,
       ip.unidades_por_dose, ip.via_administracao, ip.instrucoes,
       ad.horario, p.inicio_em, p.termino_em
FROM prescricao p JOIN item_prescricao ip ON ip.prescricao_id=p.id
LEFT JOIN agenda_dose ad ON ad.item_prescricao_id=ip.id
WHERE p.situacao='ativa' AND p.inicio_em <= data_institucional(now())
  AND (p.termino_em IS NULL OR p.termino_em >= data_institucional(now()));

CREATE VIEW consumo_medicamento_diario AS
SELECT ip.produto_id, date_trunc('day', a.registrado_em AT TIME ZONE fuso_horario_institucional()) AS dia,
       sum(a.quantidade_administrada)::numeric(14,3) AS quantidade_administrada
FROM administracao_atual a JOIN item_prescricao ip ON ip.id=a.item_prescricao_id
WHERE a.situacao='administrada'
GROUP BY ip.produto_id,date_trunc('day',a.registrado_em AT TIME ZONE fuso_horario_institucional());

CREATE VIEW consumo_estoque_categoria_diario AS
SELECT p.categoria, date_trunc('day', mv.ocorrido_em AT TIME ZONE fuso_horario_institucional()) AS dia,
      sum(-mv.variacao)::numeric(14,3) AS quantidade_baixada
FROM produto p JOIN movimentacao_estoque mv ON mv.produto_id=p.id
WHERE mv.tipo IN ('saida','saida_excepcional','descarte')
   OR (mv.tipo = 'reversao' AND EXISTS (
     SELECT 1 FROM movimentacao_estoque original
     WHERE original.id = mv.estorna_movimentacao_id
       AND original.tipo IN ('saida','saida_excepcional','descarte')
   ))
GROUP BY p.categoria,date_trunc('day',mv.ocorrido_em AT TIME ZONE fuso_horario_institucional());

CREATE VIEW doses_previstas_hoje AS
SELECT p.idoso_ref, ip.id AS item_prescricao_id, ip.produto_id,
      ((data_institucional(now()) + ad.horario) AT TIME ZONE fuso_horario_institucional()) AS agendado_em,
       coalesce(a.situacao::text,'pendente') AS situacao
FROM prescricao p
JOIN item_prescricao ip ON ip.prescricao_id=p.id
JOIN agenda_dose ad ON ad.item_prescricao_id=ip.id
LEFT JOIN administracao_atual a ON a.item_prescricao_id=ip.id
  AND a.agendado_em=((data_institucional(now()) + ad.horario) AT TIME ZONE fuso_horario_institucional())
WHERE p.situacao='ativa' AND p.inicio_em <= data_institucional(now())
  AND (p.termino_em IS NULL OR p.termino_em >= data_institucional(now()));

CREATE VIEW alertas_temperatura_abertos AS
SELECT o.id AS ocorrencia_id, l.equipamento_id, l.medido_em, l.temperatura_c,
       l.limite_minimo_c, l.limite_maximo_c, o.situacao
FROM ocorrencia_temperatura o JOIN leitura_temperatura l ON l.id=o.leitura_id
WHERE o.situacao <> 'resolvida';

-- O backend recebe INSERT de movimentações; alterações sensíveis dependem dos gatilhos SECURITY DEFINER.
REVOKE UPDATE (saldo) ON lote_estoque FROM PUBLIC;
REVOKE UPDATE (quantidade_utilizada) ON autorizacao_saida_excepcional FROM PUBLIC;
COMMIT;

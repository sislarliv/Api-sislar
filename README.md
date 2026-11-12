# SISLAR API

API do prontuário do Lar do Irmão Velho (SISLAR): usuários e perfis, moradores, evolução, sinais vitais, ocorrências, documentos, planos, PAE, POP, farmácia, estoque, temperatura, agenda, visitas, emergências e importação.

O núcleo usa Prisma (`sql/schema.sql`), a migração do Grupo 1 usa `sql/migracao.sql` e farmácia, estoque e temperatura usam o schema `grupo2` (`sql/grupo2.sql`). Usuário e morador entram no schema `grupo2` apenas como UUID (`users.ref`, `patients.ref`).

## Subir

1. Docker em execução.
2. `docker compose up -d`
3. `npm install`
4. `npm run db:setup` (apenas para um banco descartável: recria os schemas e a carga de demonstração)
5. `npm start` — http://localhost:3333
6. Documentação Swagger — http://localhost:3333/api/docs

Banco local: `postgres://sislar:sislar@localhost:5432/sislar`

Para atualizar um banco existente sem apagá-lo, aplique os scripts SQL do Grupo 1 nesta ordem, com `psql -v ON_ERROR_STOP=1 -f <arquivo>`: `sql/upgrade_grupo1_idosos.sql`, `sql/upgrade_grupo1_clinico.sql`, `sql/upgrade_grupo1_pae.sql`, `sql/migracao.sql`. Faça isso antes de subir a API nova. Em produção, faça backup e use o processo de implantação da instituição.

Senha dos usuários de demonstração: `Sislar@2026`

Exemplos: `marta.lima@lardoirmaovelho.example` (administração), `carla.nunes@lardoirmaovelho.example` (enfermagem), `helena.duarte@lardoirmaovelho.example` (voluntariado).

## Autenticação

`POST /api/auth/login` com `{ "email", "password" }` devolve `token`. Envie `Authorization: Bearer <token>`.

`POST /api/auth/recuperar-senha` e `POST /api/auth/redefinir-senha` com `{ "token", "password" }`. Fora de produção a recuperação devolve `resetToken` porque o envio de e-mail ainda não está integrado.

## Rotas

- `GET /api/health`
- `GET /api/auth/eu`, `GET|PATCH /api/perfil`, `PATCH /api/perfil/senha`
- `GET|POST /api/usuarios`, `GET|PATCH /api/usuarios/:id`
- Cadastro de idosos, contatos, avisos e transferências em `/api/idosos`; quartos, leitos e ocupação em `/api/quartos`
- `GET /api/prontuarios`, `GET /api/prontuarios/:patientId`
- Dados clínicos e seu histórico de alterações, prontuário completo, evolução, gráficos de sinais vitais, ocorrências, documentos vinculados, planos, linha do tempo e ficha sob `/api/prontuarios/:patientId/...`
- Acesso clínico por perfil em `/api/prontuarios/acesso/perfis`
- `GET|POST /api/pae`, modelos em `/api/pae/modelos`, versões em `/api/pae/:id/versoes` e pendências em `/api/pae/pendencias`
- `GET|POST /api/pop`, filtros de vigência, status e nova versão em `POST /api/pop/:id/versoes`
- Farmácia: `/api/farmacia/medicamentos`, `/prescricoes`, `/administracoes`, `/dispensacoes`
- Estoque: `/api/estoque/itens`, `/movimentacoes`, `/inventarios`
- Temperatura: `/api/temperatura/equipamentos`, `/leituras`, `/alertas` (`/reconhecer`, `/resolver`)
- `GET /api/dashboard`, `/api/notificacoes`, `/api/funcionarios`, `/api/agenda`, `/api/visitas`, `/api/emergencias`, `/api/atendimentos`
- Relatórios em `/api/relatorios/ocupacao`, `/ocorrencias`, `/estoque`
- Migração com prévia e conferência em `/api/importacoes` e documentos digitalizados em `/api/migracao/documentos`

Cada rota exige a permissão do perfil (os mesmos códigos do protótipo). Administração acessa tudo.

Evolução finalizada não é editada: a correção grava o texto anterior e o motivo. O saldo do lote só muda por movimentação. Lote vencido não é dispensado. Prescrição ativa do mesmo medicamento não se repete para o idoso. Leitura fora da faixa abre ocorrência (`aberta`, depois `reconhecida`, depois `resolvida`).

`npm test` recria o banco `sislar_test`.

## Migração de prontuários do Grupo 1

O modelo de importação é CSV UTF-8 com cabeçalho. As colunas obrigatórias são `nome;sexo;nascimento;ala;quarto;leito`. São opcionais `admissao`, `identificador_origem`, `dados_clinicos` e `contatos`, em qualquer ordem. Datas usam `AAAA-MM-DD`; `sexo` aceita `F` ou `M`. O quarto e o leito devem existir, estar ativos e desocupados. `dados_clinicos` recebe uma lista JSON de `{sectionId,sectionTitle,label,value}` e `contatos` uma lista JSON de `{name,relation,phone,isPrimary,priority,notes}`. Campos JSON no CSV devem seguir o escape padrão de aspas duplas. `GET /api/importacoes/modelo` expõe esse contrato à aplicação.

1. `POST /api/importacoes` recebe o CSV e devolve a prévia por linha, sem criar idosos.
2. `GET /api/importacoes/:id/rejeicoes` mostra os motivos. `PATCH /api/importacoes/:id/linhas/:lineNumber` corrige dados ou ignora uma linha, com motivo e histórico consultável.
3. `POST /api/importacoes/:id/confirmar` carrega as linhas válidas de modo transacional. Todas as rejeições precisam ser corrigidas ou ignoradas antes.
4. `POST /api/importacoes/:id/amostra` registra as linhas conferidas e o checklist. `POST /api/importacoes/:id/concluir` exige amostra aprovada e registra período, responsável, quantidade e resultado.

`GET /api/importacoes/legado` mantém a consulta aos lotes importados antes desse fluxo. Para uma linha CSV com colunas desalinhadas, a correção deve reenviar os seis campos obrigatórios; os opcionais precisam ser informados novamente quando aplicáveis.

`POST /api/migracao/documentos` recebe PDF, PNG ou JPEG (até 8 MB), categoria, data do documento, origem, identificador opcional e vínculo ao idoso. A API registra data e responsável pela digitalização e permite associar o documento ao lote. O download segue a permissão de documentos do prontuário. Acesso aos lotes exige `dados.import` e `prontuario.view`; digitalização exige também `documento.upload`.

O backlog ainda deixa para validação funcional as decisões D-002 (campos clínicos), D-003/D-014 (forma e conteúdo da digitalização) e D-015 (retenção e exportação). O CSV usa campos clínicos configuráveis para não fixar essas decisões no código.


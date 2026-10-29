# SISLAR API

API do prontuário do Lar do Irmão Velho (SISLAR): usuários e perfis, moradores, evolução, sinais vitais, ocorrências, documentos, planos, PAE, POP, farmácia, estoque, temperatura, agenda, visitas, emergências e importação.

Consultas passam pelo Prisma. O DDL, com as restrições CHECK, continua em `sql/schema.sql`.

## Subir

1. Docker em execução.
2. `docker compose up -d`
3. `npm install`
4. `npm run db:setup`
5. `npm start` — http://localhost:3333
6. Documentação Swagger — http://localhost:3333/api/docs

Banco local: `postgres://sislar:sislar@localhost:5432/sislar`

Senha dos usuários de demonstração: `Sislar@2026`

Exemplos: `marta.lima@lardoirmaovelho.example` (administração), `carla.nunes@lardoirmaovelho.example` (enfermagem), `helena.duarte@lardoirmaovelho.example` (voluntariado).

## Autenticação

`POST /api/auth/login` com `{ "email", "password" }` devolve `token`. Envie `Authorization: Bearer <token>`.

`POST /api/auth/recuperar-senha` e `POST /api/auth/redefinir-senha` com `{ "token", "password" }`. Fora de produção a recuperação devolve `resetToken` porque o envio de e-mail ainda não está integrado.

## Rotas

- `GET /api/health`
- `GET /api/auth/eu`, `GET|PATCH /api/perfil`, `PATCH /api/perfil/senha`
- `GET|POST /api/usuarios`, `GET|PATCH /api/usuarios/:id`
- `GET /api/prontuarios`, `GET|PATCH /api/prontuarios/:patientId`
- Evoluções, sinais vitais, ocorrências, documentos, planos e ficha sob `/api/prontuarios/:patientId/...`
- `GET|POST /api/pae`, modelos em `/api/pae/modelos`
- `GET|POST /api/pop`, nova versão em `POST /api/pop/:id/versoes`
- Farmácia: `/api/farmacia/medicamentos`, `/prescricoes`, `/administracoes`, `/dispensacoes`
- Estoque: `/api/estoque/itens`, `/movimentacoes`, `/inventarios`, `/reposicoes`
- Temperatura: `/api/temperatura/equipamentos`, `/leituras`, `/alertas`
- `GET /api/dashboard`, `/api/notificacoes`, `/api/funcionarios`, `/api/agenda`, `/api/visitas`, `/api/emergencias`, `/api/atendimentos`
- Relatórios em `/api/relatorios/ocupacao`, `/ocorrencias`, `/estoque`
- `POST /api/importacoes` com CSV `nome;sexo;nascimento;ala;quarto;leito`

Cada rota exige a permissão do perfil (os mesmos códigos do protótipo). Administração acessa tudo.

Evolução finalizada não é editada: a correção grava o texto anterior e o motivo. Saída de estoque e dispensação não ultrapassam o saldo. Leitura de temperatura fora da faixa abre alerta.

`npm test` recria o banco `sislar_test`.

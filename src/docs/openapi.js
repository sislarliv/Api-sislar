const ident = { type: "string", pattern: "^[A-Za-z0-9_-]+$" };
const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", example: "2026-10-28" };
const profiles = {
  type: "array",
  minItems: 1,
  maxItems: 4,
  items: {
    type: "string",
    enum: ["admin", "gestor", "enfermagem", "tecnico", "medico", "fisioterapia", "odontologia", "farmacia", "recepcao", "estoque", "voluntario"],
  },
};

const pathParam = (name) => ({ name, in: "path", required: true, schema: ident });
const queryParam = (name, schema) => ({ name, in: "query", required: false, schema });
const pageQuery = [
  queryParam("page", { type: "integer", minimum: 1, default: 1 }),
  queryParam("limit", { type: "integer", minimum: 1, maximum: 100, default: 20 }),
];

const list = {
  type: "object",
  properties: { data: { type: "array", items: { type: "object", additionalProperties: true } } },
};
const entity = { type: "object", additionalProperties: true };
const message = { type: "object", properties: { message: { type: "string" } } };

function op(tag, summary, perm, extras = {}) {
  const parameters = [...(extras.params || []), ...(extras.query || [])];
  const status = String(extras.status || 200);
  const operation = {
    tags: [tag],
    summary,
    description: extras.public
      ? "Rota pública."
      : perm
        ? `Permissão: \`${perm}\`.`
        : "Exige sessão autenticada.",
    security: extras.public ? [] : [{ bearerAuth: [] }],
    responses: {
      [status]: {
        description: status === "201" ? "Criado." : "Sucesso.",
        content: extras.binary
          ? { "application/octet-stream": { schema: { type: "string", format: "binary" } } }
          : { "application/json": { schema: extras.schema || entity } },
      },
    },
  };
  if (parameters.length) operation.parameters = parameters;
  if (extras.body) {
    operation.requestBody = { required: true, content: { "application/json": { schema: extras.body } } };
  }
  if (extras.multipart) {
    operation.requestBody = { required: true, content: { "multipart/form-data": { schema: extras.multipart } } };
  }
  if (!extras.public) {
    operation.responses["401"] = { $ref: "#/components/responses/NaoAutenticado" };
    operation.responses["403"] = { $ref: "#/components/responses/SemPermissao" };
    operation.responses["422"] = { $ref: "#/components/responses/Invalido" };
  } else if (extras.validated) {
    operation.responses["422"] = { $ref: "#/components/responses/Invalido" };
  }
  if (extras.conflict) operation.responses["409"] = { $ref: "#/components/responses/Conflito" };
  if (extras.missing) operation.responses["404"] = { $ref: "#/components/responses/NaoEncontrado" };
  if (extras.responses) Object.assign(operation.responses, extras.responses);
  return operation;
}

const patient = [pathParam("patientId")];
const patientAndId = [pathParam("patientId"), pathParam("id")];

const evolution = {
  type: "object",
  properties: {
    at: { type: "string", format: "date-time" },
    type: { type: "string", enum: ["rotina", "reavaliacao", "cuidado", "intercorrencia"] },
    title: { type: "string", minLength: 3, maxLength: 160 },
    description: { type: "string", minLength: 10, maxLength: 8000 },
    notes: { type: "string", maxLength: 2000, nullable: true },
    alimentacao: { type: "string", maxLength: 80, nullable: true },
    hidratacao: { type: "string", maxLength: 80, nullable: true },
    sono: { type: "string", maxLength: 80, nullable: true },
    humor: { type: "string", maxLength: 80, nullable: true },
    mobilidade: { type: "string", maxLength: 80, nullable: true },
    pele: { type: "string", maxLength: 80, nullable: true },
    status: { type: "string", enum: ["rascunho", "finalizado"] },
  },
};

const popBody = {
  type: "object",
  required: ["code", "title", "category", "purpose", "validFrom", "validUntil", "sections"],
  properties: {
    code: { type: "string", minLength: 3, maxLength: 40 },
    title: { type: "string", minLength: 3, maxLength: 160 },
    category: { type: "string", minLength: 2, maxLength: 80 },
    purpose: { type: "string", minLength: 10, maxLength: 2000 },
    validFrom: date,
    validUntil: date,
    status: { type: "string", enum: ["rascunho", "vigente"] },
    sections: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        required: ["title", "items"],
        properties: {
          title: { type: "string", minLength: 2, maxLength: 120 },
          items: { type: "array", minItems: 1, maxItems: 30, items: { type: "string", minLength: 2, maxLength: 500 } },
        },
      },
    },
    related: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        required: ["kind", "label"],
        properties: {
          kind: { type: "string", minLength: 2, maxLength: 40 },
          label: { type: "string", minLength: 2, maxLength: 80 },
        },
      },
    },
    summary: { type: "string", minLength: 3, maxLength: 300 },
  },
};

export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "SISLAR API",
    version: "1.0.0",
    description: "Prontuário eletrônico do Lar do Irmão Velho. Envie o token JWT em Authorize. Demonstração: marta.lima@lardoirmaovelho.example / Sislar@2026. Datas de calendário usam AAAA-MM-DD. Datas com hora usam ISO 8601.",
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "Sistema" },
    { name: "Autenticação" },
    { name: "Usuários" },
    { name: "Prontuário" },
    { name: "PAE" },
    { name: "POP" },
    { name: "Farmácia" },
    { name: "Estoque" },
    { name: "Temperatura" },
    { name: "Operação" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
    responses: {
      NaoAutenticado: { description: "Sessão ausente ou inválida.", content: { "application/json": { schema: { $ref: "#/components/schemas/Erro" } } } },
      SemPermissao: { description: "Perfil sem a permissão exigida.", content: { "application/json": { schema: { $ref: "#/components/schemas/Erro" } } } },
      NaoEncontrado: { description: "Registro não encontrado.", content: { "application/json": { schema: { $ref: "#/components/schemas/Erro" } } } },
      Invalido: { description: "Dados fora das regras de validação.", content: { "application/json": { schema: { $ref: "#/components/schemas/Erro" } } } },
      Conflito: { description: "Estado atual impede a operação.", content: { "application/json": { schema: { $ref: "#/components/schemas/Erro" } } } },
    },
    schemas: {
      Erro: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: { message: { type: "string" }, details: {} },
          },
        },
      },
    },
  },
  paths: {
    "/": {
      get: op("Sistema", "Identificação da API", null, { public: true, schema: { type: "object", properties: { name: { type: "string" }, institution: { type: "string" }, health: { type: "string" } } } }),
    },
    "/api/health": {
      get: op("Sistema", "Saúde da API e do banco", null, { public: true, schema: { type: "object", properties: { status: { type: "string" }, database: { type: "string" } } } }),
    },
    "/api/openapi.json": {
      get: op("Sistema", "Especificação OpenAPI", null, { public: true }),
    },
    "/api/auth/login": {
      post: op("Autenticação", "Entrar", null, {
        public: true,
        validated: true,
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 1, maxLength: 72 },
          },
        },
        schema: {
          type: "object",
          properties: {
            token: { type: "string" },
            user: { type: "object", additionalProperties: true },
          },
        },
        responses: { 401: { description: "E-mail ou senha inválidos." }, 403: { description: "Acesso bloqueado." }, 429: { description: "Muitas tentativas." } },
      }),
    },
    "/api/auth/eu": { get: op("Autenticação", "Usuário da sessão", null) },
    "/api/auth/recuperar-senha": {
      post: op("Autenticação", "Pedir redefinição de senha", null, {
        public: true,
        validated: true,
        body: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } },
        schema: { type: "object", properties: { message: { type: "string" }, resetToken: { type: "string", description: "Presente fora de produção." } } },
      }),
    },
    "/api/auth/redefinir-senha": {
      post: op("Autenticação", "Redefinir senha com o token", null, {
        public: true,
        validated: true,
        body: {
          type: "object",
          required: ["token", "password"],
          properties: { token: { type: "string", minLength: 20 }, password: { type: "string", minLength: 8, maxLength: 72 } },
        },
        schema: message,
      }),
    },
    "/api/perfil": {
      get: op("Usuários", "Perfil da sessão", null),
      patch: op("Usuários", "Atualizar o próprio perfil", null, {
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 3, maxLength: 120 },
            sector: { type: "string", minLength: 2, maxLength: 80 },
            council: { type: "string", maxLength: 80, nullable: true },
          },
        },
      }),
    },
    "/api/perfil/senha": {
      patch: op("Usuários", "Trocar a própria senha", null, {
        body: {
          type: "object",
          required: ["currentPassword", "password"],
          properties: {
            currentPassword: { type: "string", minLength: 1, maxLength: 72 },
            password: { type: "string", minLength: 8, maxLength: 72 },
          },
        },
        schema: message,
      }),
    },
    "/api/usuarios": {
      get: op("Usuários", "Listar usuários", "usuarios.manage", { query: [...pageQuery, queryParam("q", { type: "string", maxLength: 80 })], schema: list }),
      post: op("Usuários", "Criar usuário", "usuarios.manage", {
        status: 201,
        conflict: true,
        body: {
          type: "object",
          required: ["name", "email", "password", "roleLabel", "sector", "profiles"],
          properties: {
            name: { type: "string", minLength: 3, maxLength: 120 },
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 8, maxLength: 72 },
            roleLabel: { type: "string", minLength: 2, maxLength: 80 },
            sector: { type: "string", minLength: 2, maxLength: 80 },
            council: { type: "string", maxLength: 80, nullable: true },
            profiles,
            active: { type: "boolean" },
          },
        },
      }),
    },
    "/api/usuarios/{id}": {
      get: op("Usuários", "Detalhe do usuário", "usuarios.manage", { params: [pathParam("id")], missing: true }),
      patch: op("Usuários", "Atualizar usuário", "usuarios.manage", {
        params: [pathParam("id")],
        missing: true,
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 3, maxLength: 120 },
            roleLabel: { type: "string", minLength: 2, maxLength: 80 },
            sector: { type: "string", minLength: 2, maxLength: 80 },
            council: { type: "string", maxLength: 80, nullable: true },
            profiles,
            active: { type: "boolean" },
            password: { type: "string", minLength: 8, maxLength: 72 },
          },
        },
      }),
    },
    "/api/prontuarios": {
      get: op("Prontuário", "Listar prontuários", "prontuario.view", {
        query: [
          ...pageQuery,
          queryParam("q", { type: "string", maxLength: 80 }),
          queryParam("status", { type: "string", enum: ["estavel", "observacao", "cuidado_especial", "hospital"] }),
          queryParam("wing", { type: "string", maxLength: 40 }),
          queryParam("tag", { type: "string", maxLength: 40 }),
        ],
        schema: list,
      }),
    },
    "/api/prontuarios/{patientId}": {
      get: op("Prontuário", "Detalhe do prontuário", "prontuario.view", { params: patient, missing: true }),
      patch: op("Prontuário", "Atualizar localização e status", "dados.edit", {
        params: patient,
        missing: true,
        body: {
          type: "object",
          properties: {
            treatment: { type: "string", minLength: 2, maxLength: 80 },
            wing: { type: "string", minLength: 2, maxLength: 40 },
            room: { type: "string", minLength: 1, maxLength: 10 },
            bed: { type: "string", enum: ["A", "B"] },
            status: { type: "string", enum: ["estavel", "observacao", "cuidado_especial", "hospital"] },
          },
        },
      }),
    },
    "/api/prontuarios/{patientId}/ficha": {
      get: op("Prontuário", "Exportar ficha", "ficha.export", { params: patient, missing: true }),
    },
    "/api/prontuarios/{patientId}/contatos": {
      post: op("Prontuário", "Adicionar contato", "dados.edit", {
        status: 201,
        params: patient,
        body: {
          type: "object",
          required: ["name", "relation", "phone"],
          properties: {
            name: { type: "string", minLength: 3, maxLength: 120 },
            relation: { type: "string", minLength: 2, maxLength: 40 },
            phone: { type: "string", minLength: 8, maxLength: 20 },
            isPrimary: { type: "boolean" },
          },
        },
      }),
    },
    "/api/prontuarios/{patientId}/contatos/{id}": {
      delete: op("Prontuário", "Remover contato", "dados.edit", { params: patientAndId, missing: true }),
    },
    "/api/prontuarios/{patientId}/evolucoes": {
      get: op("Prontuário", "Listar evoluções", "evolucao.view", { params: patient, schema: list }),
      post: op("Prontuário", "Registrar evolução", "evolucao.create", {
        status: 201,
        params: patient,
        body: { ...evolution, required: ["type", "title", "description"] },
      }),
    },
    "/api/prontuarios/{patientId}/evolucoes/{id}": {
      patch: op("Prontuário", "Editar rascunho de evolução", "evolucao.create", {
        params: patientAndId,
        missing: true,
        conflict: true,
        body: evolution,
      }),
    },
    "/api/prontuarios/{patientId}/evolucoes/{id}/finalizar": {
      post: op("Prontuário", "Finalizar evolução", "evolucao.create", { params: patientAndId, missing: true, conflict: true }),
    },
    "/api/prontuarios/{patientId}/evolucoes/{id}/corrigir": {
      post: op("Prontuário", "Corrigir evolução finalizada", "evolucao.correct", {
        params: patientAndId,
        missing: true,
        conflict: true,
        body: {
          type: "object",
          required: ["reason", "description"],
          properties: {
            reason: { type: "string", minLength: 5, maxLength: 500 },
            description: { type: "string", minLength: 10, maxLength: 8000 },
          },
        },
      }),
    },
    "/api/prontuarios/{patientId}/evolucoes/{id}/correcoes": {
      get: op("Prontuário", "Histórico de correções", "evolucao.view", { params: patientAndId, schema: list }),
    },
    "/api/prontuarios/{patientId}/sinais-vitais": {
      get: op("Prontuário", "Listar sinais vitais", "vitais.view", {
        params: patient,
        query: [queryParam("kind", { type: "string", enum: ["pa", "glicemia"] })],
        schema: list,
      }),
      post: op("Prontuário", "Registrar sinal vital", "vitais.create", {
        status: 201,
        params: patient,
        body: {
          type: "object",
          required: ["kind", "context"],
          properties: {
            kind: { type: "string", enum: ["pa", "glicemia"] },
            at: { type: "string", format: "date-time" },
            systolic: { type: "integer", minimum: 40, maximum: 250 },
            diastolic: { type: "integer", minimum: 20, maximum: 150 },
            pulse: { type: "integer", minimum: 30, maximum: 220 },
            glucose: { type: "integer", minimum: 20, maximum: 600 },
            context: { type: "string", minLength: 2, maxLength: 120 },
          },
        },
      }),
    },
    "/api/prontuarios/{patientId}/ocorrencias": {
      get: op("Prontuário", "Listar ocorrências", "ocorrencia.view", { params: patient, schema: list }),
      post: op("Prontuário", "Registrar ocorrência", "ocorrencia.create", {
        status: 201,
        params: patient,
        body: {
          type: "object",
          required: ["category", "title", "description", "responsibleId"],
          properties: {
            category: { type: "string", minLength: 2, maxLength: 60 },
            title: { type: "string", minLength: 3, maxLength: 160 },
            description: { type: "string", minLength: 10, maxLength: 4000 },
            at: { type: "string", format: "date-time" },
            responsibleId: ident,
            priority: { type: "string", enum: ["normal", "atencao"] },
          },
        },
      }),
    },
    "/api/prontuarios/{patientId}/ocorrencias/{id}/acompanhamentos": {
      post: op("Prontuário", "Acompanhar ocorrência", "ocorrencia.followup", {
        status: 201,
        params: patientAndId,
        conflict: true,
        body: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 5, maxLength: 2000 } } },
      }),
    },
    "/api/prontuarios/{patientId}/ocorrencias/{id}/encerrar": {
      post: op("Prontuário", "Encerrar ocorrência", "ocorrencia.close", {
        params: patientAndId,
        conflict: true,
        body: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 5, maxLength: 2000 },
            notes: { type: "string", maxLength: 2000 },
          },
        },
      }),
    },
    "/api/prontuarios/{patientId}/documentos": {
      get: op("Prontuário", "Listar documentos", "documento.view", { params: patient, schema: list }),
      post: op("Prontuário", "Enviar documento", "documento.upload", {
        status: 201,
        params: patient,
        multipart: {
          type: "object",
          required: ["arquivo", "type"],
          properties: {
            arquivo: { type: "string", format: "binary", description: "PDF, JPG, PNG ou DOCX, até 8 MB." },
            type: { type: "string", minLength: 2, maxLength: 80 },
            description: { type: "string" },
          },
        },
      }),
    },
    "/api/prontuarios/{patientId}/documentos/{id}/download": {
      get: op("Prontuário", "Baixar documento", "documento.download", { params: patientAndId, missing: true, binary: true }),
    },
    "/api/prontuarios/{patientId}/documentos/{id}/arquivar": {
      post: op("Prontuário", "Arquivar documento", "documento.archive", { params: patientAndId, missing: true }),
    },
    "/api/prontuarios/{patientId}/planos": {
      get: op("Prontuário", "Listar planos de cuidado", "plano.view", { params: patient, schema: list }),
      post: op("Prontuário", "Criar plano de cuidado", "plano.create", {
        status: 201,
        params: patient,
        body: {
          type: "object",
          required: ["title", "area", "objective", "responsibleId", "startDate", "actions"],
          properties: {
            title: { type: "string", minLength: 3, maxLength: 160 },
            area: { type: "string", minLength: 2, maxLength: 60 },
            objective: { type: "string", minLength: 10, maxLength: 2000 },
            responsibleId: ident,
            startDate: date,
            endDate: { ...date, nullable: true },
            status: { type: "string", enum: ["ativo", "encerrado", "futuro"] },
            actions: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                type: "object",
                required: ["title", "responsibleId", "frequency"],
                properties: {
                  title: { type: "string", minLength: 3, maxLength: 200 },
                  responsibleId: ident,
                  frequency: { type: "string", minLength: 2, maxLength: 40 },
                },
              },
            },
          },
        },
      }),
    },
    "/api/prontuarios/{patientId}/planos/{id}/atualizacoes": {
      post: op("Prontuário", "Registrar atualização do plano", "plano.edit", {
        status: 201,
        params: patientAndId,
        missing: true,
        body: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 5, maxLength: 2000 } } },
      }),
    },
    "/api/pae/modelos": {
      get: op("PAE", "Listar modelos", "pae.template.view", { schema: list }),
      post: op("PAE", "Criar modelo", "pae.template.manage", {
        status: 201,
        body: {
          type: "object",
          required: ["name", "description", "responsibleIds", "fields", "actions"],
          properties: {
            name: { type: "string", minLength: 3, maxLength: 160 },
            description: { type: "string", minLength: 10, maxLength: 2000 },
            responsibleIds: { type: "array", minItems: 1, items: ident },
            fields: {
              type: "array",
              minItems: 1,
              maxItems: 30,
              items: {
                type: "object",
                required: ["label", "fieldType"],
                properties: {
                  label: { type: "string", minLength: 2, maxLength: 160 },
                  fieldType: { type: "string", enum: ["texto", "texto_longo", "selecao", "sim_nao", "numero", "data"] },
                  required: { type: "boolean" },
                  options: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 80 } },
                },
              },
            },
            actions: {
              type: "array",
              minItems: 1,
              maxItems: 30,
              items: {
                type: "object",
                required: ["title", "roleLabel"],
                properties: {
                  title: { type: "string", minLength: 3, maxLength: 200 },
                  roleLabel: { type: "string", minLength: 2, maxLength: 80 },
                },
              },
            },
          },
        },
      }),
    },
    "/api/pae/modelos/{id}": {
      get: op("PAE", "Detalhe do modelo", "pae.template.view", { params: [pathParam("id")], missing: true }),
    },
    "/api/pae": {
      get: op("PAE", "Listar PAE", "pae.view", { query: [queryParam("patientId", ident)], schema: list }),
      post: op("PAE", "Abrir PAE", "pae.create", {
        status: 201,
        body: {
          type: "object",
          required: ["patientId", "templateId", "responsibleId", "startDate", "values"],
          properties: {
            patientId: ident,
            templateId: ident,
            responsibleId: ident,
            startDate: date,
            reviewDate: date,
            values: { type: "object", additionalProperties: { type: "string", maxLength: 2000 } },
          },
        },
      }),
    },
    "/api/pae/{id}": {
      get: op("PAE", "Detalhe do PAE", "pae.view", { params: [pathParam("id")], missing: true }),
    },
    "/api/pae/{id}/acoes/{actionId}/executar": {
      post: op("PAE", "Executar ação", "pae.execute", {
        params: [pathParam("id"), pathParam("actionId")],
        conflict: true,
        body: { type: "object", properties: { notes: { type: "string", maxLength: 2000 } } },
      }),
    },
    "/api/pae/{id}/revisar": {
      post: op("PAE", "Revisar PAE", "pae.review", {
        params: [pathParam("id")],
        conflict: true,
        body: { type: "object", required: ["reviewDate"], properties: { reviewDate: date } },
      }),
    },
    "/api/pop": {
      get: op("POP", "Listar POP", "pop.view", { schema: list }),
      post: op("POP", "Criar POP", "pop.manage", { status: 201, conflict: true, body: popBody }),
    },
    "/api/pop/{id}": {
      get: op("POP", "Detalhe do POP", "pop.view", { params: [pathParam("id")], missing: true }),
    },
    "/api/pop/{id}/versoes": {
      post: op("POP", "Publicar nova versão", "pop.manage", {
        status: 201,
        params: [pathParam("id")],
        conflict: true,
        body: {
          ...popBody,
          required: ["title", "category", "purpose", "validFrom", "validUntil", "sections", "summary"],
        },
      }),
    },
    "/api/farmacia/medicamentos": {
      get: op("Farmácia", "Listar medicamentos", "modulo.farmacia", { schema: list }),
      post: op("Farmácia", "Cadastrar medicamento", "estoque.manage", {
        status: 201,
        body: {
          type: "object",
          required: ["name", "activeIngredient", "form", "strength", "unit", "minQty", "location"],
          properties: {
            name: { type: "string", minLength: 2, maxLength: 160 },
            activeIngredient: { type: "string", minLength: 2, maxLength: 160 },
            form: { type: "string", minLength: 2, maxLength: 80 },
            strength: { type: "string", minLength: 1, maxLength: 40 },
            unit: { type: "string", minLength: 1, maxLength: 30 },
            minQty: { type: "integer", minimum: 0, maximum: 1000000 },
            location: { type: "string", minLength: 2, maxLength: 80 },
            coldChain: { type: "boolean" },
          },
        },
      }),
    },
    "/api/farmacia/medicamentos/{id}": {
      get: op("Farmácia", "Detalhe do medicamento", "modulo.farmacia", { params: [pathParam("id")], missing: true }),
    },
    "/api/farmacia/medicamentos/{id}/lotes": {
      post: op("Farmácia", "Entrada de lote", "estoque.manage", {
        status: 201,
        params: [pathParam("id")],
        body: {
          type: "object",
          required: ["code", "expiry", "qty", "supplier"],
          properties: {
            code: { type: "string", minLength: 2, maxLength: 40 },
            expiry: date,
            qty: { type: "integer", minimum: 1, maximum: 1000000 },
            supplier: { type: "string", minLength: 2, maxLength: 120 },
          },
        },
      }),
    },
    "/api/farmacia/prescricoes": {
      get: op("Farmácia", "Listar prescrições", "modulo.farmacia", { query: [queryParam("patientId", ident)], schema: list }),
      post: op("Farmácia", "Prescrever", "farmacia.prescrever", {
        status: 201,
        body: {
          type: "object",
          required: ["patientId", "medicationId", "dose", "route", "frequency", "startDate"],
          properties: {
            patientId: ident,
            medicationId: ident,
            dose: { type: "string", minLength: 1, maxLength: 80 },
            route: { type: "string", minLength: 2, maxLength: 40 },
            frequency: { type: "string", minLength: 2, maxLength: 80 },
            instructions: { type: "string", maxLength: 500, nullable: true },
            startDate: date,
            endDate: { ...date, nullable: true },
          },
        },
      }),
    },
    "/api/farmacia/prescricoes/{id}": {
      patch: op("Farmácia", "Alterar status da prescrição", "farmacia.prescrever", {
        params: [pathParam("id")],
        body: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["vigente", "suspensa", "encerrada"] } } },
      }),
    },
    "/api/farmacia/administracoes": {
      get: op("Farmácia", "Listar administrações", "modulo.farmacia", { schema: list }),
      post: op("Farmácia", "Registrar administração", "farmacia.administrar", {
        status: 201,
        conflict: true,
        body: {
          type: "object",
          required: ["prescriptionId", "scheduledAt", "status"],
          properties: {
            prescriptionId: ident,
            scheduledAt: { type: "string", format: "date-time" },
            status: { type: "string", enum: ["administrado", "recusado", "nao_administrado", "atrasado"] },
            notes: { type: "string", maxLength: 500 },
          },
        },
      }),
    },
    "/api/farmacia/dispensacoes": {
      get: op("Farmácia", "Listar dispensações", "modulo.farmacia", { schema: list }),
      post: op("Farmácia", "Dispensar lote", "farmacia.dispensar", {
        status: 201,
        body: {
          type: "object",
          required: ["lotId", "qty"],
          properties: {
            lotId: ident,
            patientId: ident,
            qty: { type: "integer", minimum: 1, maximum: 100000 },
            notes: { type: "string", maxLength: 500 },
          },
        },
      }),
    },
    "/api/estoque/itens": {
      get: op("Estoque", "Listar itens", "modulo.estoque", { schema: list }),
      post: op("Estoque", "Cadastrar item", "estoque.manage", {
        status: 201,
        body: {
          type: "object",
          required: ["name", "category", "unit", "minQty", "location"],
          properties: {
            name: { type: "string", minLength: 2, maxLength: 160 },
            category: { type: "string", minLength: 2, maxLength: 60 },
            unit: { type: "string", minLength: 1, maxLength: 30 },
            minQty: { type: "integer", minimum: 0, maximum: 1000000 },
            location: { type: "string", minLength: 2, maxLength: 80 },
            qty: { type: "integer", minimum: 0, maximum: 1000000 },
          },
        },
      }),
    },
    "/api/estoque/movimentacoes": {
      get: op("Estoque", "Listar movimentações", "modulo.estoque", { schema: list }),
      post: op("Estoque", "Entrada ou saída", "estoque.movimentar", {
        status: 201,
        body: {
          type: "object",
          required: ["itemId", "type", "qty", "reason"],
          properties: {
            itemId: ident,
            type: { type: "string", enum: ["entrada", "saida"] },
            qty: { type: "integer", minimum: 1, maximum: 100000 },
            reason: { type: "string", minLength: 3, maxLength: 200 },
          },
        },
      }),
    },
    "/api/estoque/inventarios": {
      post: op("Estoque", "Fechar inventário", "estoque.inventario", {
        status: 201,
        body: {
          type: "object",
          required: ["lines"],
          properties: {
            notes: { type: "string", maxLength: 500 },
            lines: {
              type: "array",
              minItems: 1,
              maxItems: 200,
              items: {
                type: "object",
                required: ["itemId", "countedQty"],
                properties: {
                  itemId: ident,
                  countedQty: { type: "integer", minimum: 0, maximum: 1000000 },
                },
              },
            },
          },
        },
      }),
    },
    "/api/estoque/reposicoes": {
      get: op("Estoque", "Listar reposições", "modulo.estoque", { schema: list }),
      post: op("Estoque", "Solicitar reposição", "estoque.repor.solicitar", {
        status: 201,
        body: {
          type: "object",
          required: ["itemId", "qty"],
          properties: {
            itemId: ident,
            qty: { type: "integer", minimum: 1, maximum: 100000 },
            notes: { type: "string", maxLength: 500 },
          },
        },
      }),
    },
    "/api/estoque/reposicoes/{id}/aprovar": {
      post: op("Estoque", "Aprovar reposição", "estoque.repor.aprovar", { params: [pathParam("id")], conflict: true }),
    },
    "/api/estoque/reposicoes/{id}/recusar": {
      post: op("Estoque", "Recusar reposição", "estoque.repor.aprovar", { params: [pathParam("id")], conflict: true }),
    },
    "/api/estoque/reposicoes/{id}/receber": {
      post: op("Estoque", "Receber reposição", "estoque.manage", { params: [pathParam("id")], conflict: true }),
    },
    "/api/temperatura/equipamentos": {
      get: op("Temperatura", "Listar equipamentos", "modulo.temperatura", { schema: list }),
      post: op("Temperatura", "Cadastrar equipamento", "temperatura.manage", {
        status: 201,
        body: {
          type: "object",
          required: ["name", "location", "kind", "minTemp", "maxTemp"],
          properties: {
            name: { type: "string", minLength: 2, maxLength: 120 },
            location: { type: "string", minLength: 2, maxLength: 80 },
            kind: { type: "string", enum: ["geladeira", "ambiente", "freezer"] },
            minTemp: { type: "number", minimum: -50, maximum: 60 },
            maxTemp: { type: "number", minimum: -50, maximum: 60 },
          },
        },
      }),
    },
    "/api/temperatura/equipamentos/{id}": {
      get: op("Temperatura", "Detalhe do equipamento", "modulo.temperatura", { params: [pathParam("id")], missing: true }),
    },
    "/api/temperatura/equipamentos/{id}/sensores": {
      post: op("Temperatura", "Cadastrar sensor", "temperatura.manage", {
        status: 201,
        params: [pathParam("id")],
        body: { type: "object", required: ["code"], properties: { code: { type: "string", minLength: 2, maxLength: 40 } } },
      }),
    },
    "/api/temperatura/alertas": {
      get: op("Temperatura", "Listar alertas", "temperatura.alertas", {
        query: [queryParam("status", { type: "string", enum: ["aberto", "resolvido"] })],
        schema: list,
      }),
    },
    "/api/temperatura/alertas/{id}/resolver": {
      post: op("Temperatura", "Resolver alerta", "temperatura.alertas", { params: [pathParam("id")], conflict: true }),
    },
    "/api/temperatura/leituras": {
      post: op("Temperatura", "Registrar leitura", "temperatura.registrar", {
        status: 201,
        body: {
          type: "object",
          required: ["equipmentId", "value"],
          properties: {
            equipmentId: ident,
            sensorId: ident,
            value: { type: "number", minimum: -50, maximum: 60 },
            at: { type: "string", format: "date-time" },
          },
        },
        schema: {
          type: "object",
          properties: {
            reading: entity,
            alert: { nullable: true, allOf: [entity] },
          },
        },
      }),
    },
    "/api/modulos": { get: op("Operação", "Módulos visíveis ao perfil", null, { schema: list }) },
    "/api/modulos/{id}": { get: op("Operação", "Detalhe do módulo", null, { params: [pathParam("id")], missing: true }) },
    "/api/dashboard": { get: op("Operação", "Indicadores", "modulo.dashboard") },
    "/api/notificacoes": { get: op("Operação", "Listar notificações", null, { schema: list }) },
    "/api/notificacoes/{id}/ler": { post: op("Operação", "Marcar notificação como lida", null, { params: [pathParam("id")], missing: true }) },
    "/api/funcionarios": { get: op("Operação", "Listar equipe", "modulo.funcionarios", { schema: list }) },
    "/api/agenda": {
      get: op("Operação", "Listar agenda", "modulo.agenda", { schema: list }),
      post: op("Operação", "Agendar", "modulo.agenda", {
        status: 201,
        body: {
          type: "object",
          required: ["title", "professionalId", "startsAt", "endsAt", "kind"],
          properties: {
            title: { type: "string", minLength: 3, maxLength: 160 },
            patientId: { ...ident, nullable: true },
            professionalId: ident,
            startsAt: { type: "string", format: "date-time" },
            endsAt: { type: "string", format: "date-time" },
            kind: { type: "string", minLength: 2, maxLength: 40 },
            notes: { type: "string", maxLength: 1000 },
          },
        },
      }),
    },
    "/api/visitas": {
      get: op("Operação", "Listar visitas", "modulo.visitas", { schema: list }),
      post: op("Operação", "Registrar visita", "modulo.visitas", {
        status: 201,
        body: {
          type: "object",
          required: ["patientId", "visitorName", "relation"],
          properties: {
            patientId: ident,
            visitorName: { type: "string", minLength: 3, maxLength: 120 },
            relation: { type: "string", minLength: 2, maxLength: 40 },
            document: { type: "string", maxLength: 40 },
            arrivedAt: { type: "string", format: "date-time" },
            notes: { type: "string", maxLength: 500 },
          },
        },
      }),
    },
    "/api/visitas/{id}/saida": {
      patch: op("Operação", "Registrar saída da visita", "modulo.visitas", { params: [pathParam("id")], conflict: true }),
    },
    "/api/emergencias": {
      get: op("Operação", "Listar emergências", "modulo.emergencias", { schema: list }),
      post: op("Operação", "Abrir emergência", "modulo.emergencias", {
        status: 201,
        body: {
          type: "object",
          required: ["kind", "description"],
          properties: {
            patientId: { ...ident, nullable: true },
            kind: { type: "string", minLength: 2, maxLength: 60 },
            description: { type: "string", minLength: 10, maxLength: 2000 },
          },
        },
      }),
    },
    "/api/emergencias/{id}": {
      patch: op("Operação", "Atualizar emergência", "modulo.emergencias", {
        params: [pathParam("id")],
        conflict: true,
        body: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["aberta", "em_atendimento", "encerrada"] } } },
      }),
    },
    "/api/atendimentos": {
      get: op("Operação", "Listar atendimentos do perfil", null, { schema: list }),
      post: op("Operação", "Registrar atendimento", null, {
        status: 201,
        body: {
          type: "object",
          required: ["patientId", "specialty", "at", "summary"],
          properties: {
            patientId: ident,
            specialty: { type: "string", enum: ["fisioterapia", "medicina", "odontologia", "psicologia", "nutricao"] },
            at: { type: "string", format: "date-time" },
            summary: { type: "string", minLength: 10, maxLength: 4000 },
            status: { type: "string", enum: ["rascunho", "finalizado"] },
          },
        },
      }),
    },
    "/api/relatorios/ocupacao": { get: op("Operação", "Ocupação por ala", "modulo.relatorios", { schema: list }) },
    "/api/relatorios/ocorrencias": { get: op("Operação", "Ocorrências por status", "modulo.relatorios", { schema: list }) },
    "/api/relatorios/estoque": { get: op("Operação", "Estoque baixo e lotes vencidos", "modulo.relatorios") },
    "/api/importacoes": {
      get: op("Operação", "Listar importações", "dados.import", { schema: list }),
      post: op("Operação", "Importar moradores por CSV", "dados.import", {
        status: 201,
        multipart: {
          type: "object",
          required: ["arquivo"],
          properties: {
            arquivo: { type: "string", format: "binary", description: "CSV até 2 MB. Cabeçalho: nome;sexo;nascimento;ala;quarto;leito." },
          },
        },
      }),
    },
  },
};

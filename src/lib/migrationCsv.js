import { HttpError } from "./httpError.js";

export const MIGRATION_COLUMNS = [
  "nome", "sexo", "nascimento", "ala", "quarto", "leito",
  "admissao", "identificador_origem", "dados_clinicos", "contatos",
];
export const REQUIRED_MIGRATION_COLUMNS = MIGRATION_COLUMNS.slice(0, 6);

function calendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseCells(content, delimiter) {
  const rows = [];
  let cells = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;
  let line = 1;
  let startLine = 1;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (char === '"') {
      if (quoted && content[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (quoted) {
        quoted = false;
        closedQuote = true;
      } else if (cell === "" && !closedQuote) {
        quoted = true;
      } else {
        throw new HttpError(422, `Aspas inválidas na linha ${line}.`);
      }
      continue;
    }
    if (!quoted && char === delimiter) {
      cells.push(cell.trim());
      cell = "";
      closedQuote = false;
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (quoted) {
        cell += "\n";
        if (char === "\r" && content[i + 1] === "\n") i += 1;
        line += 1;
        continue;
      }
      cells.push(cell.trim());
      rows.push({ lineNumber: startLine, cells });
      cells = [];
      cell = "";
      closedQuote = false;
      if (char === "\r" && content[i + 1] === "\n") i += 1;
      line += 1;
      startLine = line;
      continue;
    }
    if (closedQuote && !quoted) {
      if (/\s/.test(char)) continue;
      throw new HttpError(422, `Texto após aspas na linha ${line}.`);
    }
    cell += char;
  }
  if (quoted) throw new HttpError(422, "Arquivo CSV com aspas não fechadas.");
  cells.push(cell.trim());
  if (cells.some(Boolean)) rows.push({ lineNumber: startLine, cells });
  return rows;
}

export function parseMigrationCsv(buffer) {
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, "");
  } catch {
    throw new HttpError(422, "O arquivo deve estar em UTF-8.");
  }
  if (content.includes("\u0000")) throw new HttpError(422, "Arquivo CSV contém caracteres inválidos.");
  const headerLine = content.split(/\r?\n/, 1)[0];
  const delimiter = headerLine.includes(";") ? ";" : ",";
  const rows = parseCells(content, delimiter);
  if (rows.length < 2) throw new HttpError(422, "Planilha sem dados.");
  const header = rows[0].cells.map((name) => name.toLowerCase());
  const missing = REQUIRED_MIGRATION_COLUMNS.filter((name) => !header.includes(name));
  const unknown = header.filter((name) => !MIGRATION_COLUMNS.includes(name));
  if (missing.length || unknown.length || new Set(header).size !== header.length) {
    throw new HttpError(422, `Cabeçalho inválido. Obrigatórios: ${REQUIRED_MIGRATION_COLUMNS.join(", ")}; opcionais: ${MIGRATION_COLUMNS.slice(6).join(", ")}.`);
  }
  if (rows.length > 5001) throw new HttpError(422, "O lote aceita até 5.000 linhas.");
  return rows.slice(1).map(({ lineNumber, cells }) => {
    const data = Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""]));
    if (cells.length !== header.length) data.__columnError = true;
    return { lineNumber, data };
  });
}

function parseJsonArray(value, column, errors) {
  if (!value) return [];
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    errors.push(`${column} deve conter JSON válido`);
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length > 100) {
    errors.push(`${column} deve ser lista de até 100 itens`);
    return [];
  }
  return parsed;
}

export function validateMigrationRow(input, today = new Date().toISOString().slice(0, 10)) {
  const data = Object.fromEntries(MIGRATION_COLUMNS.map((name) => [name, String(input[name] ?? "").trim()]));
  const errors = [];
  if (input.__columnError) errors.push("número de colunas diferente do cabeçalho");
  if (data.nome.length < 3 || data.nome.length > 160) errors.push("nome deve ter entre 3 e 160 caracteres");
  if (!["F", "M"].includes(data.sexo)) errors.push("sexo deve ser F ou M");
  if (!calendarDate(data.nascimento) || data.nascimento > today) errors.push("nascimento inválido ou futuro");
  if (data.admissao && (!calendarDate(data.admissao) || data.admissao > today)) errors.push("admissao inválida ou futura");
  if (data.admissao && calendarDate(data.nascimento) && data.admissao < data.nascimento) errors.push("admissao anterior ao nascimento");
  if (data.ala.length < 2 || data.ala.length > 60) errors.push("ala deve ter entre 2 e 60 caracteres");
  if (data.quarto.length < 1 || data.quarto.length > 20) errors.push("quarto obrigatório, até 20 caracteres");
  if (data.leito.length < 1 || data.leito.length > 20) errors.push("leito obrigatório, até 20 caracteres");
  if (data.identificador_origem.length > 120) errors.push("identificador_origem acima de 120 caracteres");

  const careFields = parseJsonArray(input.dados_clinicos, "dados_clinicos", errors);
  const sections = new Map();
  for (const field of careFields) {
    if (!field || typeof field !== "object"
      || typeof field.sectionId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(field.sectionId)
      || typeof field.sectionTitle !== "string" || field.sectionTitle.trim().length < 2 || field.sectionTitle.length > 100
      || typeof field.label !== "string" || field.label.trim().length < 2 || field.label.length > 100
      || typeof field.value !== "string" || field.value.trim().length < 1 || field.value.length > 2000) {
      errors.push("dados_clinicos contém campo fora do modelo clínico");
      break;
    }
    const section = sections.get(field.sectionId) ?? { title: field.sectionTitle, labels: new Set(), count: 0 };
    const label = field.label.trim().toLocaleLowerCase("pt-BR");
    if (section.title !== field.sectionTitle || section.labels.has(label) || section.count >= 30) {
      errors.push("dados_clinicos contém seção ou campo duplicado/inconsistente");
      break;
    }
    section.labels.add(label);
    section.count += 1;
    sections.set(field.sectionId, section);
  }
  if (sections.size > 12) errors.push("dados_clinicos aceita até 12 seções");
  const contacts = parseJsonArray(input.contatos, "contatos", errors);
  if (contacts.length > 20) errors.push("contatos aceita até 20 pessoas");
  let primaryCount = 0;
  for (const contact of contacts) {
    if (!contact || typeof contact !== "object"
      || typeof contact.name !== "string" || contact.name.trim().length < 2 || contact.name.length > 120
      || typeof contact.relation !== "string" || contact.relation.trim().length < 2 || contact.relation.length > 80
      || typeof contact.phone !== "string" || contact.phone.trim().length < 7 || contact.phone.length > 30
      || (contact.priority !== undefined && (!Number.isInteger(contact.priority) || contact.priority < 1 || contact.priority > 99))
      || (contact.isPrimary !== undefined && typeof contact.isPrimary !== "boolean")
      || (contact.notes !== undefined && (typeof contact.notes !== "string" || contact.notes.length > 1000))) {
      errors.push("contatos contém item inválido");
      break;
    }
    if (contact.isPrimary === true) primaryCount += 1;
  }
  if (primaryCount > 1) errors.push("apenas um contato pode ser principal");
  return { data, errors, careFields, contacts };
}

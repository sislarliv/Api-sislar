import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const WINGS = ["Ala Ipê", "Ala Jacarandá", "Ala Girassol"];
const RELATIVES = ["Renato", "Cláudia", "Fábio", "Sandra", "Marcelo", "Adriana", "Rodrigo", "Simone", "Leandro", "Patrícia", "Gustavo", "Vera"];
const PARTICLES = new Set(["da", "de", "do", "das", "dos", "D’Arc"]);

function pad(value, size = 2) {
  return String(value).padStart(size, "0");
}

function isoDate(date) {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  return `${year}-${month}-${day}`;
}

function lastToken(name) {
  const parts = name.split(" ");
  return parts[parts.length - 1];
}

function phone(prefix, seed) {
  return `(11) 9${String(prefix).padStart(4, "0")}-${String(seed)}`;
}

export async function loadNames() {
  const path = fileURLToPath(new URL("./data/moradores.json", import.meta.url));
  return JSON.parse(await readFile(path, "utf8"));
}

export function buildPatients(names) {
  return names.map(([name, sex], t) => {
    const first = name.split(" ")[0];
    const treatment = `${sex === "F" ? "Dona" : "Seu"} ${first}`;
    const birth = new Date(1930 + (t * 7) % 27, (t * 5) % 12, 1 + (t * 11) % 27);
    const admission = new Date(2016 + (t % 10), (t * 3) % 12, 1 + (t * 7) % 26);
    if (t >= 47) admission.setFullYear(2026, 8 - (t - 47), 5 + (t - 47));

    const wingIndex = Math.floor(t / 18);
    const slot = t % 18;
    const room = String((wingIndex + 1) * 100 + Math.floor(slot / 2) + 1);
    const bed = slot % 2 ? "B" : "A";

    let status = "estavel";
    if (t % 11 === 3) status = "observacao";
    if (t % 17 === 5) status = "cuidado_especial";
    if (t === 9) status = "hospital";

    const tags = [];
    if (t % 4 === 1) tags.push("diabetes");
    if (t % 3 !== 0) tags.push("hipertensao");
    if (t >= 47) tags.push("novo_morador");
    if (t % 13 === 7) tags.push("sem_registro_recente");

    const alerts = [];
    if (t % 6 === 0) {
      alerts.push({
        id: `al-${pad(t + 1)}`,
        label: "Alergia registrada: dipirona",
        kind: "alergia",
        detail: "Informação cadastrada pela instituição. Confirme na ficha original.",
      });
    }
    if (t % 3 === 1) alerts.push({ id: `mo-${pad(t + 1)}`, label: "Risco de queda: acompanhar deambulação", kind: "mobilidade", detail: null });
    if (t % 5 === 2) alerts.push({ id: `ali-${pad(t + 1)}`, label: "Dieta pastosa conforme nutrição", kind: "alimentacao", detail: null });
    if (t % 7 === 4) alerts.push({ id: `co-${pad(t + 1)}`, label: "Prefere ser chamado(a) pelo primeiro nome", kind: "comportamento", detail: null });
    if (t % 9 === 2) alerts.push({ id: `ou-${pad(t + 1)}`, label: "Usa óculos e aparelho auditivo", kind: "outro", detail: null });

    const surname = lastToken(name);
    const surnamePart = PARTICLES.has(surname) ? "" : surname;
    const contacts = [
      {
        name: `${RELATIVES[t % RELATIVES.length]} ${surnamePart}`.trim(),
        relation: sex === "F" ? (t % 2 ? "Filho" : "Filha") : t % 2 ? "Filha" : "Filho",
        phone: phone(4000 + (t * 137) % 5999, 1000 + (t * 251) % 8999),
        isPrimary: true,
      },
    ];
    if (t % 3 !== 2) {
      contacts.push({
        name: `${RELATIVES[(t + 5) % RELATIVES.length]} ${surname}`,
        relation: t % 2 ? "Sobrinha" : "Neto",
        phone: phone(5000 + (t * 97) % 4999, 2000 + (t * 173) % 7999),
        isPrimary: false,
      });
    }

    const device = t % 3 === 1 ? "Andador" : t % 8 === 4 ? "Cadeira de rodas" : t % 5 === 0 ? "Bengala" : "Sem dispositivo de apoio";
    const care = [
      ["identificacao", "Identificação assistencial", [
        ["Data de acolhimento", admission.toLocaleDateString("pt-BR")],
        ["Procedência", t % 2 ? "Residência familiar" : "Outra instituição"],
        ["Estado civil", sex === "F" ? (t % 3 ? "Viúva" : "Casada") : t % 3 ? "Viúvo" : "Casado"],
        ["Responsável legal", contacts[0].name],
      ]],
      ["mobilidade", "Mobilidade e autonomia", [
        ["Deambulação", device === "Cadeira de rodas" ? "Locomove-se em cadeira de rodas" : "Deambula com supervisão"],
        ["Dispositivo de apoio", device],
        ["Banho", t % 4 === 0 ? "Autônomo(a), com supervisão" : "Com auxílio da equipe"],
        ["Transferências", device === "Cadeira de rodas" ? "Auxílio de duas pessoas" : "Auxílio de uma pessoa"],
      ]],
      ["alimentacao", "Alimentação e hidratação", [
        ["Tipo de dieta", t % 5 === 2 ? "Pastosa (conforme nutrição)" : "Geral (conforme nutrição)"],
        ["Aceitação habitual", t % 6 === 3 ? "Parcial, estimular" : "Boa"],
        ["Preferências", ["Café com leite", "Frutas picadas", "Sopa no jantar", "Chá de camomila"][t % 4]],
        ["Restrições informadas", t % 6 === 0 ? "Ver alertas do cadastro" : "Nenhuma informada"],
      ]],
      ["rotina", "Rotina, comunicação e preferências", [
        ["Sono", t % 4 === 2 ? "Costuma acordar durante a madrugada" : "Dorme bem, acorda por volta das 6h"],
        ["Comunicação", t % 9 === 2 ? "Fala pausada, usa aparelho auditivo" : "Comunica-se bem"],
        ["Atividades preferidas", ["Roda de música", "Jardinagem", "Bingo", "Leitura", "Missa na capela"][t % 5]],
        ["Observações da equipe", "Campo configurável pela instituição."],
      ]],
    ];

    let sort = 0;
    const careFields = care.flatMap(([sectionId, sectionTitle, fields]) =>
      fields.map(([label, value]) => ({
        sectionId,
        sectionTitle,
        label,
        value,
        sortOrder: sort++,
      })),
    );

    return {
      id: `p${pad(t + 1)}`,
      code: `LIV-${String(1001 + t)}`,
      name,
      treatment,
      sex,
      birthDate: isoDate(birth),
      admissionDate: isoDate(admission),
      wing: WINGS[wingIndex],
      room,
      bed,
      status,
      tags,
      alerts,
      contacts,
      careFields,
      index: t,
    };
  });
}

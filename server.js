// Escolha de OM - Eng EsAO
// Servidor Node.js sem dependências externas (apenas módulos nativos).
// - API JSON + Server-Sent Events (tempo real)
// - Persistência em arquivo JSON (gravação atômica)
// - Node é single-thread: cada escolha é validada e gravada sem "await" no meio,
//   então duas escolhas simultâneas nunca se sobrepõem.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_SENHA = process.env.ADMIN_SENHA || '8769';
// No Railway, o volume é detectado sozinho (variável RAILWAY_VOLUME_MOUNT_PATH)
const DATA_FILE = process.env.DATA_FILE
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH && path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'db.json'))
  || path.join(__dirname, 'data', 'db.json');
// Aceita o index.html dentro de /public ou solto na raiz (caso o upload tenha perdido a pasta)
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) console.error('ATENÇÃO: index.html não encontrado. Envie a pasta public com o index.html.');

// ---------------------------------------------------------------- dados
let db;

function novoId() { return crypto.randomBytes(6).toString('hex'); }

function seed() {
  const locais = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-locais.json'), 'utf8'))
    .map(([om, cidade, vagas]) => ({ id: novoId(), om, cidade, vagas }));
  // Classificação geral, na ordem (arquivo seed-militares.json)
  const usuarios = [];
  for (const nome of JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-militares.json'), 'utf8'))) {
    usuarios.push({ id: novoId(), nome, senha: gerarSenha(usuarios) });
  }
  return { locais, usuarios, alocacoes: [], vinculos: [], pausado: true, preferencias: {}, planilha: null };
}

function carregar() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db.vinculos = db.vinculos || []; // bancos antigos não tinham vagas fixas
    db.preferencias = db.preferencias || {};
    db.planilha = db.planilha || null;
    db.aberturaProgramada = db.aberturaProgramada || null;
    if (db.backupMarco === undefined) db.backupMarco = Math.floor(db.alocacoes.length / A_CADA) * A_CADA;
    marcarVez();
  } catch {
    db = seed();
    salvar();
    console.log('Banco criado com dados iniciais. Senhas de exemplo:');
    db.usuarios.forEach(u => console.log(`  ${u.nome}: ${u.senha}`));
  }
}

function salvar() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------------------------------------------------------------- backups automáticos
// Uma cópia do banco a cada 10 escolhas (vagas fixas não contam; o reset zera a
// contagem) e outra quando a escolha termina. Ficam em backups/, ao lado do db.json
// (no Railway, no volume), as MAX_BACKUPS mais recentes. Cada arquivo: { motivo, ts, db }.
const PASTA_BACKUPS = path.join(path.dirname(DATA_FILE), 'backups');
const MAX_BACKUPS = 50;
const A_CADA = 10;
const NOME_BACKUP = /^db-\d{15}\.json$/;
let indiceBackups = null; // índice em memória: [{ arquivo, motivo, ts, escolhas }], mais novo primeiro

// Chamada a cada mudança: decide se é hora de guardar uma cópia.
// db.backupMarco = último múltiplo de 10 já guardado; db.backupFinal = cópia do fim já feita.
function verificarBackup() {
  const n = db.alocacoes.length;
  const marco = Math.floor(n / A_CADA) * A_CADA;
  if (marco < (db.backupMarco || 0)) db.backupMarco = marco; // reset ou escolhas desfeitas: volta a contar dali
  if (marco > (db.backupMarco || 0)) { db.backupMarco = marco; backup(`${marco} escolhas`); }
  const fim = n > 0 && (pendentes().length === 0 || totalRestante() === 0);
  if (fim && !db.backupFinal) {
    db.backupFinal = true;
    backup(totalRestante() === 0 ? 'Escolha encerrada: todas as vagas preenchidas' : 'Escolha encerrada: todos os militares alocados');
  }
  if (!fim) db.backupFinal = false;
}

function lerIndiceBackups() {
  if (indiceBackups) return indiceBackups;
  indiceBackups = [];
  try {
    for (const arquivo of fs.readdirSync(PASTA_BACKUPS).filter(f => NOME_BACKUP.test(f)).sort().reverse()) {
      try {
        const b = JSON.parse(fs.readFileSync(path.join(PASTA_BACKUPS, arquivo), 'utf8'));
        indiceBackups.push({ arquivo, motivo: b.motivo, ts: b.ts, escolhas: b.db?.alocacoes?.length ?? 0 });
      } catch {}
    }
  } catch {}
  return indiceBackups;
}

function backup(motivo) {
  try {
    lerIndiceBackups();
    fs.mkdirSync(PASTA_BACKUPS, { recursive: true });
    let ts = Date.now();
    while (fs.existsSync(path.join(PASTA_BACKUPS, `db-${String(ts).padStart(15, '0')}.json`))) ts++;
    const arquivo = `db-${String(ts).padStart(15, '0')}.json`;
    fs.writeFileSync(path.join(PASTA_BACKUPS, arquivo), JSON.stringify({ motivo, ts, db }));
    const indice = indiceBackups;
    indice.unshift({ arquivo, motivo, ts, escolhas: db.alocacoes.length });
    for (const velho of indice.splice(MAX_BACKUPS)) fs.rmSync(path.join(PASTA_BACKUPS, velho.arquivo), { force: true });
  } catch (e) { console.error('Falha no backup automático:', e.message); }
}

// Substitui os dados atuais pelos de um backup; devolve uma mensagem de erro ou null.
function restaurarDados(d) {
  if (!d || !Array.isArray(d.locais) || !Array.isArray(d.usuarios) || !Array.isArray(d.alocacoes)) return 'Arquivo de backup inválido.';
  db = { locais: d.locais, usuarios: d.usuarios, alocacoes: d.alocacoes, vinculos: Array.isArray(d.vinculos) ? d.vinculos : [], pausado: true, aberturaProgramada: null,
    preferencias: d.preferencias && typeof d.preferencias === 'object' ? d.preferencias : {}, planilha: d.planilha || null,
    backupMarco: Math.floor(d.alocacoes.length / A_CADA) * A_CADA, backupFinal: !!d.backupFinal };
  return null;
}

function gerarSenha(lista = db.usuarios) {
  const usadas = new Set(lista.map(u => u.senha));
  if (usadas.size >= 9500) throw new Error('Sem senhas disponíveis');
  let s;
  do { s = String(crypto.randomInt(0, 10000)).padStart(4, '0'); } while (usadas.has(s) || !senhaValida(s));
  return s;
}

// 4 dígitos, e nenhum dígito pode aparecer mais de 2 vezes (ex.: 1123 ok, 1112 não)
function senhaValida(s) {
  s = String(s || '');
  if (!/^\d{4}$/.test(s)) return false;
  const cont = {};
  for (const c of s) if ((cont[c] = (cont[c] || 0) + 1) > 2) return false;
  return true;
}

// ---------------------------------------------------------------- regras
// Vagas fixas (vinculos): militar amarrado pelo admin a uma OM. Ocupa a vaga,
// não entra na fila de escolha e NÃO é apagado pelo reset das escolhas.
const vinculoDe = uid => db.vinculos.find(v => v.usuarioId === uid);
const ocupadas = localId => db.alocacoes.filter(a => a.localId === localId).length
  + db.vinculos.filter(v => v.localId === localId).length;
const restantes = l => Math.max(0, l.vagas - ocupadas(l.id));
const alocacaoDe = uid => vinculoDe(uid) || db.alocacoes.find(a => a.usuarioId === uid);
const pendentes = () => db.usuarios.filter(u => !alocacaoDe(u.id));
const totalRestante = () => db.locais.reduce((s, l) => s + restantes(l), 0);

// Quando só resta um local com vaga, não há escolha a fazer:
// os próximos da fila são alocados automaticamente nele.
function alocacaoAutomatica() {
  let mudou = false;
  while (!db.pausado) {
    const fila = pendentes();
    const abertos = db.locais.filter(l => restantes(l) > 0);
    if (!fila.length || abertos.length !== 1) break;
    db.alocacoes.push({ usuarioId: fila[0].id, localId: abertos[0].id, ts: Date.now(), auto: true });
    mudou = true;
  }
  return mudou;
}

// Guarda quando começou a vez de quem está escolhendo (cronômetro na tela).
// Com as escolhas pausadas não há cronômetro; ao reabrir, ele recomeça do zero.
function marcarVez() {
  const atual = pendentes()[0];
  if (db.pausado || !atual) { db.vez = null; return; }
  if (db.vez?.id !== atual.id) db.vez = { id: atual.id, desde: Date.now() };
}

// Prévia: seguindo a classificação, cada militar ainda sem OM fica com a primeira
// opção da sua lista de preferências que ainda tiver vaga (considerando as anteriores).
function simular() {
  const resto = new Map(db.locais.map(l => [l.id, restantes(l)]));
  const res = {};
  for (const u of pendentes()) {
    const prefs = (db.preferencias[u.id] || []).filter(id => resto.has(id));
    if (!prefs.length) continue;
    const i = prefs.findIndex(id => resto.get(id) > 0);
    if (i < 0) { res[u.id] = { localId: null, esgotadas: true }; continue; }
    resto.set(prefs[i], resto.get(prefs[i]) - 1);
    res[u.id] = { localId: prefs[i], opcao: i + 1 };
  }
  return res;
}

// Acrescenta à classificação as preferências e a prévia de cada militar.
// Vai para a página pública "Preferências" (só leitura) e para o admin; fica fora
// do estado transmitido em tempo real para não pesar em todas as telas.
function comPreferencias(e) {
  const previa = simular();
  e.classificacao.forEach(c => {
    c.prefs = (db.preferencias[c.id] || []).filter(id => db.locais.some(l => l.id === id));
    c.previa = c.localId ? null : previa[c.id] || null;
  });
  return e;
}

function estadoPublico() {
  const fila = pendentes();
  const nome = id => db.usuarios.find(u => u.id === id)?.nome || '?';
  return {
    pausado: db.pausado,
    aberturaProgramada: db.pausado ? db.aberturaProgramada || null : null,
    vezDesde: db.vez?.desde || null,
    agora: Date.now(),
    locais: db.locais.map(l => ({
      id: l.id, om: l.om, cidade: l.cidade, vagas: l.vagas, restantes: restantes(l),
      fixos: db.vinculos.filter(v => v.localId === l.id).map(v => nome(v.usuarioId)),
      ocupantes: [...db.vinculos.filter(v => v.localId === l.id), ...db.alocacoes.filter(a => a.localId === l.id)].map(a => nome(a.usuarioId)),
    })),
    classificacao: db.usuarios.map((u, i) => {
      const a = alocacaoDe(u.id);
      return { id: u.id, pos: i + 1, nome: u.nome, localId: a ? a.localId : null, fixo: !!vinculoDe(u.id) };
    }),
    atual: fila[0] ? { id: fila[0].id, nome: fila[0].nome } : null,
    proximo: fila[1] ? { id: fila[1].id, nome: fila[1].nome } : null,
    totalRestante: totalRestante(),
    historico: db.alocacoes.map(a => ({
      usuarioId: a.usuarioId, nome: nome(a.usuarioId), local: db.locais.find(l => l.id === a.localId), ts: a.ts, auto: !!a.auto, admin: !!a.admin,
    })).map(h => ({ ...h, local: h.local ? `${h.local.om} (${h.local.cidade})` : '?' })),
  };
}

// ---------------------------------------------------------------- tempo real
const clientes = new Set();
function transmitir() {
  const msg = `data: ${JSON.stringify(estadoPublico())}\n\n`;
  for (const res of clientes) res.write(msg);
}
setInterval(() => { for (const res of clientes) res.write(': ping\n\n'); }, 25000);

function mudou() { alocacaoAutomatica(); marcarVez(); verificarBackup(); salvar(); transmitir(); }

// ---------------------------------------------------------------- sessões
const sessoes = new Map(); // token -> { tipo: 'user'|'admin', id }
function criarSessao(tipo, id) {
  const t = crypto.randomBytes(24).toString('hex');
  sessoes.set(t, { tipo, id });
  return t;
}

// Limita tentativas de senha por IP (4 dígitos são fáceis de adivinhar sem isso)
const tentativas = new Map();
function bloqueado(ip) {
  const agora = Date.now();
  const lista = (tentativas.get(ip) || []).filter(t => agora - t < 60000);
  tentativas.set(ip, lista);
  return lista.length >= 8;
}
function registrarFalha(ip) { tentativas.get(ip).push(Date.now()); }

// ---------------------------------------------------------------- planilha de preferências
// Planilha pública do Google: o servidor baixa a aba (CSV) e lê a coluna NOME e as colunas
// "OM 01", "OM 02"... (ordem de preferência). Cada célula de OM é "OM - Cidade".
// (º, ° e ⁰ viram "o" antes de normalizar: a planilha usa "1⁰ BEC" e o site "1º BEC")
const normal = t => String(t || '').replace(/[º°⁰]/g, 'o').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

function urlCsv(link) {
  const id = String(link || '').match(/\/spreadsheets\/d\/([\w-]+)/)?.[1];
  if (!id) return null;
  const gid = String(link).match(/[#&?]gid=(\d+)/)?.[1] || '0';
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

function lerCsv(t) {
  const linhas = []; let lin = [], cel = '', aspas = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (aspas) { if (c === '"') { if (t[i + 1] === '"') { cel += '"'; i++; } else aspas = false; } else cel += c; }
    else if (c === '"') aspas = true;
    else if (c === ',') { lin.push(cel); cel = ''; }
    else if (c === '\n') { lin.push(cel); linhas.push(lin); lin = []; cel = ''; }
    else if (c !== '\r') cel += c;
  }
  if (cel || lin.length) { lin.push(cel); linhas.push(lin); }
  return linhas;
}

function acharOm(texto) {
  const [om, ...resto] = String(texto).split(' - ');
  const cands = db.locais.filter(l => normal(l.om) === normal(om));
  if (cands.length <= 1) return cands[0] || null;
  return cands.find(l => normal(l.cidade) === normal(resto.join(' - '))) || cands[0];
}

let sincronizando = false;
async function sincronizarPlanilha() {
  const url = urlCsv(db.planilha?.url);
  if (!url || sincronizando) return;
  sincronizando = true;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
    if (!r.ok) throw new Error(`A planilha respondeu ${r.status}. Confira se ela está pública (qualquer pessoa com o link pode ver).`);
    const linhas = lerCsv(await r.text());
    // A partir daqui é síncrono: nada muda no meio da atualização.
    const ih = linhas.findIndex(l => l.some(c => normal(c) === 'nome'));
    if (ih < 0) throw new Error('Não achei a coluna NOME. Confira se o link é da aba Notas.');
    const cab = linhas[ih].map(normal);
    const iNome = cab.indexOf('nome');
    const iOms = cab.map((c, i) => [c.match(/^om\s*0*(\d+)$/)?.[1], i]).filter(([n]) => n).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
    if (!iOms.length) throw new Error('Não achei as colunas "OM 01", "OM 02"... na planilha.');
    const prefs = {}, avisos = [];
    for (const l of linhas.slice(ih + 1)) {
      const nome = (l[iNome] || '').trim();
      if (!nome) continue;
      const u = db.usuarios.find(x => normal(x.nome) === normal(nome));
      const opcoes = iOms.map(i => (l[i] || '').trim()).filter(Boolean);
      if (!u) { if (opcoes.length) avisos.push(`Nome da planilha não encontrado no site: ${nome}`); continue; }
      const ids = [];
      for (const o of opcoes) {
        const loc = acharOm(o);
        if (!loc) avisos.push(`${u.nome}: OM não encontrada no site: "${o}"`);
        else if (!ids.includes(loc.id)) ids.push(loc.id);
      }
      if (ids.length) prefs[u.id] = ids;
    }
    const mudouPrefs = JSON.stringify(prefs) !== JSON.stringify(db.preferencias);
    db.preferencias = prefs;
    db.planilha = { ...db.planilha, ultimaSync: Date.now(), erro: null, avisos, total: Object.keys(prefs).length };
    if (mudouPrefs) mudou(); else { salvar(); }
  } catch (e) {
    db.planilha = { ...db.planilha, erro: e.name === 'TimeoutError' ? 'A planilha demorou demais para responder.' : e.message, tentativa: Date.now() };
    salvar();
  } finally { sincronizando = false; }
}
setInterval(sincronizarPlanilha, 5 * 60 * 1000);

// ---------------------------------------------------------------- HTTP
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const erro = (res, status, msg) => json(res, status, { erro: msg });

function lerCorpo(req) {
  return new Promise((ok, falha) => {
    let dados = '';
    req.on('data', c => { dados += c; if (dados.length > 2e6) req.destroy(); });
    req.on('end', () => { try { ok(dados ? JSON.parse(dados) : {}); } catch { falha(new Error('JSON inválido')); } });
  });
}

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function estatico(req, res) {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const arq = path.normalize(path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p));
  if (!arq.startsWith(PUBLIC_DIR) || (PUBLIC_DIR === __dirname && !/\.(html|css|js|png|svg|ico)$/.test(arq)) || /server\.js$|[\\/]data[\\/]/.test(arq)) return erro(res, 403, 'Proibido');
  fs.readFile(arq, (e, buf) => {
    if (e) return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
      res.writeHead(e2 ? 404 : 200, { 'Content-Type': TIPOS['.html'] });
      res.end(e2 ? '<h1>Arquivo index.html não encontrado</h1><p>Confira se a pasta <b>public</b> com o <b>index.html</b> foi enviada ao repositório.</p>' : idx);
    });
    // no-cache: o navegador confere com o servidor antes de reusar, então uma versão nova aparece logo após o deploy
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arq)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const validarSenha = senhaValida;

async function rotear(req, res) {
  const url = new URL(req.url, 'http://x');
  const rota = `${req.method} ${url.pathname}`;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const sessao = sessoes.get(token);

  if (!url.pathname.startsWith('/api/')) return estatico(req, res);

  // ---- público
  if (rota === 'GET /api/estado') return json(res, 200, estadoPublico());

  // página "Preferências": prévia pela planilha, só leitura, para quem entrou com a senha
  // (militar ou admin); o link da planilha e a sincronização ficam com o admin
  if (rota === 'GET /api/preferencias') {
    const logado = sessao?.tipo === 'admin' || (sessao?.tipo === 'user' && db.usuarios.some(u => u.id === sessao.id));
    if (!logado) return erro(res, 401, 'Entre com sua senha para ver as preferências.');
    const { locais, classificacao } = comPreferencias(estadoPublico());
    return json(res, 200, { locais, classificacao, ultimaSync: db.planilha?.ultimaSync || null, configurada: !!db.planilha?.url });
  }

  if (rota === 'GET /api/eventos') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`data: ${JSON.stringify(estadoPublico())}\n\n`);
    clientes.add(res);
    req.on('close', () => clientes.delete(res));
    return;
  }

  const corpo = req.method === 'GET' ? {} : await lerCorpo(req);

  if (rota === 'POST /api/login') {
    if (bloqueado(ip)) return erro(res, 429, 'Muitas tentativas. Aguarde 1 minuto.');
    const u = db.usuarios.find(x => x.senha === String(corpo.senha));
    if (!u) { registrarFalha(ip); return erro(res, 401, 'Senha não encontrada. Confira os 4 dígitos.'); }
    return json(res, 200, { token: criarSessao('user', u.id), usuario: { id: u.id, nome: u.nome } });
  }

  if (rota === 'GET /api/eu') {
    if (sessao?.tipo !== 'user' || !db.usuarios.some(u => u.id === sessao.id)) return erro(res, 401, 'Sessão expirada');
    const u = db.usuarios.find(x => x.id === sessao.id);
    return json(res, 200, { id: u.id, nome: u.nome });
  }

  if (rota === 'POST /api/escolher') {
    if (sessao?.tipo !== 'user') return erro(res, 401, 'Entre com sua senha novamente.');
    // Trecho síncrono: validação + gravação sem interrupção
    if (db.pausado) return erro(res, 409, 'O processo está pausado pela administração.');
    const atual = pendentes()[0];
    if (!atual || atual.id !== sessao.id) return erro(res, 409, 'Ainda não é a sua vez.');
    const local = db.locais.find(l => l.id === corpo.localId);
    if (!local) return erro(res, 404, 'Local não encontrado.');
    if (restantes(local) <= 0) return erro(res, 409, 'Esta OM não tem mais vagas.');
    db.alocacoes.push({ usuarioId: atual.id, localId: local.id, ts: Date.now() });
    mudou();
    return json(res, 200, { ok: true, local: { om: local.om, cidade: local.cidade } });
  }

  if (rota === 'POST /api/admin/login') {
    if (bloqueado(ip)) return erro(res, 429, 'Muitas tentativas. Aguarde 1 minuto.');
    if (String(corpo.senha) !== ADMIN_SENHA) { registrarFalha(ip); return erro(res, 401, 'Senha de administrador incorreta.'); }
    return json(res, 200, { token: criarSessao('admin') });
  }

  // ---- administrador
  if (!url.pathname.startsWith('/api/admin/')) return erro(res, 404, 'Rota inexistente');
  if (sessao?.tipo !== 'admin') return erro(res, 401, 'Entre como administrador.');

  const partes = url.pathname.split('/'); // ['', 'api', 'admin', recurso, id]
  const recurso = partes[3], id = partes[4];

  if (rota === 'GET /api/admin/dados') return json(res, 200, { ...comPreferencias(estadoPublico()), usuarios: db.usuarios, planilha: db.planilha });

  if (rota === 'POST /api/admin/usuarios') {
    const nome = String(corpo.nome || '').trim().toUpperCase();
    if (!nome) return erro(res, 400, 'Informe o nome.');
    let senha = corpo.senha ? String(corpo.senha) : gerarSenha();
    if (!validarSenha(senha)) return erro(res, 400, 'A senha deve ter 4 dígitos, sem nenhum dígito repetido mais de 2 vezes.');
    if (db.usuarios.some(u => u.senha === senha)) return erro(res, 409, 'Senha já usada por outro militar.');
    db.usuarios.push({ id: novoId(), nome, senha });
    mudou(); return json(res, 200, { ok: true, senha });
  }

  if (recurso === 'usuarios' && id && req.method === 'PUT') {
    const u = db.usuarios.find(x => x.id === id);
    if (!u) return erro(res, 404, 'Militar não encontrado.');
    if (corpo.nome !== undefined) u.nome = String(corpo.nome).trim().toUpperCase() || u.nome;
    if (corpo.senha !== undefined) {
      if (!validarSenha(corpo.senha)) return erro(res, 400, 'A senha deve ter 4 dígitos, sem nenhum dígito repetido mais de 2 vezes.');
      if (db.usuarios.some(x => x.id !== id && x.senha === String(corpo.senha))) return erro(res, 409, 'Senha já usada por outro militar.');
      u.senha = String(corpo.senha);
      for (const [t, s] of sessoes) if (s.id === id) sessoes.delete(t);
    }
    mudou(); return json(res, 200, { ok: true });
  }

  if (recurso === 'usuarios' && id && req.method === 'DELETE') {
    db.usuarios = db.usuarios.filter(u => u.id !== id);
    db.alocacoes = db.alocacoes.filter(a => a.usuarioId !== id);
    db.vinculos = db.vinculos.filter(v => v.usuarioId !== id);
    mudou(); return json(res, 200, { ok: true });
  }

  if (rota === 'POST /api/admin/ordem') {
    const ids = corpo.ids || [];
    if (ids.length !== db.usuarios.length || !ids.every(i => db.usuarios.some(u => u.id === i))) return erro(res, 400, 'Lista de ordem inválida.');
    db.usuarios = ids.map(i => db.usuarios.find(u => u.id === i));
    mudou(); return json(res, 200, { ok: true });
  }

  if (rota === 'POST /api/admin/locais') {
    const om = String(corpo.om || '').trim(), cidade = String(corpo.cidade || '').trim();
    const vagas = parseInt(corpo.vagas, 10);
    if (!om || !(vagas >= 0)) return erro(res, 400, 'Informe OM e número de vagas.');
    db.locais.push({ id: novoId(), om, cidade, vagas });
    mudou(); return json(res, 200, { ok: true });
  }

  if (recurso === 'locais' && id && req.method === 'PUT') {
    const l = db.locais.find(x => x.id === id);
    if (!l) return erro(res, 404, 'Local não encontrado.');
    if (corpo.vagas !== undefined) {
      const v = parseInt(corpo.vagas, 10);
      if (!(v >= 0)) return erro(res, 400, 'Número de vagas inválido.');
      if (v < ocupadas(id)) return erro(res, 409, `Já há ${ocupadas(id)} militar(es) alocado(s) nesta OM.`);
      l.vagas = v;
    }
    if (corpo.om !== undefined) l.om = String(corpo.om).trim() || l.om;
    if (corpo.cidade !== undefined) l.cidade = String(corpo.cidade).trim();
    mudou(); return json(res, 200, { ok: true });
  }

  if (recurso === 'locais' && id && req.method === 'DELETE') {
    if (ocupadas(id)) return erro(res, 409, 'Há militares alocados nesta OM. Desfaça as alocações antes.');
    db.locais = db.locais.filter(l => l.id !== id);
    mudou(); return json(res, 200, { ok: true });
  }

  // Amarrar / soltar um militar numa vaga fixa. localId vazio = soltar.
  if (rota === 'POST /api/admin/vinculo') {
    const u = db.usuarios.find(x => x.id === corpo.usuarioId);
    if (!u) return erro(res, 404, 'Militar não encontrado.');
    const antigo = vinculoDe(u.id);
    if (!corpo.localId) {
      db.vinculos = db.vinculos.filter(v => v.usuarioId !== u.id);
      mudou(); return json(res, 200, { ok: true });
    }
    const local = db.locais.find(l => l.id === corpo.localId);
    if (!local) return erro(res, 404, 'Local não encontrado.');
    if (antigo?.localId === local.id) return json(res, 200, { ok: true });
    // se ele já tinha escolhido, a escolha dá lugar à vaga fixa
    const escolha = db.alocacoes.find(a => a.usuarioId === u.id);
    const liberaAqui = (escolha?.localId === local.id ? 1 : 0);
    if (restantes(local) + liberaAqui <= 0) return erro(res, 409, `${local.om} não tem vaga livre para fixar ${u.nome}.`);
    db.alocacoes = db.alocacoes.filter(a => a.usuarioId !== u.id);
    db.vinculos = db.vinculos.filter(v => v.usuarioId !== u.id);
    db.vinculos.push({ usuarioId: u.id, localId: local.id });
    mudou(); return json(res, 200, { ok: true });
  }

  // Administrador escolhe pelo militar da vez (funciona mesmo com as escolhas pausadas)
  if (rota === 'POST /api/admin/escolher') {
    const atual = pendentes()[0];
    if (!atual) return erro(res, 409, 'Todos os militares já foram alocados.');
    if (corpo.usuarioId && corpo.usuarioId !== atual.id) return erro(res, 409, `A vez mudou: agora é ${atual.nome}. Confira e escolha novamente.`);
    const local = db.locais.find(l => l.id === corpo.localId);
    if (!local) return erro(res, 404, 'Local não encontrado.');
    if (restantes(local) <= 0) return erro(res, 409, 'Esta OM não tem mais vagas.');
    db.alocacoes.push({ usuarioId: atual.id, localId: local.id, ts: Date.now(), admin: true });
    mudou();
    return json(res, 200, { ok: true });
  }

  if (rota === 'POST /api/admin/planilha') {
    const link = String(corpo.url || '').trim();
    if (link && !urlCsv(link)) return erro(res, 400, 'Link inválido. Copie o endereço da planilha do Google (com a aba Notas aberta).');
    db.planilha = link ? { url: link } : null;
    if (!link) { db.preferencias = {}; mudou(); return json(res, 200, { ok: true }); }
    salvar();
    await sincronizarPlanilha();
    return json(res, 200, { ok: true, planilha: db.planilha });
  }

  if (rota === 'POST /api/admin/planilha/sincronizar') {
    if (!db.planilha?.url) return erro(res, 400, 'Nenhuma planilha configurada.');
    await sincronizarPlanilha();
    return json(res, 200, { ok: true, planilha: db.planilha });
  }

  if (rota === 'POST /api/admin/pausa') {
    db.pausado = !!corpo.pausado;
    if (!db.pausado) db.aberturaProgramada = null; // abriu na mão: a programação perde o sentido
    mudou(); return json(res, 200, { ok: true });
  }

  // Programa (ou cancela, com quando = null) a abertura automática das escolhas.
  // "quando" é o instante em milissegundos; o navegador do admin converte a data/hora local dele.
  if (rota === 'POST /api/admin/agendar') {
    if (corpo.quando === null) { db.aberturaProgramada = null; mudou(); return json(res, 200, { ok: true }); }
    const quando = Number(corpo.quando);
    if (!Number.isFinite(quando)) return erro(res, 400, 'Data e hora inválidas.');
    if (quando <= Date.now()) return erro(res, 400, 'Escolha uma data e hora no futuro.');
    if (!db.pausado) return erro(res, 409, 'As escolhas já estão abertas.');
    db.aberturaProgramada = quando;
    mudou(); return json(res, 200, { ok: true });
  }

  // Desfaz a escolha de um militar qualquer (não só a última). Ele volta para a fila
  // na sua posição da classificação; as escolhas são pausadas para o admin conferir.
  if (rota === 'POST /api/admin/desfazer-escolha') {
    const a = db.alocacoes.find(x => x.usuarioId === corpo.usuarioId);
    if (!a) return erro(res, 404, 'Esta escolha já não existe. Atualize a página.');
    db.alocacoes = db.alocacoes.filter(x => x !== a);
    db.pausado = true;
    mudou(); return json(res, 200, { ok: true });
  }

  if (rota === 'POST /api/admin/desfazer') {
    // desfaz a última escolha manual e as automáticas que vieram depois dela
    while (db.alocacoes.length) { const a = db.alocacoes.pop(); if (!a.auto) break; }
    db.pausado = true; // pausa para evitar que a automação refaça imediatamente
    mudou(); return json(res, 200, { ok: true });
  }

  if (rota === 'POST /api/admin/reset') {
    db.alocacoes = []; db.pausado = true; // vagas fixas (vinculos) são mantidas
    db.backupMarco = 0; db.backupFinal = false; // a contagem de 10 em 10 recomeça
    mudou(); return json(res, 200, { ok: true });
  }

  if (rota === 'GET /api/admin/backups') return json(res, 200, lerIndiceBackups());

  if (recurso === 'backups' && id && req.method === 'GET') {
    if (!NOME_BACKUP.test(id)) return erro(res, 400, 'Backup inválido.');
    try {
      const b = JSON.parse(fs.readFileSync(path.join(PASTA_BACKUPS, id), 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="escolha-om-${id}"` });
      return res.end(JSON.stringify(b.db, null, 2));
    } catch { return erro(res, 404, 'Backup não encontrado.'); }
  }

  if (rota === 'POST /api/admin/backups/restaurar') {
    const arq = String(corpo.arquivo || '');
    if (!NOME_BACKUP.test(arq)) return erro(res, 400, 'Backup inválido.');
    let b;
    try { b = JSON.parse(fs.readFileSync(path.join(PASTA_BACKUPS, arq), 'utf8')); } catch { return erro(res, 404, 'Backup não encontrado.'); }
    backup('Antes de restaurar um backup');
    const falha = restaurarDados(b.db);
    if (falha) return erro(res, 400, falha);
    mudou();
    return json(res, 200, { ok: true });
  }

  if (rota === 'GET /api/admin/backup') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="escolha-om-backup.json"' });
    return res.end(JSON.stringify(db, null, 2));
  }

  if (rota === 'POST /api/admin/restaurar') {
    backup('Antes de restaurar um backup');
    const falha = restaurarDados(corpo);
    if (falha) return erro(res, 400, falha);
    mudou(); return json(res, 200, { ok: true });
  }

  return erro(res, 404, 'Rota inexistente');
}

carregar();
sincronizarPlanilha();

// Abertura programada: confere a cada segundo. Se o servidor estava fora do ar na hora
// marcada, abre assim que voltar.
setInterval(() => {
  if (db.aberturaProgramada && Date.now() >= db.aberturaProgramada) {
    db.aberturaProgramada = null;
    if (db.pausado) { db.pausado = false; console.log('Escolhas abertas automaticamente (abertura programada).'); }
    mudou();
  }
}, 1000);
http.createServer((req, res) => {
  rotear(req, res).catch(e => { console.error(e); if (!res.headersSent) erro(res, 400, e.message); });
}).listen(PORT, () => console.log(`Escolha de OM rodando em http://localhost:${PORT}`));

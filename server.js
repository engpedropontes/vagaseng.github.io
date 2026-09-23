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
  const usuarios = [];
  for (const nome of ['PEDRO VICTOR', 'JARDEL', 'CHESLER', 'LUCAS CARDOSO', 'MATIAS']) {
    usuarios.push({ id: novoId(), nome, senha: gerarSenha(usuarios) });
  }
  return { locais, usuarios, alocacoes: [], pausado: true };
}

function carregar() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
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
const ocupadas = localId => db.alocacoes.filter(a => a.localId === localId).length;
const restantes = l => Math.max(0, l.vagas - ocupadas(l.id));
const alocacaoDe = uid => db.alocacoes.find(a => a.usuarioId === uid);
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

function estadoPublico() {
  const fila = pendentes();
  const nome = id => db.usuarios.find(u => u.id === id)?.nome || '?';
  return {
    pausado: db.pausado,
    locais: db.locais.map(l => ({
      id: l.id, om: l.om, cidade: l.cidade, vagas: l.vagas, restantes: restantes(l),
      ocupantes: db.alocacoes.filter(a => a.localId === l.id).map(a => nome(a.usuarioId)),
    })),
    classificacao: db.usuarios.map((u, i) => {
      const a = alocacaoDe(u.id);
      return { id: u.id, pos: i + 1, nome: u.nome, localId: a ? a.localId : null };
    }),
    atual: fila[0] ? { id: fila[0].id, nome: fila[0].nome } : null,
    proximo: fila[1] ? { id: fila[1].id, nome: fila[1].nome } : null,
    totalRestante: totalRestante(),
    historico: db.alocacoes.map(a => ({
      nome: nome(a.usuarioId), local: db.locais.find(l => l.id === a.localId), ts: a.ts, auto: !!a.auto, admin: !!a.admin,
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

function mudou() { alocacaoAutomatica(); salvar(); transmitir(); }

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

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function estatico(req, res) {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const arq = path.normalize(path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p));
  if (!arq.startsWith(PUBLIC_DIR) || (PUBLIC_DIR === __dirname && !/\.(html|css|js|png|svg|ico)$/.test(arq)) || /server\.js$|[\\/]data[\\/]/.test(arq)) return erro(res, 403, 'Proibido');
  fs.readFile(arq, (e, buf) => {
    if (e) return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
      res.writeHead(e2 ? 404 : 200, { 'Content-Type': TIPOS['.html'] });
      res.end(e2 ? '<h1>Arquivo index.html não encontrado</h1><p>Confira se a pasta <b>public</b> com o <b>index.html</b> foi enviada ao repositório.</p>' : idx);
    });
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arq)] || 'application/octet-stream' });
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

  if (rota === 'GET /api/admin/dados') return json(res, 200, { ...estadoPublico(), usuarios: db.usuarios });

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

  if (rota === 'POST /api/admin/pausa') { db.pausado = !!corpo.pausado; mudou(); return json(res, 200, { ok: true }); }

  if (rota === 'POST /api/admin/desfazer') {
    // desfaz a última escolha manual e as automáticas que vieram depois dela
    while (db.alocacoes.length) { const a = db.alocacoes.pop(); if (!a.auto) break; }
    db.pausado = true; // pausa para evitar que a automação refaça imediatamente
    mudou(); return json(res, 200, { ok: true });
  }

  if (rota === 'POST /api/admin/reset') {
    db.alocacoes = []; db.pausado = true;
    mudou(); return json(res, 200, { ok: true });
  }

  if (rota === 'GET /api/admin/backup') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="escolha-om-backup.json"' });
    return res.end(JSON.stringify(db, null, 2));
  }

  if (rota === 'POST /api/admin/restaurar') {
    const d = corpo;
    if (!Array.isArray(d.locais) || !Array.isArray(d.usuarios) || !Array.isArray(d.alocacoes)) return erro(res, 400, 'Arquivo de backup inválido.');
    db = { locais: d.locais, usuarios: d.usuarios, alocacoes: d.alocacoes, pausado: true };
    mudou(); return json(res, 200, { ok: true });
  }

  return erro(res, 404, 'Rota inexistente');
}

carregar();
http.createServer((req, res) => {
  rotear(req, res).catch(e => { console.error(e); if (!res.headersSent) erro(res, 400, e.message); });
}).listen(PORT, () => console.log(`Escolha de OM rodando em http://localhost:${PORT}`));

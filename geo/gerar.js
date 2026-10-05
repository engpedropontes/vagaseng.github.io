// Gera geo/geo-br.bin.gz (faixas de IP do Brasil -> UF) a partir da base gratuita do DB-IP
// "IP to City Lite" (CC BY 4.0, https://db-ip.com/db/download/ip-to-city-lite), atualizada todo mês.
// Uso: baixe dbip-city-lite-AAAA-MM.csv.gz e rode  node geo/gerar.js dbip-city-lite-AAAA-MM.csv.gz
// Formato: u32 tamanho do cabeçalho + cabeçalho JSON { siglas, n4, n6, fonte }
//          + n4 x (início u32, fim u32, uf u8) + n6 x (início u64, fim u64, uf u8) — IPv6 pelos 64 bits altos.
const fs = require('fs'), net = require('net'), path = require('path'), zlib = require('zlib');
const UF = { 'Acre':'AC','Alagoas':'AL','Amapá':'AP','Amazonas':'AM','Bahia':'BA','Ceará':'CE','Federal District':'DF','Espírito Santo':'ES','Goiás':'GO','Maranhão':'MA','Mato Grosso':'MT','Mato Grosso do Sul':'MS','Minas Gerais':'MG','Pará':'PA','Paraíba':'PB','Paraná':'PR','Pernambuco':'PE','Piauí':'PI','Rio de Janeiro':'RJ','Rio Grande do Norte':'RN','Rio Grande do Sul':'RS','Rondônia':'RO','Roraima':'RR','Santa Catarina':'SC','São Paulo':'SP','Sergipe':'SE','Tocantins':'TO' };
const SIGLAS = Object.values(UF).sort();
const ip4 = s => s.split('.').reduce((a, b) => a * 256 + +b, 0);
function ip6hi(s) {
  const [a, b] = s.split('::'); const h = a ? a.split(':') : []; const t = b !== undefined ? (b ? b.split(':') : []) : [];
  const g = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return g.slice(0, 4).reduce((acc, x) => (acc << 16n) | BigInt(parseInt(x || '0', 16)), 0n);
}
const arquivo = process.argv[2];
if (!arquivo) { console.error('Uso: node geo/gerar.js dbip-city-lite-AAAA-MM.csv.gz'); process.exit(1); }
const v4 = [], v6 = [];
// lê linha a linha (o CSV descomprimido tem mais de 500 MB)
const linhas = require('readline').createInterface({ input: fs.createReadStream(arquivo).pipe(zlib.createGunzip()) });
linhas.on('line', linha => {
  const m = linha.match(/^([^,]+),([^,]+),[^,]*,BR,(?:"([^"]*)"|([^,]*)),/); if (!m) return;
  const uf = UF[m[3] ?? m[4]]; if (!uf) return;
  const i = SIGLAS.indexOf(uf);
  if (net.isIPv4(m[1])) v4.push([ip4(m[1]), ip4(m[2]), i]); else v6.push([ip6hi(m[1]), ip6hi(m[2]), i]);
});
linhas.on('close', gravar);
// junta faixas vizinhas do mesmo estado
const juntar = (lista, um) => { lista.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); const out = [];
  for (const r of lista) { const u = out[out.length - 1]; if (u && u[2] === r[2] && r[0] <= u[1] + um) { if (r[1] > u[1]) u[1] = r[1]; } else out.push([...r]); } return out; };
function gravar() {
const a4 = juntar(v4, 1), a6 = juntar(v6, 1n);
const cab = Buffer.from(JSON.stringify({ siglas: SIGLAS, n4: a4.length, n6: a6.length, fonte: `DB-IP IP to City Lite (CC BY 4.0) - ${path.basename(arquivo)}` }));
const b = Buffer.alloc(4 + cab.length + a4.length * 9 + a6.length * 17); let o = 0;
b.writeUInt32LE(cab.length, o); o += 4; cab.copy(b, o); o += cab.length;
for (const [s, e, i] of a4) { b.writeUInt32LE(s, o); b.writeUInt32LE(e, o + 4); b.writeUInt8(i, o + 8); o += 9; }
for (const [s, e, i] of a6) { b.writeBigUInt64LE(s, o); b.writeBigUInt64LE(e, o + 8); b.writeUInt8(i, o + 16); o += 17; }
fs.writeFileSync(path.join(__dirname, 'geo-br.bin.gz'), zlib.gzipSync(b, { level: 9 }));
console.log(`IPv4: ${a4.length} faixas · IPv6: ${a6.length} faixas`);
}

# Escolha de OM - Eng EsAO

Sistema de escolha de vagas por ordem de classificação, em tempo real.
Node.js puro, **sem dependências** (não precisa de `npm install`).

## Rodar localmente

    node server.js
    # abra http://localhost:3000

Na primeira execução é criado `data/db.json` com as 36 OMs da planilha (41 vagas)
e 5 militares de exemplo (as senhas aparecem no terminal e no painel admin).
**O processo começa pausado**: abra as escolhas em Administração > Andamento.

## Variáveis de ambiente

| Variável      | Padrão          | Uso                                   |
|---------------|-----------------|---------------------------------------|
| `PORT`        | 3000            | Porta HTTP                            |
| `ADMIN_SENHA` | 8769            | Senha do administrador                |
| `DATA_FILE`   | ./data/db.json  | Onde os dados ficam gravados          |

## Hospedagem (precisa de disco persistente)

Os dados ficam num arquivo JSON, então o servidor precisa de um disco que
sobreviva a reinícios. Opções simples:

- **Railway**: crie o projeto a partir do repositório, adicione um *Volume*
  montado em `/data` e defina `DATA_FILE=/data/db.json` e `ADMIN_SENHA`.
- **Fly.io**: `fly launch`, `fly volumes create dados`, monte em `/data`,
  defina as mesmas variáveis.
- **VPS qualquer**: `ADMIN_SENHA=8769 node server.js` atrás de um Nginx
  (desative o buffer para `/api/eventos`, ou use `proxy_buffering off`).

Evite planos com disco efêmero (ex.: Render gratuito): os dados somem ao reiniciar.
Use o botão **Baixar backup** no admin periodicamente.

## Regras implementadas

- Só o primeiro militar sem OM (na ordem da classificação) consegue escolher;
  o servidor valida isso em cada requisição, então não há conflito de concorrência.
- Quando só resta **uma OM com vaga**, os militares restantes são alocados nela
  automaticamente.
- "Desfazer última escolha" e "Resetar" pausam o processo, para a administração
  conferir antes de reabrir.
- Senhas dos militares: 4 dígitos, nenhum dígito repetido mais de 2 vezes
  (ex.: 1123 vale, 1112 não). Vale para as geradas e para as digitadas no admin.
- Tentativas de senha limitadas a 8 por minuto por IP.

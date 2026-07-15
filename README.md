# O Cruzeiro · Mesas

App de registo de mesas para o Restaurante O Cruzeiro (Monte Gordo). Quem está à porta
toca na mesa no mapa e no número de pessoas — **dois toques, zero escrita** — e o Rui vê
no PC (ou no telemóvel) a fila por ordem de chegada, com o tempo de espera a contar.

O mapa replica a folha plastificada do balcão (mesmas filas, mesmo o espaço vazio da 123
e a 128 acrescentada à mão), mais as mesas Sala 1–6. O balcão aparece mas não conta.

## Estados

`livre` → toque → pessoas → **à espera** (vermelho, cronómetro) → "Atendida ✓" → **atendida**
(verde) → "Libertar" → volta a livre e entra nas estatísticas do dia. Toda a ação tem
"Anular" na notificação, e "Foi engano" apaga uma entrada errada sem sujar o histórico.

Ao registar dá para marcar **🇪🇸 Espanhol / 🇬🇧 Inglês** (opcional — português não precisa),
e o Rui vê o badge ES/EN na fila antes de ir à mesa.

**Juntar mesas:** na folha de nova entrada, **＋ Juntar outra mesa** → o mapa fica tocável,
escolhe as mesas, **Concluir ✓**. **Grupos grandes:** **Grupo maior ＋** abre um contador
até 60 pessoas (o teclado normal vai só até 12).

**Próxima mesa:** no topo da Fila (e ao lado do mapa no PC) há um destaque grande com a mesa
que o Rui deve atender a seguir — número, espera e um botão **Atendida ✓**. O ☀/☾ no topo
força tema claro/escuro (por aparelho); a hora de chegada vem do servidor, por isso a ordem
é igual em todos os aparelhos mesmo com relógios trocados.

## Sincronização (Firebase, grátis)

Sem configuração a app funciona só num aparelho (modo local). Para sincronizar telemóveis + PC:

1. [console.firebase.google.com](https://console.firebase.google.com) → **Adicionar projeto** (ex. `cruzeiro-mesas`), Analytics desligado.
2. **Build → Realtime Database → Create database** → `europe-west1` → modo bloqueado.
3. Separador **Rules** → colar e publicar:
   ```json
   {
     "rules": {
       "live":  { ".read": true, ".write": true },
       "days":  { ".read": true, ".write": true }
     }
   }
   ```
   (Dados abertos mas inócuos — números de mesa e contagens. Se um dia quiserem, tranca-se com Firebase Auth.)
4. ⚙️ **Project settings → Your apps → Web** (`</>`) → registar → copiar o objeto `firebaseConfig` para `firebase-config.js`.
5. Commit + push. O ponto verde no topo passa a "em linha".

## Publicar (GitHub Pages)

Repo → Settings → Pages → Deploy from branch → `main` / root. A app fica em
`https://<user>.github.io/cruzeiro-mesas/`. No iPhone: Safari → Partilhar →
**Adicionar ao ecrã principal**. No PC: abrir no browser e deixar aberto (F11 para ecrã inteiro).

## Desenvolvimento

Estático puro, sem build: `python -m http.server` ou `npx serve` na pasta.
`node build_preview.mjs` gera um `preview.html` auto-contido em modo demo (dados fictícios,
sem rede) para mostrar a alguém.

Constantes úteis em `app.js`: `MAIN_ROWS`/`SALA` (mesas), `WARN_MIN`/`CRIT_MIN` (5/10 min de escalada).

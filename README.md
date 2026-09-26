# Lootborne Planner

*Antes chamado Lootborne Companion.*

Tela de apoio para o **Lootborne** (Steam 4335620): acompanha personagem (com o XP e o tempo que faltam até o nível 60 no farm atual), lutas (PvE, PvP e os bosses de PvP, com o tempo de cada uma), inventário, o simulador com o planejador de build (inclusive respec dos pontos), uma biblioteca com todos os itens, perks e poções do jogo para testar no personagem, timeline e PvP, e manda alertas. O visual segue o painel do nosso BotFarm Planner (paleta marrom/dourada, menu lateral agrupado, KPIs e pílulas de status).

Tudo é **somente leitura**: o app nunca escreve no save, na memória ou na pasta do jogo. Os achados técnicos (como o jogo foi feito e o que cada fonte entrega) estão em [FINDINGS.md](FINDINGS.md).

## Baixar

Na página [Releases](https://github.com/raafaadg/lootborne-planner/releases/latest):

- `Lootborne-Planner-Setup-<versão>.exe`: instalador (só para o seu usuário, sem administrador; atualiza por cima).
- `Lootborne-Planner-v<versão>-win-x64.zip`: portátil (extraia a pasta inteira e abra `Lootborne Planner.exe`).

O app não é assinado, então o Windows pode mostrar "O Windows protegeu o computador" na primeira vez: **Mais informações → Executar assim mesmo**. Os dados ficam em `%APPDATA%\lootborne-planner`. Se a janela não abrir, veja o `LEIA-ME.txt` (e o `startup.log` na mesma pasta de dados).

## Publicar uma versão

1. Suba a versão no `package.json` (ex.: `0.22.2`) e faça o commit.
2. Crie e envie a tag com o mesmo número:
   ```bash
   git tag v0.22.2
   git push origin v0.22.2
   ```
3. O workflow [`release.yml`](.github/workflows/release.yml) roda no Windows do GitHub: instala, confere que a tag bate com o `package.json`, roda `typecheck` e os testes, gera o zip e o instalador e publica a release com os dois arquivos. Em *Actions → Release → Run workflow* dá para gerar os mesmos arquivos sem publicar (ficam como artefato por 14 dias).

Localmente: `npm run dist` (zip em `release/`) e depois `npm run dist:installer` (instalador em `release/installer/`).

## Rodar

```bash
npm install          # Node 22+; o npm 11 bloqueia scripts de instalação, então o electron já está liberado em "allowScripts"
npm run build
npm start            # abre o app a partir de out/
npm run dev          # modo desenvolvimento com hot reload
npm test             # vitest (diff do save, replays, fórmulas)
npm run typecheck
```

## Fontes de dados

| Fonte | Sempre ligada? | Latência | Entrega |
|---|---|---|---|
| Save (`%USERPROFILE%\AppData\LocalLow\Turbolento Games\Lootborne\save_<steamid>_game.json`) | sim | 1 escrita por luta (~15 s) | estado completo, eventos (luta, drop, morte, nível, setor, forja) |
| Replays (`…\Lootborne\Replays\*.json`) | sim | fim de cada PvP | os dois lados: nível, PV, equipamento peça a peça, e cada turno com dano/crítico/aparada/cura/contra-ataque |
| **Modo ao vivo (Frida)** | opt-in (aba *Alertas & Ao vivo*) | tempo real | inimigo atual e HP, cada turno, drop no instante, tela, autofight, PWR do jogo, XP por nível |

O modo ao vivo injeta um agente **só de observação** (`src/main/live/agent.js`) no processo do jogo. Classes, métodos **e offsets de campo** são resolvidos pelo nome via `il2cpp_*`, então updates do jogo só quebram o agente se renomearem algo. Se o attach falhar, o app segue só com o save. O diagnóstico fica em `%APPDATA%\lootborne-planner\live.log`.

## Estrutura

```
src/main/game-reader/   save-reader (poll + rotação .bak), save-diff (eventos), replay-reader
src/main/storage/       settings, history (eventos) e pvp-archive (o jogo só guarda 15 replays)
src/main/live/          frida-tap (attach, watchdog, detach) + agent.js (hooks read-only)
src/main/app-state.ts   fonte única: junta save + replays + ao vivo, deduplica, estatísticas
src/main/notifier.ts    toasts do Windows + webhook do Discord
src/shared/             contratos e fórmulas do jogo (PWR, pontos, sinergias, combate, curva de XP, análise de PvP, tipos de luta e bosses)
src/renderer/           React + Tailwind v4 (abas)
game-data/              catálogo do jogo: 424 itens, 7 setores, 35 inimigos, 31 perks, 21 poções
game-data/icons/        sprite sheets com a arte do próprio jogo (473 ícones, 233 KB)
spikes/                 testes de viabilidade (Python/Node) e extratores
fixtures/               saves e replays reais usados nos testes
re/                     dumps do Cpp2IL (fora do git)
```

## Quando o jogo atualizar

1. Rode `npm test` e abra o app: se o save mudar de formato, o `parseSave` avisa.
2. Veja o `live.log`: hooks que falharem aparecem por nome (`hooks x/10` no rodapé).
3. Se itens novos entrarem, regenere o catálogo: `python spikes/s5_catalog.py` (precisa do `UnityPy`).
4. Se a fórmula de PWR mudar, o PWR estimado deixa de bater com o "PWR (jogo)" da aba Build; refaça o dump (`re/tools/Cpp2IL.exe … --output-as isil`) e confira `StatsCalculator.GetPowerScore`.

## O que o app não faz, de propósito

Não escreve no save nem na memória, não chama funções do jogo, não automatiza PvP/ranking e não executa as meta-ações do anti-AFK "Murato" (forjar, desmontar, loja, perks). O jogo tem sanções no servidor (ban, zerar pontos de ranking), e esses sistemas existem justamente para isso.

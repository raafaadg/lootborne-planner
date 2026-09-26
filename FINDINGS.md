# Lootborne — achados dos spikes de viabilidade

Build analisado: Steam 4335620, Unity **6000.3.1f1**, IL2CPP metadata **v39**, `build-guid c4889dfe2c4c4c5e8c347327b43b56a7` (instalado em 2026-09-21).
Todos os testes foram **somente leitura** sobre o processo e os arquivos do jogo. Nada foi escrito no save, na memória ou na pasta do jogo.

## Resumo

| Fonte | Funciona? | Latência | O que entrega | Risco / manutenção |
|---|---|---|---|---|
| **Save JSON** (S1) | ✅ | 1 escrita por batalha (mediana 14 s; 7–41 s) | Estado completo: nível, XP, HP, stamina, setor/inimigo, inventário, equipamento, pity, PvP currency, murato, onboarding | Nenhum; o JSON tem nomes e sobrevive a updates |
| **Replays PvP** (S1) | ✅ | ao fim de cada PvP | Oponente, equipamento, turno a turno | Nenhum |
| **Player.log** | ❌ | — | Só diagnóstico de pixel/janela | — |
| **Captura de tela** (S2) | ✅ | 20–43 ms/frame | UI exata (pixel-art ×3, sem compressão), HP/XP em barras, popups | Painel **arrastável e que se move**; precisa localizar por template a cada frame |
| **Input simulado** (S3) | ⚠️ inconclusivo | — | — | PostMessage **não** funciona; SendInput não teve efeito visível no alvo testado; cliques podem **desarmar o autofight** |
| **Memória externa** (S4) | ✅ | tempo real (poll 1 Hz+) | Tudo do save **+** inimigo atual (nome, HP, cor, chance de drop), `isInCombat`, tela ativa, autofight `isOn/armed` | Localização ~33 s (1ª vez); offsets mudam por build → re-dump do Cpp2IL |
| **Frida (frida-node)** | ✅ | evento a evento (ms) | Início/fim de combate, **cada turno**, drops, troca de tela, autofight on/off (e se foi o jogador), saves | Injeta agente no processo; métodos resolvidos **por nome** (resistente a update); alguns métodos inlinados não disparam |
| **Catálogo de assets** (S5) | ✅ | offline | 424 itens (stats, elemento, efeitos), 7 setores (% de drop por raridade) | Parser manual (typetree removido); revalidar se o layout de `ItemData` mudar |

**Recomendação:** o app deve usar **save + replays** como base (zero risco, sempre ligado) e **Frida como fonte "ao vivo" opcional** (combate em tempo real, turnos, drops no instante), com fallback automático para o save se o attach falhar. A leitura de memória externa funciona, mas o Frida entrega mais, resolve por nome e é o mesmo padrão já usado pelo bombfarm-companion (`packages/tap-runtime`). **Ações por input: não recomendadas agora** (ver S3).

## Como o jogo foi implementado

- `Assembly-CSharp`, namespaces `AutoBattle.*` **sem ofuscação** (dev italiano, comentários e logs em italiano). Cpp2IL `2022.1.0-pre-release.21` + `--use-processor attributeinjector` gera stubs com offsets de campo e RVAs (`re/dummydll`, decompilado em `re/decomp`).
- **Loop principal já é automático:** `AutoFightController` (liberado ao limpar o setor 0) luta sozinho; ao morrer, o progresso do setor volta a 0, o jogo descansa ~30 s e volta a lutar; **PvP assíncrono** roda sozinho em segundo plano (`GameManager.pvpTimer`, +13 `pvpCurrency` por luta, replays em `Replays/`).
- Stamina: −0,8 por batalha; `HandleStaminaDepleted` desliga o autofight e `ArmIfRefilling` rearma quando recarrega.
- `AutoFightController.ShouldDisarmOnClick` / `exemptFromDisarm`: **clicar na UI desarma o autofight**, a menos que o alvo esteja na lista de isentos.
- Janela: `UnityWndClass` sem borda, transparente (Kirurobo UniWindowController), canvas 540×360 × 3; os painéis podem ser arrastados pelo jogador (`FreePanelDragger`).
- Backend PlayFab (cliente próprio): login Steam, Cloud Script/Functions, estatísticas, leaderboard, eventos.
- Anti-cheat: ACTk + `AntiCheatManager`, que reporta **só** 6 flags: `OnClockJump`, `OnSpeedHackDetected`, `OnTamperedSave`, `OnUnsignedSave`, `OnBakPromoted`, `OnItemBossFlagRepaired`. **Sem** detecção de debugger, injeção, Frida ou leitura de memória (nenhuma string/import relevante). Sanções vêm do servidor (`SanctionNotice`: ban, rp_zero; `StrikeBanPanel`).
- **Murato** (anti-AFK): `muratoBattlesSinceProgress/SinceAction` contam batalhas sem progresso ou ação; meta-ações (Dismantle/Shop/Consumable/Perk, e a forja) marcam `muratoActionMask`, e "AFK puro nunca qualifica". Entra na assinatura do save. **Não automatizar meta-ações.**

## S1 — Save watcher (`spikes/s1_save_watcher.py`)

- Arquivo: `%USERPROFILE%\AppData\LocalLow\Turbolento Games\Lootborne\save_<steamid>_game.json` → `{payload, checksum(SHA-256), sigVersion: 8}`.
- **Escrita atômica com rotação**: o arquivo some por alguns ms (`.bak` ← atual, depois o novo). O leitor precisa tolerar `FileNotFoundError` e JSON parcial (retry).
- ~50 min observados (~110 batalhas): cadência mediana 14,3 s; XP por inimigo 15/100/250 (setor 0) e 366/574 (setor 1); todos os eventos conferidos: batalha, level up (+5 pontos), drop (com raridade), morte, troca de setor, equipamento, forja (15 itens consumidos), PvP (+13 currency), flags de onboarding.
- `battleActive=false` indica pausa (descanso após morte, ou o jogador parou para equipar ou distribuir pontos).
- Snapshots de cada versão ficam em `spikes/out/snapshots/` e viram fixtures dos testes.

## S2 — Captura (`spikes/s2_capture.py`, `s2_printwindow.py`, `locate.py`)

- `ImageGrab` (desktop) captura o jogo **com o fundo da área de trabalho** (a janela é transparente).
- `PrintWindow(PW_RENDERFULLCONTENT)` → **só os pixels do jogo sobre fundo preto**, 43 ms, independe de sobreposição. `BitBlt` do DC da janela: 20 ms, com canal alfa.
- Template matching por âncoras de cor + verificação (`locate.py`): **~100 ms**, erro médio 0,00–0,03 (match exato) mesmo com o painel arrastado.
- Da tela dá para ler barras de HP do jogador/inimigo, barra de XP, `n/30` do setor e popups ("ITEM DROPPED!").

## S3 — Input (`spikes/s3_input.py`)

- `PostMessage WM_LBUTTONDOWN/UP` → **sem efeito** (Unity Input System não usa mensagens de janela).
- `SendInput` (cursor movido e restaurado, com o jogo em foreground) no ícone de estatísticas → **sem efeito visível**; hover sobre o personagem sem foco → sem tooltip. Não se sabe se o alvo não é clicável ou se o input sintético é ignorado.
- Dois fatores tornam input automatizado frágil: (1) o painel se move; (2) **cliques desarmam o autofight**. Para fechar o spike, é preciso testar num botão de efeito conhecido, com o jogador ausente.

## S4 — Memória externa (`spikes/s4_memory.py`)

- `OpenProcess(PROCESS_VM_READ|QUERY_INFORMATION)` apenas. Cópia da heap privada (~700 MB) em 1,3–4,4 s.
- Classe pelo nome: string no metadata → ponteiro `Il2CppClass.name` (+0x10) → confirma `namespaze` (+0x18). Instância: palavra igual ao ponteiro da classe, validada por campos (`GameManager.playerState.klass == PlayerState`).
- **12/12 campos do `PlayerState` iguais ao save**; `PlayerState` não usa tipos `Obscured*`.
- Extras só da memória: `CombatManager.currentCombatEnemy` (nome, HP/maxHp, cor, nível, `dropChance`, `xpWin`), `isInCombat`, `GameManager.currentScreen` (`Creation/Home/Equip/Inventory/Battle`), `AutoFightController.isOn/armed`.
- Offsets (build atual) em `s4_memory.py` e `re/decomp`. Custo: localizar leva ~33 s na 1ª vez (dá para cachear por pid).

## Frida — frida-node 17.18.0 (`spikes/frida/host.js`, `agent.js`)

- Attach em ~1 s, 2 ciclos de attach/detach sem crash e sem efeito no jogo.
- Métodos resolvidos **pelo nome** via exports `il2cpp_domain_assembly_open` → `il2cpp_class_from_name` → `il2cpp_class_get_method_from_name` → `MethodInfo.methodPointer`: não depende de offsets de código e sobrevive a updates, desde que os nomes não mudem.
- Hooks que funcionaram: `BattleScreenUI.HandleCombatStart/Turn/End` (disparados por delegate), `CombatManager.StartPvEBattle`, `GameManager.ShowScreen`, `SaveSystem.Save`, `InventoryManager.AddItem`, `AutoFightController.SetOn/HandleStaminaDepleted`.
- **Não disparam** (inlinados na corrotina): `CombatManager.EndBattle`, `GenerateDropItem`. Regra: preferir handlers de evento/UI chamados por delegate.
- Exemplo de evento: `combat_end {won, xp: 366, drop, hpLeft: 162, sectorCleared, rpDelta, leveledUp, newLevel}`; `combat_start {enemy: Thief, color: Blu, level 9, maxHp 1040, dropChance 0.12}`; ~2 turnos/s.
- Reuso: o bombfarm-companion já empacota o frida no Electron (`asarUnpack: node_modules/frida/**`, consent gate, watchdog de silêncio, timeout de detach). npm 11 bloqueia install scripts por padrão; o `frida_binding.node` veio no pacote.

## S5 — Catálogo (`spikes/s5_catalog.py` → `game-data/items.json`, `sectors.json`)

- `sharedassets0.assets`: 424 `ItemData`, 7 `SectorData`, 35 `EnemyCategoryData` (sem typetree → parser manual pela ordem dos campos do dump).
- Itens: Common 90 · Rare 91 · Epic 86 · Legendary 82 · Mythic 60 · Ascended 15. **23/23** itens do inventário atual conferem (nome e stats).
- Drop por setor (common/rare/epic/legendary): Outskirts 92/8/0/0 · Village 85/15 · Forest 74/25/1 · Graveyard 54/32/14 · War Camp 39/36/25 · Uhn-Baa Gorge 30,5/36/33/0,5 · Cave 26/32/40/2.
- Chance de drop por cor de inimigo (Frida): Grigio 0,08, Blu 0,12. `resources.assets` traz a localização (inclusive **pt-BR**).

## Automações: o que faz sentido

- **Monitor e alertas** (save + Frida): drop raro, level up com pontos a distribuir, morte repetida no setor (sugerir equipamento/stats), stamina baixa, inventário perto do cap (150), autofight desligado (e se foi pelo jogador ou por falta de stamina), resultado de PvP, XP/h, drops/h, ETA do próximo nível e do fim do setor.
- **Planner**: comparar itens do inventário com o catálogo, sinergias de elemento e simular PWR.
- **Ações:** o jogo já automatiza luta, descanso e PvP. As ações candidatas (reativar o autofight, fechar popup) teriam pouco ganho e esbarram no desarme por clique. Se quiser, dá para retomar o S3 com um botão de efeito conhecido.
- **Fora:** escrever no save/memória, chamar métodos do jogo via Frida (isso seria um mod), speed/time hacks, automação de PvP/ranking, meta-ações para enganar o Murato.

## Fase 2 — MVP (2026-09-22, lançado como Lootborne Companion)

App Electron + React + Tailwind v4 todo em Node/TypeScript (ver [README.md](README.md)).

- **Save + replays** sempre ligados; **modo ao vivo (Frida)** opt-in, com agente só de observação que resolve classes, métodos **e offsets de campo** por nome (`il2cpp_class_get_field_from_name` + `il2cpp_field_get_offset`): 10/10 hooks e nenhum campo faltando no build atual.
- Validado com o jogo aberto: inimigo ao vivo (nome, cor, HP por turno, chance de drop), HP/stamina/XP do jogador a 1 Hz, lutas da timeline mescladas com o nome do inimigo, **PWR do jogo = 757 = PWR estimado** pela fórmula recuperada.
- Lições: `ptr` é global no Frida (redeclarar quebra o agente, e `script.load()` não rejeita por isso; o host só considera "ao vivo" depois do `ready`); `PrintWindow` de janela Electron coberta devolve frame velho (para checar, usar o DevTools protocol com `LBC_DEBUG_PORT`).
- Pendências: meta de XP por nível (só aparece quando o jogo chama `XPSystem.XPNeededForNextLevel`); perks no PWR estimado; empacotar instalador (`asarUnpack` do frida, como no bombfarm-companion).

## Modelo de combate (2026-09-22) — `src/shared/combat.ts`

Recuperado do ISIL (`CombatManager.ResolveAttack`, `PickEnemyForBattle`, `PickCategoryByGaussian`, `CombatRuntimeEffects.StepTurnAndGetDamageMultiplier`, `GameConstants`) e conferido em lutas reais:

- **Dano por golpe** = `max(1, RoundToInt(ATK × U(0,8–1,2) × [2 no crítico] × mult × 60 / (60 + DEF)))`. A DEF é **proporcional** (DEF_K = 60), nunca zera o dano. Conferido: sem crítico 21–30 observado vs 20–30 previsto; médias 28,0/30,3 vs 29,1/29,6 (jogador) e 5,0/4,8 vs 5,4/4,9 (inimigo).
- **Parry** = `Random.value < PARRY/100` anula o golpe; **crítico** = `CRIT/100` (teto 60). Turnos alternados, jogador primeiro, 0,4 s cada (0,5 / GAME_SPEED 1,25).
- **Depois de cada vitória**: `+RoundToInt(HPmáx × REGEN_BASELINE_PCT_BY_SECTOR[setor])` + "Regeneration: +N HP" dos itens. Tabela lida ao vivo: `[0,09; 0,13; 0,13; 0,12; 0,09; 0,07; 0,09]`.
- **Morte**: o setor volta ao inimigo 0 (`DEATH_CHECKPOINT_KEEP_FRAC = 0`). **Morte súbita** (60 turnos, +5% a cada 10) só no PvP.
- **Perks**: `PerkCombat.GetPerkModifiers` lido ao vivo (Voto Carmesim = `flatHealPerHit 3`, cura por acerto seu que conecta). Stats finais exatos via `StatsCalculator.GetTotalStats`.
- **Inimigos do setor**: stats vêm direto de `EnemyCategoryData.variants` (`game-data/enemies.json`, igual ao `EnemyState` ao vivo). Categoria por gaussiana (σ = 0,5/n) no progresso `índice/total`; cor pelo progresso dentro da faixa da categoria (<30%: 80/20/0, 30–70%: 30/45/25, >70%: 0/65/35 Grigio/Blu/Viola); drop 8/12/20%.
- **Uso no app**: aba Build → "Onde investir os pontos" (chance de fechar o setor, DEF alvo, HP por luta, sugestão ponto a ponto) e aba **Simulador** (Monte Carlo luta a luta com o HP carregado entre lutas, curva de sobrevivência, vitória por inimigo, DEF de equilíbrio).
- Exemplo real (nível 9, Village, ATK 28,2 / DEF 12,1): fechar o setor 27% → +5 DEF 85% → +5 DEF +15 ATK 99,7%. No Forest (nível 10) o setor não fecha (Gnoll ATK 15–19); a tentativa média para no inimigo ~11 de 58, o que bateu com a morte real no inimigo 8.

### Elementos (2026-09-22)

`ResolveAttack` aplica elemento **só no dano do jogador** (o golpe do inimigo não tem elemento):
para cada arma equipada, se o elemento bate com `EnemyState.weakElement` conta +1; se bate com
`resistElement`/`resistElement2`, conta −1. O dano é multiplicado por `1 + fracos×0,15 − resistidos×0,15`,
e com **as duas armas na fraqueza** o bônus vira `ENEMY_WEAK_BOTH_WEAPONS_PCT = 0,40` (lido ao vivo)
em vez de 0,30. Constantes: `GameConstants.ENEMY_RESIST_PCT = 0,15`.
Resistência/fraqueza vêm de `EnemyCategoryData` (por categoria, iguais para as três cores) e estão em
`game-data/enemies.json`; conferido com o `EnemyState` ao vivo (Kobold: resiste Flame, fraco a Shadow).
Uma poção/efeito com a flag de "ignora resistência" existe no código e não está modelado.
No app: multiplicador por inimigo na tabela do Simulador e ranking de elementos por setor no painel da Build.

## PvP: o que o replay entrega (2026-09-22)

`Replays\<steamid>_<ticks>.json` (`AutoBattle.Replay.ReplayData`) tem muito mais do que a primeira
versão lia:

- **`ReplayFighter`** dos dois lados: `name, level, characterType, maxHp, badgeId` e
  `equippedItems[] {slotName, itemName, rarity, category}` — ou seja, **o equipamento completo do
  adversário**, com raridade e elemento por peça.
- **`ReplayTurn`**: além de `damage/crit/parried/hpPlayer/hpEnemy`, traz `healPlayer`, `healEnemy`,
  `counterPlayer`, `counterEnemy` e `suddenDeath`. O mesmo vale para `CombatTurnResult` ao vivo
  (`healFromEffect`, `enemyHealFromEffect`, `counterAttackDamage`, `enemyCounterAttackDamage`).
- **`ReplayStore.Prune` mantém só os 15 arquivos mais recentes.** Por isso o Planner copia cada
  replay para `%APPDATA%\lootborne-planner\pvp\raw\` e guarda um resumo por linha em `index.jsonl`;
  o histórico completo é nosso, não do jogo.

### Atributos do adversário

Os atributos de um item são **fixos por template**: as 108 instâncias do inventário batem exatamente
com `game-data/items.json`. Então o nome da peça no replay reconstrói a contribuição do equipamento
dele sem margem de erro (sinergias incluídas).

O resto (pontos e perks) sai da própria luta, invertendo a fórmula de dano. Como
`E[U(0,8;1,2)] = 1`, a média dos golpes (crítico normalizado por ÷2) dá direto:

```
ATK_dele = média(dano dele) × (60 + DEF_nossa) / 60
DEF_dele = 60 × ATK_nossa / média(dano nosso) − 60
```

Isso só funciona com **um lado ancorado**: inverter os dois ao mesmo tempo não tem solução única (a
primeira tentativa, com um chute para a DEF dele, deu ATK entre 46 e 100 para a mesma build). O
Planner ancora no nosso lado, que é conhecido: `GetTotalStats` ao vivo quando o PV máximo ainda
bate, senão o equipamento do próprio replay + a distribuição de pontos do save + `PerkModifiers`.
Erro padrão da média: `11,55% / √n` (n ≈ 20 golpes por luta → ~2,6%).

Os valores medidos são **efetivos**: já incluem os perks dele (`activeEnemyPerkMods` existe em
`CombatManager`; perk 22 chega a dobrar o dano, perk 14 dá +30% só no PvP) e o elemento das armas.
Por isso a estimativa costuma ficar acima da soma "equipamento + pontos", e o app diz isso.

**Caminho exato:** com o modo ao vivo ligado, `BattleScreenUI.HandleCombatStart` entrega o
`EnemyState` do oponente de PvP já montado pelo jogo — `atk/def/crit/parry` reais. O Planner guarda
isso por nome em `pvp-scouts.json` e prefere esses números sempre que existirem.

Pontos por nível: `(nível − 1) × 5` (conferido com o save: 115 pontos no nível 24).

## Os 357 de PWR que faltavam no estimado (2026-09-22)

O painel mostrava "poder estimado 1.529" contra "poder no jogo 1.886". Medindo com o jogo aberto
(build do nível 25: 470 PV / 26,1 ATK / 75,9 DEF / 14,4 CRIT / 13,5 PARRY antes de sinergias), o
`GetTotalStats` devolvia **543 / 42,328 / 102,465 / 30,64 / 13,5**. Eram três causas somadas.

### 1. "For every other X item" rende 1,3× o que o texto diz, e trunca

`StatsCalculator.ApplySynergyBonuses` (lido em execução com `spikes/frida/synergy.js`, que só observa
o `ref PlayerStats` antes e depois de cada chamada):

```
count = elementalCounts[elemento]          // todos os itens equipados daquele elemento
se count <= 1: nada
bônus = (count - 1) × valor × 1.3          // 1.3f vem do .rdata (0x182A1C498)
HP, ATK e DEF: truncados para inteiro (cvttss2si); CRIT e PARRY ficam fracionários
```

Cada `Adept's Rod` ("For every other Arcane item: +0.8% CRIT and +1.3 ATK") com 4 itens Arcane dá
`trunc(3 × 1,3 × 1,3) = 5` de ATK e `3 × 0,8 × 1,3 = 3,12` de CRIT — eu calculava 3,9 e 2,4.
O passe cruzado (`ApplyCrossSynergyBonuses`, "If equipped with an X item", "If dual wielding…") usa o
valor do texto tal como está, com a mesma truncagem em HP/ATK/DEF.

### 2. Os perks mudam os atributos, e o estimado os ignorava

O fim de `GetTotalStats`, nesta ordem exata:

```
se defToAtkPct > 0:  atk += def × defToAtkPct     (a DEF ainda sem o multiplicador dela)
atk += atkFlat
atk *= 1 + atkPct
defPct += min(parry, 55) × defPctPerParryPoint
def *= 1 + defPct
hp   = max(1, RoundToInt(hp × (1 + maxHpPct)))
crit += critFlat
```

`critCap` e `parryFloor` não entram aqui — são de combate.

### 3. PWR tem um peso fixo por perk

`GetPowerScore(stats, state)` = o score dos atributos (truncado) **+ `PerkSystem.GetTotalPerkPsWeight(state)`**,
que soma `PerkData.psWeight` dos perks equipados. Voto Carmesim 60 + Pele de Dragão 55 + Ira Reprimida
50 = **165**. Os 31 pesos foram lidos de `PerkCatalog.All` e estão em `game-data/perks.json`; o agente
relê a tabela ao ligar, então um rebalanceamento do jogo não quebra a conta.

### Resultado

Com as três correções o cálculo offline reproduz o jogo **exatamente**: 543 / 42,328 / 102,465 /
30,64 / 13,5 e PWR 1886. Coberto por testes em `src/shared/game-math.test.ts`.

## Poções (2026-09-22)

O save guarda `activeConsumableIds` + `activeConsumableRemaining` (segundos). O catálogo é montado em
código (`ConsumableCatalog.All`, 21 poções, lido do processo com `spikes/frida/catalog.js`) e o que
cada uma faz sai de `ConsumableSystem.GetActiveModifiers`, que é uma **tabela de salto por id**: cada
caso soma (ou multiplica, ou atribui) um campo de `ConsumableModifiers` com uma constante.

`spikes/s6_consumables.py` percorre a tabela em `GameAssembly.dll` e decodifica os 28 casos direto
dos bytes — sem confiar no texto da poção. Resultado conferido ao vivo: a poção ativa do jogador
(id 6, Feline Reflexes) devolveu `parryFlat: 16`, igual ao decodificado.

| id | nome | modificador |
|---|---|---|
| 1 | Bastion | `damageTakenMult 0.8` |
| 2 | Fury | `atkPct 0.25` |
| 3 | Rampart | `defPct 0.30` |
| 4 | Vigor | `maxHpPct 0.20` |
| 5 | Savagery | `critFlat 20` |
| 6 | Feline Reflexes | `parryFlat 16` |
| 7 | Regeneration | `endOfFightHealPct 0.18` |
| 8 | Bloodthirst | `lifestealPct 0.05` |
| 10 | Armor Breaker | `ignoreEnemyDefPct 0.30` (teto de 0.75) |
| 11 | Tireless | `noStamina` |
| 13 | Attrition | `enemyHpMult 0.85` |
| 14 / 19 | Seeker's Luck / Heavy Haul | `dropRateBonus 0.08 / 0.10` |
| 15 | Wisdom | `xpBonusPct 0.20`, `xpFloorPctOfBase 0.25` |
| 16 | Collector's Eye | `higherRarityBonus` |
| 25 | Sunder Oil | `sunderPerHit 4` |
| 26 | Executioner's Draught | `executeBelowHpBonus 0.40` (abaixo de 50% da vida) |
| 27 | Immolation | `immolationPctPerTurn 0.005` (turno = 0,4 s → 1,25%/s) |
| 28 | Piercer | `ignoreAllResist` |
| 29 / 30 | Elixir / Greater Elixir | instantâneas, sem efeito contínuo |

Modelado em `src/shared/consumables.ts`: os percentuais caem sobre os atributos finais (depois de
itens e perks), e os que mexem no inimigo (penetração de armadura, vida, execução, queimadura,
sunder, ignorar resistência) entram no `simulateFight`. A tela do Simulador lista todas e compara
"com" × "sem poção".

De brinde: `LocalizationManager.entries` (dicionário key→texto da língua ativa) é legível pelo mesmo
caminho. O idioma do jogador está em **en**, então os nomes do catálogo já são os que ele vê na tela.

## Revisão do simulador (2026-09-22)

O simulador estava subestimando a build: três efeitos de item ficavam de fora, todos a favor do
jogador. Eles existem no jogo como `CombatRuntimeEffects` / `PendingAttackMod` e agora estão no
modelo (`itemSustain` → `PlayerProfile` → `simulateFight`/`expectFight`):

| efeito no item | como o jogo aplica | valor médio |
|---|---|---|
| `Every N attacks: +X% damage next attack` | `EveryNAttacksEffect { everyN, modTemplate }`: o contador dispara e o **próximo** golpe leva o bônus | +X/N por golpe |
| `On parry: next attack has 100% CRIT` | `PendingAttackMod.overrideCritPct` armado ao aparar | crítico garantido em `parry%` dos golpes |
| `Below X% HP: regenerates N HP/sec` | `CalcBelowHpPctRegen` | só enquanto a vida está abaixo do limiar |

Medido na build real do jogador (nível 31, War Camp, 67 inimigos), 2000 voltas:

```
SEM esses efeitos : metade das voltas para no inimigo 7
COM esses efeitos : metade das voltas passa do inimigo 15
no jogo           : inimigo 7, 31 lutas e 2 mortes no setor (subindo do nível 25 ao 31 no meio)
```

Duas cópias `Flaming Axe` ("a cada 4 ataques: +30%") valem +15% de dano médio, e o pingente que dá
crítico garantido ao aparar leva o crítico efetivo de 38,9% para ~50,8% com PARRY 19,4 — juntos,
cerca de +25% de dano. O Simulador agora lista em chips o que entrou no cálculo e quantos efeitos
ficaram de fora (na build atual, só reduções de stamina e chance de drop).

## Efeitos de item: cobertura completa (2026-09-22)

Os 424 itens têm **622 efeitos em 164 formatos distintos**. O parser em `src/shared/item-effects.ts`
entende hoje **260 procs**; sobram 4 linhas, todas com tradução quebrada pela metade ("Below 25% HP:
ogni attacco deals +10 damage"). O resto são sinergias de atributo (tratadas em `game-math`) ou
coisas fora de combate (stamina, drop, Bloodmarks).

Famílias que entraram no `simulateFight`:

| família | exemplo | classe no jogo |
|---|---|---|
| contador de ataques | "Every 4 attacks: +30% damage next attack" | `EveryNAttacksEffect` + `PendingAttackMod` |
| contador de críticos | "Every 3 critical hits: next attack deals triple damage" | `EveryNCritsEffect` |
| no crítico | "+N bonus damage", "regenerates N HP", "reduces enemy DEF by N", "next attack ignores DEF", veneno | `CalcOnCrit*` |
| ao aparar | contra-ataque, cura, "+N DEF pelo resto", crítico/dano/ignorar parry no próximo golpe | `PendingAttackMod` |
| abaixo de X% de vida | +ATK%, +ATK, +DEF%, +tudo, lifesteal, regen/s, regen por golpe, absorver, imune a crítico | `CalcBelowHpPctRegen`, `CalcConditionalDamage` |
| primeiros golpes | "First attack of combat is a guaranteed critical", "On first hit taken: absorb N%" | `PendingAttackMod` |
| a cada N golpes recebidos | "completely absorb the next" / "damage halved" | `CalcEveryNSecMaxStack` |
| temporizadores | "Every N sec: regenerates N HP / +N temporary ATK / +N to all stats" | `CalcTimedRegen`, `CalcEveryNSecTemporaryBuffs` |
| penetração permanente | "Your attacks ignore N% of enemy parry and N% of enemy DEF" | `CalcPassiveIgnore` |
| reflexo e execução | "Reflects N% of damage taken", "+N% damage to enemies above N% HP", "On kill: ..." | `CalcReflect`, `CalcConditionalDamage` |

O Simulador mostra em chips tudo o que entrou e quantas linhas ficaram de fora.

## Ícones do jogo (2026-09-22)

`spikes/s7_icons.py` extrai a arte com UnityPy e monta uma sprite sheet por família:

- **itens**: `ItemData.icon` é um PPtr para um `Sprite` em `sharedassets0.assets`. O leitor manual
  percorre os campos na ordem de declaração até o ponteiro. Os 424 casam com o nome do item
  (`Iron Helm` → `Iron_helm_icon`), todos 28×28.
- **perks** e **poções**: ficam em `Resources/`, e o mapa path→objeto está no `ResourceManager` de
  `globalgamemanagers` (`perkicons/01_pent_up_wrath`, `consumableicons/armor_breaker`). Os nomes de
  arquivo largam o possessivo ("Seeker's Luck" → `seeker_luck`) e um está com typo (`rampant`).

Saída: `game-data/icons/{items,perks,consumables}.png` + `index.json` (233 KB no total, 473 ícones).
`src/renderer/src/icons.tsx` posiciona a sheet por índice com `image-rendering: pixelated`.

## Ranking de equipamento por dano, não por PWR (2026-09-22)

O planejador ordenava tudo por `powerDelta`. PWR é a vitrine do jogo — `0,8·HP + 9·ATK + 6·DEF +
6·CRIT + 8·PARRY` — e **não sabe contra quem você luta**: ignora fraqueza e resistência de elemento
do setor e ignora os procs do item.

`src/shared/gear-advisor.ts` monta um `PlayerProfile` de verdade para cada candidato e mede contra a
**mistura de inimigos do setor** (`sectorMix`, os mesmos pesos que o simulador sorteia). Custo: 125
candidatos em ~47 ms.

Na build real do jogador (War Camp) as duas ordens divergem: no Trinket, PWR escolhe o Dawnguard
Pendant (+4,0% de dano) enquanto o ranking por dano escolhe o Crystal Shard (+7,6%).

## Perks fora do loadout equipado (2026-09-22)

`PerkCombat.GetPerkModifiers` só descreve o que está equipado, então não dá para projetar uma troca
de perk a partir dele. `src/shared/perk-mods.ts` tem a tabela dos 31 perks, cada um dividido em:

- `stats` — o que `GetTotalStats` aplica (aparece na ficha e no PWR)
- `combat` — o que `PerkCombat` aplica na luta
- `procs` — mecânicas de gatilho, na mesma forma dos efeitos de item, para se fundirem com eles

A tabela é conferida contra o merge que o jogo reportou ao vivo: Voto Carmesim + Pele de Dragão +
Relâmpago Engarrafado → `atkPct 0,28 · defPct 0,35 · maxHpPct 0 · flatHealPerHit 3`. Quatro perks
ficam marcados como não simulados (Chamado do Rival é só PvP, Eco Espelhado copia o vizinho, Anjo da
Guarda e Último Suspiro são de uma vez por luta).

**Bug corrigido de brinde:** o `perkMods` em cache continuava valendo depois de trocar de perk. Agora
guardamos junto o loadout que o produziu (`perkModsIds`) e, se não bater, a tabela assume.

## Dois objetivos de otimização (2026-09-22)

O otimizador tinha "dano" e "XP/h", e o segundo estava errado: media XP por segundo de luta, ignorando
**onde** a build morre. Quem morre no inimigo 3 só farma os três primeiros, que são os que dão menos XP.

`sectorRun` percorre uma tentativa inimigo a inimigo carregando o HP entre lutas (como o jogo faz) e
devolve a profundidade, o XP do ciclo e o tempo do ciclo. Daí saem as duas métricas:

- **Farmar XP** = `xpPerAttempt / secondsPerAttempt`, ou seja, o ciclo real: lutar até morrer, o setor
  volta ao inimigo 0 com vida cheia, repetir. `DEATH_CHECKPOINT_KEEP_FRAC = 0` e a pausa entre lutas é
  `PAUSE_BETWEEN_BATTLES = 2 s`; não há penalidade extra de morte, então ciclos curtos são legítimos.
- **Progredir** = a profundidade da tentativa, desempatada pelo HP restante no ponto mais fundo.

Os XP por inimigo são exatamente os do catálogo — conferido contra o histórico de lutas do jogador
(Black Orc Grigio 12.672 · Blu 15.664 · Viola 18.936, idênticos ao `xpBase`).

Na build do jogador (nível 34, War Camp) os dois objetivos dão respostas opostas:

```
progredir  776 mil XP/h · chega ao inimigo 18 · ciclo de 259.410 XP em 1.203 s
farmar XP  2,19 mi XP/h · chega ao inimigo  3 · ciclo de  39.811 XP em    65 s
```

`XP_DEFEAT_MULTIPLIER = 0.5`: a luta perdida ainda paga metade do XP (o modelo conta zero, então é
conservador).

## Penalidade de XP por excesso de nível (corrige o modelo de farm)

`GameConstants` define `XP_SCALING_PENALTY = 0.12`, `XP_OVERLEVEL_FREE_BAND = 3` e
`XP_SCALING_MIN = 0`. O inimigo paga:

```
xp = xpBase × max(0, 1 − 0,12 × (nossoNível − nívelDoInimigo − 3))
```

Conferido contra **2.647 lutas vencidas do nosso próprio histórico**: todo pagamento observado é
`xpBase` vezes um valor de {1,00 · 0,88 · 0,76 · 0,64 · 0,52 · 0,40 · 0,28 · 0,16}. O `1,5×` que
aparece em algumas linhas é `SECOND_WIND_XP_MULTIPLIER`.

O modelo antigo usava `xpBase` cru e por isso superestimava muito o farm. No nível 46, em War Camp:

| inimigo | nível médio | paga | XP |
|---|---|---|---|
| 0 | 32,8 | **3%** | 13.270 → 436 |
| 10 | 35,5 | 19% | 14.966 → 2.869 |
| 30 | 39,7 | 58% | 15.838 → 9.150 |
| 66 | 45,4 | 100% | 16.809 → 16.778 |

Consequência prática: **os primeiros inimigos de um setor são os de nível mais baixo, logo os mais
penalizados**. A recomendação anterior de "morrer cedo para reiniciar rápido" estava errada — ela
farmava exatamente os inimigos que pagam menos.

## Cobertura dos efeitos de item

As 622 ocorrências (336 strings distintas) dos 424 itens, por camada:

| camada | strings | ocorrências | onde |
|---|---|---|---|
| sinergia (estatística) | 125 | 247 | `game-math.synergyBonus` → `GetTotalStats` |
| proc (combate) | 171 | 264 | `item-effects.parseProcs` |
| economia (fora de combate) | 26 | 94 | drops, Bloodmarks, stamina |
| **sem modelo** | **0** | **0** | — |

Quatro famílias estavam de fora e foram implementadas a partir das regex do próprio jogo
(`re/isil … StatsCalculator`):

- `^For every different element category equipped:` — multiplicador = `categoryCount`
  (`ApplyCrossSynergyBonuses`, offsets 335/345). HP/ATK/DEF truncam (`cvttss2si`), CRIT/PARRY não.
- `^If equipped with ([^:]+):` — o catch-all para nome de item, com `" or "` e o prefixo `"a Shield"`.
- `CalcUnconditionalStatPct` — `+25% DEF and +10% HP`, `+18% ATK, -10% DEF`. **Não entram em
  `GetTotalStats`**, então não aparecem no PWR; valem só na luta.
- `CalcAllStatsPerOtherEquippedItem` — `+1 to all stats for every other equipped item`.

Nenhum item do save atual usa essas quatro; os 17 que usam são todos Legendary/Mythic.

## PvP: o que decide as lutas

96 lutas arquivadas, 58V/38D. Separando por resultado:

| | vitórias | derrotas |
|---|---|---|
| nosso dano/turno | 20,19 | 18,69 |
| dano deles/turno | 10,76 | **16,51** |
| nossa taxa de parry | 23,3% | **15,3%** |
| HP efetivo nosso | 68,4 | **44,0** |
| HP efetivo deles | 42,7 | 42,3 |

O HP efetivo **deles** é idêntico nos dois casos: nosso ataque não separa vitória de derrota.
Sobrevivência sim.

**Não dá para reconstruir um adversário pelo equipamento.** No nível 46 são 225 pontos de atributo,
muito mais do que o equipamento vale, e o replay não diz onde foram — nem registra perks.
Reconstruindo e chutando os pontos, a previsão acerta 41–56% (moeda); com os números *observados*,
81%. Além disso são **96 adversários distintos em 96 lutas** — nunca repetimos ninguém.

Por isso `pvp-optimizer.ts` não reconstrói: usa o que o replay mediu (HP máximo, dano por golpe,
taxa de crítico, taxa de parry) e reescala só o que depende da build sendo avaliada, pelo
`60/(60+DEF)` do próprio jogo. O lado *nosso* é exato.

## Perks no PvP: onde eles existem

`ReplayFighter` tem exatamente seis campos — `name`, `level`, `characterType`, `maxHp`,
`equippedItems`, `badgeId`. **Nenhum perk.** Um replay antigo nunca vai mostrar os perks de ninguém,
nem os nossos.

Mas `AutoBattle.Steam.PlayerSnapshot` tem, e é o que a arena usa para montar a luta:

```
playerName, level, powerScore, hp, atk, def, crit, parry,
equippedItems, equippedPerkIds, rankingPoints, mmr, totalPvPMatches, ...
```

O agente ganhou um hook somente-leitura em `PlayFabManager.SnapshotToEnemyState(PlayerSnapshot)`,
que roda quando a arena transforma um adversário em inimigo. Confirmado ao vivo:

```
{"ev":"pvp_snapshot","name":"猪猪子","level":55,"power":3658,"maxHp":689,
 "atk":101.8,"def":259.5,"crit":35.38,"parry":16.75,
 "perkIds":[12,1,4,17],"rankingPoints":-1,"mmr":1878,"matches":475}
```

Ou seja: com o modo ao vivo ligado temos os **atributos exatos e os perks** do adversário, não uma
reconstrução. Isso resolve a limitação registrada acima (reconstruir pelo equipamento acerta ~50%).
Sem o modo ao vivo, nada disso existe.

## Por que perdemos para bajanggg (23/09, nível 50 contra o nosso 46)

110 turnos, derrota com ele ainda em 452/761.

| | nós | bajanggg |
|---|---|---|
| ataques / acertos | 55 / **17** | 55 / 31 |
| aparados pelo outro | **69,1%** | 43,6% |
| críticos (dos acertos) | 52,9% | **80,6%** |
| dano causado | 551 | 623 + **277 de contra-ataque** |
| cura | 160 | **242** |
| DEF só do equipamento | 38,9 | **62,1** |
| PARRY só do equipamento | 26,7 | **37,1** |
| sinergia de DEF | +2,0 | **+18,0** |

O motor da build dele: **aparar alimenta o crítico, que alimenta a cura.** Os dois lados usam o mesmo
Dawnguard Pendant ("On parry: next attack has 100% CRIT") e o mesmo Judgment Hammer ("On critical
hit: regenerates 8 HP"). Conferido turno a turno:

- golpes dele logo depois de aparar: **23/23 críticos (100%)**; golpes normais: 2/8 (25%)
- os nossos logo depois de aparar: **9/9 (100%)**; normais: 0/8 (0%)

Como ele aparou 38 dos nossos 55 ataques e nós só 24 dos dele, ele acionou o combo 23 vezes contra
as nossas 9. A cura dele anulou **44%** do nosso dano; o contra-ataque dele (que não vem de item
nenhum do equipamento — é perk, que o replay não registra) foi **31%** do dano que levamos.

Ele monta isso com 5 peças Frost + **Glacial Shield**, que liga "If equipped with a Shield: +4 DEF,
+2% PARRY" (Tempest Belt) e três cláusulas "For every other Frost item". Nós temos escudo na bolsa
(Sergeant's Shield, Faith Shield) mas não usamos.

Parte disso foi azar: `PARRY_CAP = 55`, então os 69,1% observados são uma cauda de ~2 sigma sobre o
teto. A luta escolhida foi justamente a pior, o que enviesa a leitura.

## PvP: o otimizador agora simula as lutas

O modelo anterior (valor esperado: dano por turno de cada lado, razão de sobrevivência) não tinha
procs, perks nem morte súbita. Nas 27 lutas feitas com a build de hoje (stats exatos do jogo) ele
acertava **48,1%**, Brier **0,377** — pior que chutar sempre o resultado mais comum (0,250).

`duel.ts` simula a luta golpe a golpe com os dois lados completos; `pvp-opponent.ts` monta o
adversário a partir do replay. Nas mesmas 27 lutas: **66,7%**, Brier **0,206**. Em todas as 168:
73,8%, Brier 0,184 (antes 67,9% / 0,217).

### Mecânicas recuperadas do jogo e das lutas arquivadas

- **Morte súbita** (`CombatRuntimeEffects.StepTurnAndGetDamageMultiplier`): a partir do 60º golpe da
  luta, dano × 1,05^(⌊(golpe−60)/10⌋+1), teto 1000 (.rdata 1.05f / 1000f). Só no PvP.
- **Armor Piercer é multiplicativo**: `ResolveAttack` faz parry × (1 − `passiveParryIgnorePct`). O
  simulador de PvE subtraía (55% → 20% em vez de 35,75%). Corrigido nos dois.
- **Crítico armado sobrevive a um golpe aparado**: o crítico garantido do Dawnguard Pendant espera o
  próximo golpe que *acerta*. Em 224 de 224 golpes armados assim, crítico. Os dois simuladores
  descartavam. Corrigido nos dois.
- **Thorns** devolve 50% do dano recebido, sem mitigação por DEF (0,50 em 30 lutas, qualquer DEF).
- **Mirror Echo** copia o perk à esquerda: KISA rodava Thorns + Mirror Echo e devolveu 564 de 564.
- **Last Breath**: um golpe letal por luta deixa 25% da vida (bilibili: 130 → 167 = 25% de 667).
- **Rival's Calling** +30% só no PvP; **Colossus Hunter** e **Coup de Grace** só no PvE.
- Quando o golpe mata o defensor e o reflexo mata o atacante, perde quem levou o golpe.

### Adversários sem os números do jogo

Sem o modo ao vivo, os stats vêm da própria luta, mas só de golpes "limpos": antes do golpe 60,
sem crítico, não armados por aparada, fora do primeiro golpe (absorção), com o atacante acima de 50%
da vida. A média crua contamina tudo — o crítico de bajanggg era 81% porque cada aparada armava um
crítico garantido. Perks deduzidos por assinaturas que item nenhum produz: Thorns (0,5 do golpe
volta), Thorns + Mirror Echo (1,0), Crimson Vow (cura múltiplos de 3 por acerto), Last Breath (golpe
letal → 25%), Dying Fury (golpes 1,5×+ mais fortes abaixo de 40%), Armor Piercer (nosso parry a ~65%).

### O que decide as derrotas recentes

Contrafactual nas 15 derrotas com a build de hoje (quanto a nossa chance sobe removendo cada
mecânica do adversário): parry deles +35,8 pp, Thorns +23,9, cura +16,7, crítico pós-aparada +13,5,
Armor Piercer +10,9, Last Breath/vida baixa +7,0. Eles estavam 2,3 níveis acima em média.

No histórico real: com Thorns vencemos 66% (35/53), sem Thorns 53% (61/115); contra quem tem Thorns,
45% (21/47).

## Novo nome: Lootborne Planner (v0.9.0)

O app passou a se chamar **Lootborne Planner**. Além do texto, mudam:

- o executável (`Lootborne Planner.exe`), o zip (`Lootborne-Planner-v*-win-x64.zip`), o título da
  janela e das notificações;
- a ponte do preload: `window.planner` (`PlannerApi`) no lugar de `window.companion`;
- as variáveis de dev: `LBP_DEBUG_PORT`, `LBP_GAME_DATA_DIR` (e `LBP_OUT`/`LBP_AGENT` nos spikes);
- **a pasta de dados**: o Electron dá à pasta o nome do app, então ela passa de
  `%APPDATA%\lootborne-companion` para `%APPDATA%\lootborne-planner`.

Por causa da pasta, `storage/migrate.ts` copia na primeira execução o que é nosso (configurações,
`combat.json`, scouts, tabela de XP, histórico e o arquivo de PvP — a única cópia das lutas além das
15 que o jogo guarda). **Copia, não move**: a pasta antiga fica como backup. Roda uma vez (marcador
`.migrated-from-companion`) e nunca sobrescreve o que já existir na pasta nova.

A pasta do projeto continua `Documents\lootborne-companion`; renomeá-la é só uma questão de disco.

## Perks: como o jogo aplica cada um (validação dos ouros, v0.10.0)

Os perks foram modelados a partir da *descrição*. Decodificando o jogo (`spikes/s8_perks.py`):

**`PerkCombat.ApplyPerk`** é um `switch` de 30 casos cujo corpo nenhuma ferramenta atribui a um método
(o Cpp2IL desiste); a tabela de saltos está em RVA `0x1B35BC`. Cada perk é aplicado **no máximo uma
vez** (bitmask `1 << id` em `PerkModifiers+0x7C`). Vários números passam por **`PerkEconomy.V(v1, v2)`**,
um seletor entre duas versões de balanceamento (`PerkEconomy.IsV2`):

| perk | v1 | v2 (em uso) |
|---|---|---|
| 5 Rising Momentum (ouro) | +5%/acerto, 10 acúmulos | **+4%/acerto, 10 acúmulos** (em `ResolveAttack`) |
| 9 Bottled Lightning | −25% vida | −15% |
| 10 Dragonhide | −25% ATK | −12% |
| 13 Reckless Abandon | ×1,2 dano | ×1,3 |
| 14 Rival's Calling (PvE) | ×0,95 | ×1,0 (PvP ×1,3 nas duas) |
| 17 Colossus Hunter | 2% | 1,5% |
| 18 Tenacity (ouro) | 3% | 5% |
| 21 Burning Heart | ×1,35, sem regen de fim de luta | ×1,5, regen mantida |
| 22 Duelist's Gamble (ouro) | recebe ×1,5 | recebe ×1,25 |
| 23 Blood Curse (ouro) | roubo 15%, −1% vida/turno | roubo 13%, 11% do dano causado drena |
| 24 Coup de Grace | 15% | 20% |
| 27 Critical Apex | teto 65, +0 CRIT | teto 75, +15 CRIT |

**O jogo roda a v2**: o toque ao vivo leu ATK +0,28 para `[12,11,10,9]` (0,40 − 0,12; na v1 seria
0,40 − 0,25) e ×1,3 para Reckless Abandon. Toda a nossa tabela é v2.

**Perks de texto.** 6, 7, 8, 11, 19, 25, 26, 28 e 31 não fazem nada em `ApplyPerk`: a mecânica é um
**texto de combate** (`PerkData.combatEffect`) que `StatsCalculator.ForEachEquippedEffect` passa pelos
mesmos parsers dos itens; **Mirror Echo** (`PerkSystem.MirrorEchoLeftNeighborId`) passa o texto do
vizinho da esquerda de novo — é só isso que ele copia. O texto de combate nem sempre é a descrição:

| perk | descrição | texto de combate (o que vale) | antes |
|---|---|---|---|
| 8 Aggressive Riposte (ouro) | próximos 2 ataques +35% | "next 2 attacks have +35%" | modelávamos 1 ataque |
| 28 Bulwark (ouro) | "heal 4 HP per second" | "regenerates **8 HP**" (a regex do jogo lê isso como /s) | 4 HP/s |
| 23 Blood Curse (ouro) | "overheal becomes a shield" | "healing above max HP becomes a temporary shield" | escudo ausente |
| 26 Mirror Echo (ouro) | copia o perk à esquerda | só texto | copiava tudo, inclusive Rising Momentum |
| 6 / 25 | "ignores parry" | idem | o parser de itens perdia o "ignores parry" |

Agora os perks de texto são lidos do texto de combate com o parser de itens, e o agente ao vivo lê de
`PerkCatalog.All` o `combatEffect`, o `tier` e o `PerkEconomy.IsV2` de cada perk — então um perk novo ou
uma troca de versão chega ao modelo sem mudar código. O planejador mostra o tier (bronze/prata/ouro),
marca perks sem modelo (antes um perk desconhecido sumia da lista) e avisa se o jogo estiver na v1.

Constantes conferidas no código de combate: Pent-Up Wrath +10 de CRIT por acerto sem crítico, até 50,
zera no crítico. O escudo do Blood Curse absorve dano antes da vida; o tamanho máximo e o decaimento
não foram recuperados (o preenchimento fica no laço da batalha, que não descompilou).

Também corrigido: `perkModsIds` era carimbado com os perks do save, que só atualiza depois da próxima
luta — os modificadores de Reckless Abandon apareceram rotulados com o loadout anterior. O agente agora
manda junto os ids lidos do mesmo `PlayerState` que o jogo usou.

## Batalhas: os tipos de luta, os bosses de PvP e o tempo de cada luta (v0.11.0)

As linhas "Inimigo 3 · +10.206 XP · HP 467→467" da timeline **não eram lutas do setor**. O autofight
mistura três coisas, e o save registra todas como uma "luta" (XP e stamina mudam):

| tipo | como aparece no save | replay? |
|---|---|---|
| luta do setor (PvE) | `fightsInSectorPersistent` +1 (mortes inclusive), HP muda | não |
| PvP ranqueado, a cada ~7 min | `fightsInSectorPersistent` igual, `bossPvpCounter` +1, HP do PvE intocado | sim |
| **boss de PvP**, a cada 10 PvP | `bossPvpCounter` volta a 0 (`OnAppear`), XP fixo | **não** |

O exemplo acima era uma derrota no PvP para anthony.sa (10.206 XP = 25% dos 40.825 da vitória). O
toque ao vivo só juntava o nome nas lutas PvE, então o PvP e os bosses ficavam sem nome.

**`BossPvpEncounter`** (decodificado do ISIL e confirmado no `live.log`): 4 bosses com ficha fixa, um
por faixa de nível. `EligibleBossIndex` pega o boss mais alto cujo nível você já atingiu;
`IsBossDefeated` só pergunta se o **item que ele dá está no inventário** — enquanto não estiver, ele
volta. `ShouldTrigger`: aparece quando `bossPvpCounter + 1 ≥ 5` (antes do primeiro) ou `≥ 10` (depois);
`CountNormalPvpMatch` soma 1 por PvP ranqueado; `OnAppear` zera o contador e marca `bossPvpFirstSeen`.
Os nomes vêm de `boss_pvp.N.name` (iguais em todos os idiomas; os internos são italianos).

| boss | nível | HP | ATK | DEF | CRIT | PARRY | XP V / D | resiste / fraco | drop |
|---|---|---|---|---|---|---|---|---|---|
| Haru no Yuki | 5 | 894 | 16,2 | 71,3 | 6,7 | 16,2 | 300 / 75 | Frost / ? | Frostbite Cleaver (Rare) |
| Nero d'Inferno | 15 | 1.254 | 31,7 | 44 | 38 | 9 | 400 / 88 | Shadow / ? | Shadowfang Helm (Epic) |
| Carpita Claraboia | 25 | 1.351 | 43 | 83,6 | 17,2 | 14,3 | 550 / 120 | Holy / Shadow | Dawnguard Pendant (Legendary) |
| Agni Pariksha | 40 | 1.805 | 65,2 | 110,9 | 37,9 | 21,3 | 750 / 160 | Flame / Frost | Emberdoom Greatsword (Legendary) |

As faixas de nível (5/15/25/40) são inferidas de quando cada um apareceu pela primeira vez (Nero ~1 h
depois do nível 15, Carpita 25 min depois do 25, nunca antes). Nosso retrospecto: Haru 1 V (Frostbite
Cleaver), Nero 0 V / 8 D (a faixa passou), Carpita 1 V / 2 D (Dawnguard Pendant), **Agni Pariksha 0 V /
11 D** — ele resiste a Flame, e uma das duas armas da build atual (Flaming Axe) é Flame.

**Tempo de cada luta.** Com o ao vivo ligado, cada luta é cronometrada de `HandleCombatStart` a
`HandleCombatEnd`. Sem ele, sai do intervalo entre dois saves menos a transição: o save é gravado no fim
da luta (10 ms antes do `combat_end`) e a próxima começa ~2,4 s depois (mediana de 223 intervalos; 4,5 s
depois de drop ou level up). Conferido contra o ao vivo nos 3 bosses de hoje: 43,6 / 29,7 / 15,4 s
estimados contra 43,7 / 29,6 / 15,5 s medidos. `totalBattleTime` do save não serve: anda 1,25× o
relógio (a velocidade do jogo) e inclui as transições.

**O que mudou no registro:**
- toda luta vista ao vivo guarda tipo (`isBossPvp`/`bossPvpIndex`/`isFriendlyPvP`/`isBifidus` lidos do
  `EnemyState`), inimigo, nível, ficha, duração, ataques e a contagem de cada lado; antes só o PvE
  ganhava nome;
- o save sozinho já separa PvE de PvP (`fightsInSectorPersistent`) e marca o boss pelo contador;
- quando o save chega antes do `combat_end` (acontece: 10 ms), a luta espera até 1,5 s por ele;
- corrigido: a luta que dava level up com o ao vivo ligado ficava com **0 XP** (o ajuste pela tabela
  de XP só rodava sem o ao vivo); agora vale o `xpGained` do jogo;
- um save e seus drops/level up recebem o mesmo horário, então a aba junta cada drop à luta certa;
- o histórico antigo é reclassificado na hora: nome do ao vivo → PvE, replay no mesmo segundo → PvP,
  XP igual ao de um boss → boss, o resto → PvE sem o ao vivo; o crédito de XP ao reabrir o jogo
  (674 mil de uma vez) fica de fora como "fora de luta"; as lutas registradas em dobro quando duas
  cópias do app rodaram juntas (00:09–00:26 de 23/09) são descartadas.

## Simulador + Planejar build, Biblioteca e o tamanho da bolsa (v0.12.0)

**Uma página só.** A aba Build saiu; o Simulador ficou com o "Planejar build" (itens, perks, pontos e
poções) e uma **tabela de status única** — atual, planejada e a diferença — no lugar dos KPIs, da
tabela de atributos por origem e da tabela de atributos planejados. A origem de cada atributo (base,
itens, sinergias, pontos, perks, poções) virou uma linha pequena embaixo dele. Toda troca de item
mostra a peça atual e a nova lado a lado, com a diferença em cada atributo e os efeitos das duas;
sugestões ainda não aplicadas aparecem como "atual → sugerido" com o ganho e o custo. A curva de
sobrevivência e a tabela de inimigos mostram a build atual e a planejada juntas.

O cálculo inteiro (Monte Carlo do setor, a volta esperada, cada inimigo e a arena) roda no worker
(`plan-eval.ts`); a build equipada fica em cache, então mexer no plano só simula o plano. Pontos
hipotéticos entram pela alocação do save (atributos e PWR saem certos); poções entram no perfil da
luta e o bônus de XP delas multiplica o XP/h. **Poções não valem no PvP** — a arena usa a build sem
elas (a primeira versão deixou o Bastion somar 10 pontos de vitória no PvP).

**Biblioteca.** Os 424 itens, 31 perks e 21 poções do jogo, cada um testável no personagem. Item
não precisa estar na bolsa: as peças não têm rolagem (as 132 da bolsa batem exatamente com o
catálogo), então a do catálogo é a peça. Os itens são ordenados pelo ganho no seu personagem, com o
mesmo `rankGear` do Simulador rodando sobre uma bolsa com uma cópia de cada item. O que se testa
vai para o mesmo plano do Simulador.

**A bolsa cresce com o nível.** `GameConstants.InventoryCapForLevel`: 150 espaços, **200 a partir do
nível 30**, 300 a partir do 60 (`INVENTORY_CAP_T2_LEVEL`/`T3`). O Planner usava 150 fixo numa
configuração; agora segue o nível.

**Letra maior.** Um zoom da página (padrão 115%, ajustável em Alertas & Ao vivo → Aparência) aumenta
textos, botões e tabelas juntos.

## Otimizar para vencer o boss de PvP (v0.13.0)

**Como o jogo monta a luta do boss** (`BossPvpEncounter.Build`, ISIL): a ficha fixa do EnemyState, um
equipamento fixo de itens reais do catálogo (`BuildLoadout(i)`; Agni Pariksha: Sylvia's Sickle,
Greatsword of Eternal Fire, Brenna Mann's Helm, Fire Titan Cuirass, Cinderfall Chain, Supernova Ring,
Heart of the Sun), **nenhum perk** (`pvpEquippedPerkIds` nunca é preenchido) e o par resiste/fraco.
`CombatManager.ResolveAttack` aplica o elemento quando `!enemy.isPvP || enemy.isBossPvp`: contra o
boss, as suas armas contam como contra um monstro do setor — cada arma do elemento resistido −15%,
uma do elemento fraco +15%, as duas fracas `ENEMY_WEAK_BOTH_WEAPONS_PCT` (+40%). O resto é duelo de
PvP (morte súbita, Chamado do Rival conta, perks só-PvE não, poções não).

O modelo (`pvp-boss.ts`) põe o boss como mais um adversário do simulador de duelo, com os efeitos do
equipamento dele e o multiplicador de elemento aplicado ao nosso dano (`arenaOdds`). Conferido contra
a única luta registrada em detalhe (23/09 18:54, derrota: 1.621 de dano contra 1.805 de vida, 34
golpes): com a build daquela hora o modelo dá derrota na maioria e ~1.400 de dano médio.

"Vencer o boss" virou um objetivo do Simulador (ranking, sugestões e Melhor build) e da Biblioteca,
com uma linha própria na tabela de status (chance de vencer e o multiplicador de elemento). Um boss
só recebe tantas lutas quanto a arena inteira (`runsFor`: 128 por avaliação na busca, 960 na
confirmação), então a busca leva ~20 s.

Na build de farm (dois Flaming Axe, Flame ×0,70 contra o Agni, que resiste a Flame) o modelo dá 13%.
A melhor da bolsa troca as armas por Avalanche Axe + Frostbite Cleaver (Frost ×1,40), o elmo por
Blizzard Helm e o Veneno Persistente por Ímpeto Crescente: 96% em dados novos. Uma build tanque de
Holy (neutro contra o Agni) chega a ~95% também, com Blizzard Helm, Pyreblood Signet e Ímpeto.

## A rota de trocas: sugestões que não voltam atrás (v0.14.0)

**O problema.** As sugestões eram calculadas slot a slot, cada uma sozinha contra o equipamento do
momento. Um item vale conforme os outros slots (sinergias "para cada outro item X", "se usar duas
armas", "se tiver um item Holy", o par de elementos contra o boss), então trocas medidas sozinhas e
aplicadas juntas interagem, e a próxima leitura sugeria desfazer parte delas. Refazendo o processo
na bolsa real: o Cinto trocou Pyre Belt ↔ Belt of Whispers quatro vezes, as armas foram e voltaram,
o mesmo Eclipse Twinblade (#673) foi sugerido para as duas mãos ao mesmo tempo, e contra o boss
entravam trocas de +1,5 ponto — o tamanho do ruído de 128 lutas simuladas. Além disso a busca de
perks só rodava depois de alguma troca de item (um loadout melhor sozinho nunca aparecia) e, sem o
modo ao vivo, uma troca feita no jogo só chega ao save no fim da luta seguinte: até lá a mesma
sugestão continuava na tela.

**A rota** (`build-optimizer.ts`). Uma subida passo a passo: cada passo é o melhor movimento *com
os anteriores já feitos*, e um movimento é um item num slot **ou** um loadout inteiro de perks.
- É markoviana: o passo depende só da build de onde parte (candidatos, triagem e dados são funções
  dela). Aplicar o primeiro passo e recalcular dá o resto da mesma rota.
- Tem um piso por objetivo (0,5% de XP/h ou dano, 0,05 inimigo, 1% da vida por luta, 1 PWR, 2 pontos
  de vitória): empate, arredondamento e ruído não viram sugestão, e o fim da rota é um ponto fixo —
  pedir de novo dá rota vazia.
- Nas lutas (PvP e boss) o passo vencedor é medido de novo em dados que a busca não usou e só fica se
  o ganho se mantiver; e a pontuação soma à vitória uma margem (vida que sobra de cada lado, peso
  0,1), que anda quando a vitória está parada em 0% ou 100% — antes, uma build que perdia todas não
  tinha para onde ir.
- Cópias idênticas de um item são um candidato só, nenhum item vai para dois slots, e a rota parte
  do **plano** (não do equipado), como as alternativas de cada slot e o ranking da Biblioteca.

Testes (`build-optimizer.test.ts`) numa bolsa montada para interagir: para cada objetivo, seguir a
rota e pedir de novo dá rota vazia; aplicar o primeiro passo dá o resto da mesma rota; nenhum passo
desfaz outro, troca cópia por cópia ou veste um item duas vezes; um loadout de perks pior é
corrigido por um passo de perks; e o teste de contraste mostra as sugestões antigas voltando atrás
na mesma bolsa. Na bolsa real a rota sai em ~0,5 s nos objetivos de PvE e ~1 s contra o boss (a
busca antiga levava ~20 s).

**Equipamento ao vivo.** Com o modo ao vivo, o agente lê `PlayerState.equippedUids` e
`equippedPerkIds` a cada segundo (só leitura) e o app os põe sobre o save enquanto ele não grava a
troca — só quando todos os uids existem na bolsa do save. Uma troca feita no jogo aparece na hora e
a rota recomeça dela.

## Nível 60: a curva de XP, o XP que o setor paga e o tempo até lá (v0.15.0)

**O teto.** `GameConstants.MAX_LEVEL = 60`; `GameManager.EffectiveMaxLevel` devolve 60 na versão
completa (10 na demo). No 60 a barra de XP vira "máximo" e a bolsa vai a 300.

**A curva** (`XPSystem`). `XPNeededForNextLevel(L) = XPForLevel(L+1) = (int)(XpBaseAtLevel(L) × 45)`.
`XpBaseAtLevel` usa dois `int[21]` que o construtor estático copia do `global-metadata.dat` —
níveis `1 3 5 7 9 11 14 17 20 23 26 29 32 36 40 43 47 51 53 56 59` e bases `15 100 250 366 574 824
1590 2255 3020 6000 7500 9200 12672 15664 18936 31154 36562 42354 66338 73254 80465` —, exato nas
âncoras e geométrico entre elas (`logf`, lerp, `expf`, tudo em float32). A mesma base é o que uma
vitória de PvP paga (70.872 no nível 55, visto no histórico) e a derrota paga um quarto (17.718).
Conferido nos nossos level-ups 27→55: o XP somado entre dois deles dá 97–100% da curva (o resto é a
sobra que cada level-up carrega). Do 55 ao 60 são 17,0 mi de XP.

**O XP que o setor paga estava errado no app.** `XPSystem.ScaleXPForSector(base, nosso, setor,
inimigo)` mede a penalidade a partir de `max(nível do inimigo, SectorIntendedLevel(setor))`, e
`SECTOR_INTENDED_LEVEL = [3, 9, 17, 26, 36, 47, 56]`. O app usava só o nível do inimigo: no nível 55
o Deserter Grigio (nível 43) "pagava 0" no modelo e paga 40% no jogo (12.461), igual ao Blu de nível
47. Com a regra do jogo, **594 de 594** vitórias de PvE do histórico batem; com a antiga, 107. O
farm do setor 5 valia ~6× mais do que o Simulador achava.

**O modelo rápido não via os contadores de crítico.** "A cada 3 críticos o próximo ataque causa
dano triplo/duplo" (Emberdoom Greatsword, Pyreblood Signet), o veneno do crítico e a regeneração
abaixo de 50% de vida só existiam no Monte Carlo. Contra 117 lutas gravadas com o Deserter Grigio
(18,8 ataques nossos por luta), o modelo rápido dava 26 rodadas; o Monte Carlo, 19,8. Agora o modelo
rápido conta os contadores (a média `crit/N × (M−1)`, e dois contadores de mesmo N valem o maior,
como o `pending.mult = max` do jogo), o veneno (tempo ativo entre críticos) e a regeneração ao longo
da tentativa (a vida é levada de luta em luta): 18,9 rodadas, e o dano por acerto 339 contra 328
medido. Era este modelo que decidia a rota de "Farmar XP" — ela sugeria trocar a Greatsword.

**A build de farm.** Com os dois consertos, a rota de "Farmar XP" no setor 5 volta **vazia**: a
build Flame equipada é a melhor da bolsa (nível 55–56). Por volta do 58 aparece um ganho pequeno
(Judgment Hammer na Arma 2, Pele de Dragão no lugar do Veneno, Cinder Veil: 231 → 345 mil XP/h). Os
pontos livres quase não mexem no farm (+10 em ATK ou CRIT: +0,01%). A melhor build de "progredir" da
bolsa chega ao inimigo ~51 de 70 do setor 5, então o setor 6 ainda não abre.

**O tempo até o 60** (`level-eta.ts`, card na Visão geral). Dividir o XP que falta pelo XP/h de hoje
erra duas vezes: cada barra é maior e o setor paga menos a cada nível — no setor 5, 40% no 55, 28%,
16%, 4% e 0% no 59 — enquanto o PvP paga mais. Então as lutas da última hora são repagas em cada
nível à frente: os mesmos inimigos, no mesmo ritmo, pelo que pagariam naquele nível (o PvP pela base
do nível; o crédito offline fica de fora). No save de 23/09 (nível 56): **~28,6 h** no farm atual,
contra 8,4 h no ritmo de agora — 1,9 h, 3,3 h, 8,1 h e 15,3 h por nível, o último só de PvP. O
Cave (setor 6, nível 56) paga 100% até o 59; ele abre quando o setor 5 for limpo.

Sem o modo ao vivo o app agora também sabe o XP de uma luta que sobe de nível (usa a curva; o número
do agente, quando existe, continua valendo).

## Limpar o setor 5, o respec no Simulador e todas as passivas no modelo rápido (v0.16.0)

**O que o jogo oferece além de itens.** `ShopSystem.GetRespecCost` devolve `respecCount > 0 ? 60 : 0`
(`RESPEC_FLAT_COST = 60`): o **primeiro respec é grátis**. O alívio do Murato (`MURATO_MIN_BATTLES_STUCK =
40`, duas meta-ações diferentes em 30 lutas) só mexe em drops (`DropDemoteFactor`) e no ritmo do PvP
(`SkipsPvPFloor`), não no combate. A forja (`ForgeScreenUI.EseguiForgia`) funde itens de uma raridade num
item aleatório da seguinte e cada raridade abre ao limpar um setor. As poções duram 7.200 s, mais que uma
volta de 70 lutas.

**O setor 5 (Uhn-Baa Gorge, 70 inimigos) no save de 23/09.** A melhor build de "progredir" da bolsa
chega ao inimigo ~55 no modelo rápido e fecha o setor em **0%** no Monte Carlo; quem para a volta são
Marauder Viola, Cultist Viola, Giant Worm e Harpy Blu. Falta DEF: +120 fecha em 50%, +160 em 96%; HP, ATK e
PARRY quase não mexem (a PARRY já está no teto). Respec para DEF: 4% sozinho; com Bastion ou Rampart,
96–98%; com o perk Baluarte (700 Bloodmarks), 100%. Sem respec, só quatro poções juntas (Bastion +
Rampart + Savagery + Bloodthirst, 96%). Um item sozinho só resolve se for Mythic.

**Respec no Simulador.** "Pontos" tem dois modos: somar (como antes) e **respec**, em que o ponto pode
sair de um stat (até zero) e o número do meio é onde o stat termina. "Tirar tudo" zera a distribuição;
"melhor respec para <objetivo>" roda `optimizePoints` no worker. Ele usa o mesmo medidor da rota (o plano
com itens, perks e poções, no objetivo escolhido em "Planejar build") e sobe de 5 em 5 pontos: gastar
pontos livres num stat ou, no respec, passar 5 de um stat a outro, até nenhum movimento melhorar. No
respec há uma segunda subida a partir de tudo zerado, e fica a melhor. Nas lutas (PvP/boss) a conta é em
dados fixos e todo movimento aceito é conferido em dados novos. Leva 0,1–0,4 s nos objetivos de PvE e ~6 s
no boss. Para "Progredir" a sugestão mostra também a chance de fechar o setor do Monte Carlo — o modelo
rápido é otimista em builds de tanque (no save de 24/09 ele dizia "fecha o setor" e o Monte Carlo, 46,5%).

**Todas as passivas no modelo rápido.** Era ele que ranqueava as sugestões de PvE, e várias passivas só
existiam no Monte Carlo. Agora `expectFight` tem a média de cada uma: a cada N ataques ignora X% de DEF ou
+CRIT; absorver o primeiro golpe e a cada N golpes; ao aparar cura, DEF para o resto da luta, bônus nos
próximos golpes, contra-ataque; refletir dano; crítico que baixa a DEF ou faz o próximo ignorar DEF; Ira
Reprimida (cadeia de Markov das cargas de CRIT); Ímpeto Crescente; bônus acima de X% de vida; execução
abaixo de X%; dano pela vida máxima do inimigo; dreno; primeiro ataque crítico; Sunder Oil, Immolation e
Executioner's Draught. O que cresce durante a luta entra pela média na duração da primeira estimativa. Os
"abaixo de X% de vida: +DEF/+ATK/absorve" dependem de onde a volta está, então `sectorRun` mistura a luta
normal com a versão de vida baixa pela fração dela passada abaixo da linha. Conferido contra o Monte Carlo
efeito por efeito (`fast-model.test.ts`, 3.000 lutas cada): duração e vida perdida batem em ±5% (Sunder
Oil, ±10%). Ainda fora dos dois modelos: "a cada 5 s: +N de ATK temporário".

## Lendários, passivas com duração e o farm na Cave (v0.17.0)

**O que estava errado (conferido no código do jogo e em lutas reais).**

- **"On critical hit: reduces enemy DEF by N per/for N sec"** (Eclipse Twinblade, Prayer Lamp, Cinder
  Throne Crown…) é um debuff **com prazo**: `CombatRuntimeEffects.PushOnCritEnemyDefDebuff` empilha um
  (valor, fim = agora + duração) por crítico e `GetActiveEnemyDefReduction` soma só os que não venceram.
  Os dois modelos tratavam como redução **permanente e acumulada** — com dois Twinblades a DEF do Dwarf
  ia a zero no meio da luta, e o dano previsto era 2× o real (368 contra 160–180 por golpe). A build
  Shadow saía como a melhor de farm na Cave (7,2 mi XP/h) e perdeu 10 de 10 lutas contra o primeiro Dwarf.
- **"Every N sec: +N temporary ATK / DEF / to all stats"** (Cindervow Gloves, Ethereal Tome…)
  **acumula** a luta inteira: `TickTemporaryBuffs` soma a cada tique e só zera na luta seguinte; "(max N
  stack)" limita; "all stats" é ATK, DEF, CRIT e PARRY. Nenhum modelo contava.
- **"On parry: +N DEF per N sec"** tem prazo (`PushTimedDefBuffOnParry`); "for the rest of combat" / "per
  il resto" não. Tratávamos todos como permanentes.
- **"On first hit taken: … +N% ATK for the rest of combat"** era ignorado.
- **"Below X% HP"**: `GetBelowHpAggregate` soma **todas** as cláusulas cujo limite a vida está abaixo
  (Oathkeeper's Circle "abaixo de 30%: +30% DEF" e Dawnguard "abaixo de 50%: 3 PV/s" valem juntos abaixo
  de 30%). O Monte Carlo e o duelo usavam só uma.
- **O "lute até morrer" contava luta por média**: uma luta que perde 82% das vezes, com custo médio perto
  da vida, virava vitória. Agora `expectFight` dá também o desvio do custo e `sectorRun` leva a vida como
  distribuição (12 faixas): cada luta é vencida com uma probabilidade, e XP, tempo e profundidade (lutas
  vencidas esperadas) são pesados por ela. `simulateFarm` joga o ciclo no Monte Carlo para conferir: em
  8 builds reais o XP/h bate a ±15% (Holy na Cave: 2,83 mi contra 2,99 mi) e no jogo a build Holy fez
  2,63 mi/h de PvE em 28 min (18 de 22 lutas).

Com isso a build Shadow reconstruída bate com as 10 lutas reais: 177 de dano por golpe (160–180), 37
ataques antes de morrer (33–44), 16,6 de dano recebido por ataque (~16), 0,4% de vitória (0 de 4).

**O farm na Cave (nível 58, pontos HP 55 / DEF 130 / PARRY 100).** A rota a partir da build Holy:
Faith Shield → Emberdoom Greatsword, Temeridade Total → Fúria Agonizante, Sanctified Laurel → Mourning
Cowl, Redemption Belt → Belt of Whispers, Sunpenitent Raiment → Assassin's Tunic — **6,0 mi XP/h** no
Monte Carlo, contra 3,0 mi da Holy. Armas Holy (fraqueza do Dwarf e do Pit Scum) + Flame (neutra ali);
elmo, armadura e cinto Shadow, que o inimigo não resiste (só as armas pesam) e que ativam as sinergias
"for every other Shadow item". Perks: Relâmpago Engarrafado, Fúria Agonizante, Ímpeto Crescente, Fúria
Bruta. Um respec de farm (DEF 235, CRIT 50) leva a 6,3 mi (+5%). Partindo da build Shadow a rota para
num ótimo local de 5,0 mi: a subida troca uma peça por vez e as sinergias de elemento prendem.

**Lendários na build de farm** (Monte Carlo, trocando pela melhor alternativa da bolsa): Dawnguard
Pendant −2,2 mi, Emberdoom Greatsword −1,4 mi, Mourning Cowl −1,3 mi, Oathkeeper's Circle −0,3 mi.
Fora dela: Pyreblood Signet no anel −0,5 mi, Cindervow Gloves −0,3 mi, Sunpenitent Raiment no corpo
−0,5 mi, Frost Colossus Shield na Arma 2 −2,7 mi. **Espinhos** (reflete 50%) no lugar de Relâmpago:
−1,4 mi — no PvE o reflexo é pequeno perto da vida dos monstros (~10 de dano por rodada contra 11–20 mil);
ele rende no PvP (66% de vitória com Thorns contra 53% sem, no nosso histórico). **Fúria Bruta** (20% da
DEF vira ATK, da DEF antes do multiplicador dela) fica na build: nenhum perk da bolsa rende mais no lugar.

Conferido efeito por efeito contra o Monte Carlo (`fast-model.test.ts`, 3.000 lutas cada, ±5%) e o ciclo
inteiro contra `simulateFarm` (4 builds). A tabela de inimigos agora diz "arma X: −15% / +15%" e a rota
marca o elemento de peças que não são armas como "(sinergia)".

## A rota com pares de armas, conjuntos de elemento e duas subidas (v0.18.0)

A subida trocava uma peça por vez, e os bônus de conjunto ("for every other X item") e o par de
elementos das armas só pagam com várias peças trocadas juntas. Agora cada rodada também tenta:

- **Par de armas**: as 5 melhores candidatas de cada slot de arma (pela nota da troca sozinha) e a arma
  do outro slot (para trocarem de lugar), as duas mudando no mesmo passo.
- **Conjunto de elemento**: para cada elemento, cada slot recebe a melhor peça dele; também o conjunto
  deixando um slot como está (um amuleto ótimo de outro elemento não afunda o conjunto). Aparece na
  rota como "conjunto Flame", com cada troca numa linha e um só "aplicar".

E a rota roda **duas subidas** e fica com o melhor fim: uma já com pares e conjuntos, outra uma peça por
vez que depois continua com eles. Mais passos por rodada não fazem uma subida melhor: na bolsa real, só
com pares a rota pulava para Holy + Flame e parava em 6,0 mi XP/h; uma peça por vez chegava ao conjunto
Flame, 7,8 mi. As duas pontas são estáveis a qualquer movimento; depois do primeiro passo a rota continua
a mesma ou troca por uma que termina pelo menos tão bem (os testes conferem). PvP e boss sobem uma vez só.

Na bolsa de 24/09 (nível 60, 5 perks), de qualquer ponto de partida — a build Shadow, a de tanque atual
ou a Holy — a rota de farm na Cave termina na mesma build: Ember Helm, Coalbound Mail, Pyre Belt,
Emberdoom Greatsword + Flaming Axe, Cindervow Gloves, Dawnguard Pendant; Relâmpago Engarrafado,
Temeridade Total, Fúria Agonizante, Ímpeto Crescente e Baluarte — **8,4 mi XP/h** no Monte Carlo.
A rota leva ~2,5–4 s nos objetivos de PvE.

**Poções para fechar a Cave** com a build de tanque (Blizzard Helm, Sunpenitent Raiment, Redemption Belt,
Emberdoom + Frost Colossus Shield, Oathkeeper's Circle, Dawnguard; Veneno, Espinhos, Fúria Bruta, Ímpeto,
Baluarte): os 91 pares no Monte Carlo — Bastion + Rampart fecha em 9,7% (9,4% da volta em andamento, no
inimigo 22), Bastion + Immolation 4,7%, Rampart + Immolation 3,1%; os da loja do dia, 0%. A rota de
"progredir" com Bastion + Rampart piorou para 1,9%: nessas lutas muito longas o modelo rápido não guia
a chance de fechar — é o Monte Carlo (o gráfico de sobrevivência) que vale.

## Poções com hora marcada e a análise profunda no Simulador (v0.19.0)

**As poções acabam no meio da volta.** Uma dose dura 7.200 s (2 h, tempo real: as lutas do modelo batem
com as do jogo) e uma volta de tanque na Cave leva 4,5–5,5 h. O Monte Carlo agora aceita uma **janela**:
o perfil sem poção, o perfil com, o inimigo em que são tomadas e quanto duram (doses seguidas somam).
Devolve também onde elas acabaram em média e quanto dura uma volta que fecha. No Simulador, em Poções:
"tomar no inimigo N" (±5) e "doses seguidas" (1–3); o gráfico de sobrevivência pinta a faixa em que estão
ativas, e o status ganhou "Duração de uma volta" e "Poções acabam no inimigo". As poções ativas no jogo
entram com o tempo que o save diz que resta. Build Frost, Bastion + Rampart: a volta toda 100%, uma dose
no início 0%, **duas doses no inimigo 30: 98,4%** (acabam no inimigo ~69, volta de ~5,3 h).

**"Chega até o inimigo" vem do Monte Carlo.** A corrida em forma fechada era usada ali e, na build Frost
sem poção, dizia 69,9 inimigos enquanto o Monte Carlo (e a análise anterior) dava 0,1% de fechar e 57,4
inimigos. Nas lutas de tanque (centenas de rodadas, Baluarte segurando a vida no fundo) a média não
guia; o status e o resumo usam agora as mesmas voltas do gráfico.

**Análise profunda** (painel "Análise profunda · fechar <setor>"). O que eu fazia à mão, no app:
`shared/deep-clear.ts` sobe no próprio Monte Carlo — uma peça, pares de armas, conjuntos de elemento
(e o conjunto sem um slot), um perk por outro e, com "permitir respec", 10 pontos de um atributo para
outro. Cada movimento em 36 voltas com os mesmos dados; os 6 melhores de novo em 300 com outros; entra
só o que bater a build atual nessas 300. Nota = 70 × chance de fechar + lutas vencidas, para subir mesmo
antes de fechar. No fim testa o horário das poções (inimigo 0, 10… × 1–3 doses) e confere início e fim em
1.000 voltas. Roda num **pool de workers** (núcleos − 1, até 8) com progresso, cancelar e "aplicar ao
plano" (peças, perks, pontos/respec e o horário). A avaliação do plano ganhou um intervalo de 300 ms:
cliques seguidos (uma poção, o +5 várias vezes) não enfileiram uma simulação de 20 s cada no worker.

## Otimizar para qualquer meta no Monte Carlo (v0.20.0)

**A rota rápida saiu.** O "Planejar build" calculava sozinho, a cada mudança, uma rota no modelo em forma
fechada (`build-optimizer.ts`) e uma lista de alternativas por slot com o ganho de cada peça. Nas lutas
longas esse modelo errava o sinal (a rota de "progredir" levou a Frost de 9,7% para 1,9%; o farm pedia
armas Shadow numa caverna que resiste a Shadow). Agora nada é sugerido antes de rodar: escolhe-se a meta
em "otimizar para" e clica-se em **otimizar**. A busca é a da análise profunda, generalizada
(`shared/deep-search.ts` + `shared/deep-eval.ts`), no pool de workers, e continua rodando se a página muda.

**O que uma "volta" joga em cada meta** (a busca pede 12, 36, 300 e 1.000 delas):
- Progredir: uma volta do setor (de onde o plano começa), poções a volta toda ou no horário; nota
  70 × fechar + lutas vencidas; no fim, o horário das poções.
- Farmar XP: uma tentativa do ciclo de farm (inimigo 0, vida cheia, até morrer); XP/h com o bônus das poções.
- Dano / Sobrevivência: meia luta, da vida cheia, contra cada inimigo que o setor sorteia, pesado por quanto
  aparece; dano por round (HP tirado do inimigo, de todas as fontes) e vida por luta (com a regeneração).
- PvP: meia luta contra cada um dos 16 adversários; boss: o mesmo total contra o boss (sem poções).
  Nota = pontos de vitória + 10 × margem, para desempatar quando tudo vence (ou perde).
- PWR: a fórmula do jogo, sem sorteio.

**Busca:** cada troca simples (≈150 com a bolsa de 148) em 12 voltas, as 48 melhores em 36, mais pares de
armas e conjuntos de elemento em 36; as 6 melhores em 300 com outros dados; entra a melhor se ganhar da
build atual nessas 300 por um mínimo (meia luta; 1% de XP/h ou dano; 1 ponto de vitória; 1 PWR). Pontos:
com respec qualquer atributo pode ceder (10 ou 30 de cada vez); sem, só os pontos livres entram (10, 30 ou
todos) e os já distribuídos no jogo não saem. O resultado compara com o **equipado** (e mostra o plano de
partida quando é outro), lista cada slot como atual → otimizado ("ver as duas" abre as fichas), os perks e
os pontos, e "aplicar ao plano" põe tudo no plano. Custo medido na build tanque (nível 60, Cave, uma thread,
36 voltas por build): PWR 3 ms, boss 51 ms, sobrevivência 123 ms, dano 147 ms, farm e progredir ~4,3 s —
uma rodada de tanque leva alguns minutos com 5 workers; uma build frágil (morre cedo) roda em segundos.

**O status também é Monte Carlo.** XP/h, XP e duração da tentativa vêm de `simulateFarm` (até 20 lutas por
volta simulada: as tentativas de um tanque são longas); dano por round e vida por luta, das mesmas lutas das
chances por inimigo (`enemyOdds` ganhou o HP tirado do inimigo e a vida com regeneração). Assim o número que
o otimizador promete é o que a tabela mostra. Na troca manual, a lista de peças de um slot não tem mais
nota ao lado: a peça entra no plano e o status mostra o efeito.

Resultados no save (nível 60, Cave, build tanque Holy/Frost equipada, 609 mil XP/h, fecha 99,4%):
**Dano** 18,1 → 167 por round (Flame inteira, Temeridade, Relâmpago, Ímpeto) em 44 s; **Farmar XP**
partindo dessa build de dano: 6,03 → **8,11 mi XP/h** trocando Fúria Bruta por Baluarte (morre cedo e
recomeça: farma os primeiros inimigos da Cave em loop); **PWR** 3.835 → 4.624.

## A Arena: ondas sem fim depois da Cave (v0.21.0)

**Entrada.** Fechar o último setor (Cave, índice 6) liga `endlessMode`, põe `waveIndex = 1`, `waveKillCount
= 0` e enche a vida; `currentSector` fica 6 e nada desliga o modo. Daí em diante toda luta PvE é da Arena
(`StartPvEBattle` → `StartArenaBattle`); o PvP continua intercalado. No save do usuário: Cave fechada em
2026-09-25 01:28 (drop "SectorClear" Seventh Veil Robe, Legendary).

**O inimigo de cada luta** (`PickEnemyForArena`, especificação completa lida do ISIL em
`scratchpad/arena-spec.md`):
- setor do elenco: `secF = 4 + 2·clamp01((w−1)/49)`; piso de secF, ou o seguinte com chance frac(secF):
  War Camp na onda 1, a Cave só a partir da onda 50;
- categoria uniforme entre as 5 do setor (não a gaussiana); cor Blu com `[70, 55, 35, 20]%` por faixa de
  10 ondas, senão Viola, nunca Grigio;
- `x = w + 5`: HP × `(1,5 + 0,1x + 0,0022x²)` (arredondado), ATK × `(1,7 + 0,06x + 0,001x²)`; DEF, CRIT e
  PARRY iguais; nível + ⌊(w+6)/5⌋; **nenhuma resistência**, a fraqueza fica; drop 9% Blu, 15% Viola.
- **Conferido ao vivo** (o tap leu os inimigos da onda 1): Ogre Blu 21.384 PV / ATK 84,93 / nível 45, Black
  Orc Viola 9.748 / 70,75 / 41, Butcher Viola 18.532 / 105,42 / 47 — exatos (`arena.test.ts`).

**Bosses** nas ondas 10, 20, 30 e 40, uma vez por save (`arenaBossDefeatedMask`): a 11ª luta da onda, com
vida cheia antes e depois. HP/ATK 68.536/584,35 (Marauder), 105.402/791,19, 386.178/1.888,05 e
524.690/2.414,07 (Black Dragon); DEF/CRIT/PARRY de ficha própria e resistência/fraqueza dos bosses de PvP
(Frost/Flame, Shadow/Holy, Holy/Shadow, Flame/Frost). Batem com a tabela de QA do próprio jogo.

**Vida e morte.** Depois de cada vitória: + 4% da vida máxima até a onda 10, 6% depois (+ a regeneração
dos itens). Morrer volta ao último múltiplo de 5 **abaixo** da onda (12 → 10, 10 → 5, 5 → 1) com a vida
cheia; o recorde (`maxWaveRecord`, a maior onda completa) fica. Drops por raridade por faixa de onda; marco
a cada múltiplo de 5 inédito; XP não conta no nível 60.

**No Planner.** O save não mexe no setor nem no XP numa luta da Arena, então nenhuma era registrada:
`save-diff` agora vê o avanço de `waveIndex`/`waveKillCount` (para frente = vitória, para trás = morte; a
luta depois do 10º abate de uma onda de boss é o boss) e o tap marca o modo "arena" pelos "(W n)" do nome.
A Visão geral mostra onda, abates (x/10), recorde e o próximo boss. O **Simulador** tem o alvo "Arena":
`simulateArena` joga horas de autofight (1, 4 ou 12 h) a partir da onda atual — cada morte volta ao
checkpoint — e mostra a chance de ter passado de cada onda, o recorde esperado, vitórias e mortes por hora,
a chance contra o próximo boss, itens por hora e os inimigos da onda. O otimizador, na Arena, sobe
"Progredir" pelo quanto chega nessas horas (em abates) e mede dano e sobrevivência contra a onda atual.

Build tanque equipada (nível 60, onda 1): lutas de ~5,5 min (o log ao vivo tinha 10,5 min o Ogre e 2,5 min
cada Black Orc), 10,7 vitórias por hora, recorde esperado **onda 3,8 em 4 h**, sem mortes — o gargalo na
Arena é o dano, não a vida.

## O modelo de PvP contra as lutas reais (v0.22.0)

**Calibração.** 129 lutas ranqueadas de 2026-09-25 20:34 a 09-26 12:50 com o mesmo equipamento, todas
contra adversários que o tap leu com a ficha exata (atributos e perks, `pvp_snapshot`). No total o modelo
acertava (60 vitórias, 59,7 esperadas; acerto, crítico e dano por golpe dos dois lados iguais em média),
mas luta a luta era confiante demais: previsões de 10–30% venceram 57%, de 70–90% venceram 50% (Brier
0,242, quase uma moeda). Os adversários só medidos pelo replay (sem ficha) eram piores ainda (~95% em
lutas perdidas), então o grupo de PvP do app passou a ser **os 30 adversários mais recentes com ficha
exata**, sem repetir nome (antes: os 16 últimos de qualquer jeito).

**O que estava errado** (lido no ISIL, `scratchpad/mirror-echo-spec.md`):
- "A cada N ataques" (Investida Pesada, Eco Voraz, itens) conta só os golpes do atacante que **não foram
  aparados** e turbina **o próprio golpe**; o "ignora parry" nunca vale (a rolagem de parry vem antes). O
  modelo contava todos os golpes, armava o bônus para o seguinte e ignorava o parry.
- Por isso a Investida Pesada "não aparecia" nos replays: o Frost Colossus Shield ("a cada 3 golpes
  recebidos, absorve o próximo") conta os mesmos eventos — o golpe ×2,4 é sempre o absorvido (59 de 59).
- Os bônus pendentes (a cada N, réplica, primeiro ataque) somam num ×(1 + Σ); o dano fixo entra depois
  dos multiplicadores; o bônus de crítico ("on critical hit: +N damage") entra depois das absorções.
- Penetração de DEF no PvP vai até 50% (não 75%). A regeneração do Baluarte é um tique por golpe do outro.
- **Eco Espelhado**: sem código próprio; manda o texto de combate do perk da ESQUERDA uma segunda vez pelos
  mesmos parsers. Só 9 perks têm texto: Investida Pesada (×3,8 a cada 3º golpe), Réplica (+70%), Fúria
  Agonizante (+160% ATK), Espinhos (reflete 100%), Eco Voraz, Baluarte (84% e 16 PV), Perfura-Armadura
  (parry 70%, DEF limitada a 50%); ao lado de Veneno ou Maldição de Sangue não faz nada, e ao lado de
  qualquer outro também não. Não soma PWR além do próprio peso (250). Os perks do adversário funcionam
  todos no PvP (inclusive o Eco e a ordem dos slots), menos os de atributo, que já vêm na ficha.

Com o modelo corrigido, as mesmas 129 lutas: Brier 0,220 (melhor luta a luta), 56,9 vitórias esperadas
para 60. O otimizador ganhou uma varredura de **todas** as combinações de 5 perks possuídos (e, com o Eco,
cada vizinho que ele pode copiar) no fim da busca das metas baratas (PvP, boss, PWR).

**A melhor build de PvP (2026-09-26, 40 adversários de ficha exata, modelo corrigido).** Busca completa (cada
peça da bolsa, pares de armas, conjuntos de elemento, respec, as 1.413 combinações/ordens de perks): o
conjunto Holy equipado (Fallen Angel's Veil, Sunpenitent Raiment, Redemption Belt, Judgment Hammer,
Frirekr Toto's Aegis, Oathkeeper's Circle, Dawnguard Pendant) já é o melhor em itens; 86,6% → **91,2%** com
Voto Carmesim no lugar de Ímpeto Crescente e 60 pontos de DEF para HP (respec). O motor é o reflexo:
Espinhos + Eco Espelhado à direita dele devolve 100% do dano recebido, então vida vale mais que DEF.
Comprar perks quase não muda nada nessa build: Último Suspiro +1,3 pp (92,5%), Perfura-Armadura +0,1;
Investida Pesada, Eco Voraz e Réplica ficam abaixo (89,8%) — a recomendação de 09-25 (Investida Pesada,
Perfura-Armadura) era da build tanque e do modelo antigo.

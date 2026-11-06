# Corrigir regressões e consolidar a performance da prévia

**Status:** done (approved 2026-11-05; completed 2026-11-06)

**Date:** 2026-11-05

**ADR:** `../adr/2026-11-04-preview-render-worker.md`; criar um ADR complementar para cancelamento e propriedade dos jobs durante a implementação. Se a decisão contrariar o ADR existente, supersedê-lo conforme `docs/adr/README.md`.

## Context and goal

A branch `perf/preview-render-worker` foi criada para manter a digitação responsiva enquanto documentos grandes são abertos e suas prévias reconstruídas. A [auditoria](../audits/performance-review-perf-preview-render-worker.md) encontrou uma regressão reproduzida de HTML entre lotes, defeitos e riscos em Typst/Read Aloud, um teste de latência que não observa os eventos que injeta e um algoritmo anterior à branch que fica muito lento em CRLF.

O responsável confirmou que **arquivos de cerca de 10 MB em CRLF com dezenas de milhares de parágrafos fazem parte do alvo obrigatório**. A prioridade é diminuir atraso de entrada, p95/p99 e tempo entre a edição e uma prévia correta. Não há teto rígido de tamanho instalado: aumento de 10% a 15% é aceitável quando justificado; acima de 15%, apresentar o impacto para avaliação pessoal antes do merge. O word sync pode ficar indisponível por mais de 600 ms, desde que volte a funcionar corretamente depois que edição e prévia se estabilizarem. A versão `0.8.0` permanece.

O objetivo deste plano é corrigir os problemas que bloqueiam o merge, demonstrar a melhora no cenário obrigatório de CRLF e estabelecer uma validação reproduzível em Windows e Linux. Os números de Node/Chrome da auditoria são evidências de um problema, não garantias de latência do aplicativo nativo.

## Scope and non-scope

**Incluído antes do merge:**

- F01/F08/F13: preservar a estrutura e a segurança do HTML Markdown ao sanitizar em lotes, testar blocos grandes e corrigir a indicação de mapeamento vazio.
- F02/F03/F04: corrigir o reaproveitamento da prévia Typst, isolar e cancelar compilações e tornar cancelável o início de Read Aloud.
- F05/F06/F07/F10: corrigir a medição de entrada, controlar jobs obsoletos em workers e modos de visualização e recuperar falhas no envio/mensagens dos workers.
- F11: eliminar a serialização de HTML não usada pela prévia ao vivo, preservando o contrato de exportação.
- F15, embora `src/source-map.ts` esteja fora do diff original: otimizar a tradução de offsets para CRLF/substituições e verificar a fidelidade de mapeamento em arquivos grandes.
- Testes automatizados, medições de performance e tamanho, validação de segurança, documentação e ADR necessários para essas alterações.

**Fora do escopo:** renderização incremental ou virtualizada completa; mudança do dialeto Markdown/AsciiDoc/Typst/HTML; alteração do formato dos documentos ou de `settings.json`; modificação do identificador do produto distribuído; mudança da versão `0.8.0`; telemetria ou atividade de rede ao iniciar; novas dependências por padrão. F09 (pré-leitura especulativa de includes AsciiDoc), F12 (agendar Mermaid AsciiDoc após o primeiro paint) e otimização estrutural dos bundles ficam para trabalho posterior, salvo se a medição deste plano mostrar que impedem os critérios de aceite. Uma ampliação requer atualizar o plano antes de implementá-la.

## Approach and rejected alternatives

Manter os workers separados e o DOMPurify na thread que possui o DOM, conforme o ADR existente. Dividir a implementação em duas etapas no mesmo plano: primeiro corrigir fidelidade, concorrência e cobertura; depois otimizar CRLF e medir a experiência completa. A integração das etapas é intencional: `src/main.ts`, a fila do worker e os testes de prévia são compartilhados, e a correção de CRLF é obrigatória antes do merge.

1. **HTML seguro entre lotes.** Tratar como inseparáveis os trechos que formam uma mesma árvore de HTML bruto. Quando uma fronteira independente não puder ser comprovada, sanitizar o trecho necessário como um todo e aceitar temporariamente seu custo síncrono, em vez de modificar a árvore ou enfraquecer o sanitizador. Manter staging e troca única. Medir os casos com HTML bruto; se o fallback tornar o cenário-alvo inaceitável, registrar a evidência e propor uma extensão do plano antes de adotar outro parser/sanitizador. Não assumir que 64 KiB seja limite rígido quando um bloco é indivisível.
2. **Offsets indexados.** Construir uma vez, por render, índices de deslocamento acumulado para substituições e quebras de linha, e localizar por busca binária. Preservar a semântica de `translateOffset`, inclusive limites, CRLF/CR, código, matemática e offsets UTF-16. O alvo é substituir a varredura repetida por `O(N + F log N)`, sem novos pacotes.
3. **Worker e modo de visualização.** Associar jobs e tarefas posteriores à geração/documento. Manter uma execução e uma solicitação mais recente por engine; cancelar ou substituir o job ativo quando ele ficar obsoleto, inclusive ao mudar de aba ou entrar em Source. Para uma conversão não cooperativa, permitir encerrar e recriar o worker no momento da próxima requisição efetiva ou da invalidação, sem reiniciá-lo a cada tecla. Testar o custo de reinicialização, evitar starvation e preservar o fallback síncrono apenas para falha real, não para uma solicitação substituída. Capturar erro de `postMessage`, `messageerror` e respostas inválidas sem deixar a fila presa; não estabelecer timeout arbitrário que descarte um documento grande válido.
4. **Typst e Read Aloud.** Verificar cache antes de descartar barra/mapa; atribuir diretório ou arquivo temporário exclusivo a cada compilação e serializar compilações de prévia, permitindo exportações independentes sem compartilhar saída. Uma geração posterior deve cancelar a anterior, e gerações recebidas fora de ordem não devem substituir uma mais recente. Drenar stdout/stderr e permitir cancelamento também durante o envio de stdin, encerrando e recolhendo o processo em todos os caminhos. Registrar a solicitação de leitura e interromper a leitura anterior antes do primeiro `await`; após aguardar, verificar geração e documento.
5. **Medição real e regressões.** Enviar eventos de teclado apropriados, confirmar que o editor os recebeu e que houve sobreposição com o render, e medir p50/p95/p99/máximo da entrada e o tempo da última edição até a prévia correspondente. Uma amostra vazia ou métrica indisponível deve ser explicitamente falha/indisponível, nunca zero aprovado. Separar testes determinísticos de correção dos limites de tempo sujeitos ao ruído da máquina.

**Contrato público previsto para cancelamento Typst:** manter `render_typst` e seu argumento `token` opcional compatíveis; adicionar o comando Tauri `cancel_typst_preview(token: u64) -> Result<(), String>` e o wrapper `cancelTypstPreview(token: number): Promise<void>` em `src/api.ts`. O comando é idempotente, invalida somente compilações de prévia da geração indicada ou anteriores e não cancela exportações nem gerações posteriores. A geração também funciona como marca de ordenação para rejeitar pedidos antigos que chegarem depois. Registrar o novo comando no handler e no ADR. Se a implementação demonstrar que esse contrato não é suficiente, atualizar o plano antes de mudá-lo.

**Alternativas rejeitadas:**

- Apenas aumentar debounce: reduz frequência, mas não limita uma conversão já iniciada nem a espera atrás de trabalho obsoleto.
- Sanitizar lotes arbitrários ou usar um segundo sanitizador sem prova de equivalência: mantém a regressão F01 ou aumenta o risco de segurança.
- Recriar o worker a cada tecla: piora cold start e pode competir com a própria digitação.
- Deixar CRLF para outro PR: o responsável confirmou que o caso de 10 MB é requisito obrigatório desta branch.
- Declarar sucesso com um benchmark puramente Node/headless: ele não cobre Tauri, CodeMirror, WebView2/WebKitGTK e entrada real.

## Steps

- [x] Registrar baseline reproduzível da `master` e do HEAD antes das correções, com versões de ferramentas, hardware, tamanhos e métricas disponíveis. **Desvio:** não foi preservada medição de abertura a frio para todos os cenários; os números quentes e puros não são apresentados como cold start.
- [x] Adicionar regressões para F01, F02, F04, F05, F10 e F13 e usar subprocesso controlado para concorrência, ordenação, falha de escrita, timeout e propriedade temporária em Typst. **Desvio:** a execução de cada teste antes da respectiva correção não ficou comprovada em todos os casos; os testes finais passam e essa lacuna histórica é mantida no registro.
- [x] Corrigir fronteiras de sanitização e mapeamento vazio; verificar DOM e exportação com `map` ligado/desligado, HTML aninhado em diferentes fronteiras, um bloco muito grande e payloads de segurança.
- [x] Corrigir cache Typst e Read Aloud; acrescentar cancelamento explícito, ordenação de gerações, isolamento de arquivos e limpeza/recolhimento de subprocessos. Testar prévia concorrendo com exportação.
- [x] Corrigir a fila dos dois workers e a invalidação ao mudar edição, aba ou modo. Testar falha síncrona, `messageerror`, resposta obsoleta, substituição de pendências, Source e recuperação de fallback.
- [x] Indexar traduções de offsets e adicionar testes de equivalência ao algoritmo anterior em fronteiras e amostras geradas de LF, CRLF, CR, Unicode, matemática e código. Cobrir 10 MB/72.000 parágrafos com a estratégia complementar de layout e os limites medidos no plano específico.
- [x] Retornar somente metadados no caminho de prévia ao vivo, mantendo o HTML do caminho síncrono para export/print e testando ambos.
- [x] Corrigir `scripts/preview-performance-test.mjs`: sequência de teclado verificável, amostra mínima em cada fase, sobreposição comprovada, medições de entrada p50/p95/p99/máximo e tempo até a versão correta da prévia. Incluir teste que injete um bloqueio para provar que o detector falha quando deve.
- [x] Registrar a suíte de performance no `scripts/test-all.mjs` e adicionar à CI os testes determinísticos de DOM/segurança e da fila. Executar a medição nativa em CI Windows somente se o runner tiver sessão WebView2 confiável; caso contrário, registrar explicitamente essa limitação e manter a validação nativa como requisito manual antes do merge, sem tratar skip como sucesso. Evitar gates temporais instáveis em runners compartilhados sem calibração.
- [x] Executar as camadas pertinentes de `AGENTS.md`, inclusive `npm test` antes do merge, suítes de exportação/sanitização e verificações reais em Windows/WebView2 e Linux/WebKitGTK. O teste Typewriter foi executado isoladamente no mesmo binário; a sessão da execução das outras 53 camadas terminou antes de podermos recuperar seu código de saída, mas todos os logs individuais terminaram com sucesso e o perfil restaurado coincidiu com o backup.
- [x] Comparar novamente performance e tamanho dos artefatos, documentar resultados, desvios e limites, atualizar scripts/documentação e o ADR. Os instaladores comparados anteriormente pertencem a build intermediário; os executáveis finais Windows/Linux foram medidos sem extrapolar os tamanhos dos pacotes.

## Files and modules

- `src/markdown.ts`, `src/preview-render.ts`, `src/preview-batches.ts` — fronteiras seguras de HTML, estágio, retorno live e renderização síncrona.
- `src/source-map.ts` — índice de offsets; `src/main.ts` — propriedade das gerações, modos, mapa, Typst e Read Aloud.
- `src/preview-worker-client.ts`, `src/preview-worker.ts`, `src/asciidoc-worker.ts`, `src/asciidoc-preview.ts` — cancelamento, fila, falhas e propriedade das prévias. Alterar `src/asciidoc-render.ts` somente se a propriedade/cancelamento exigir; não reescrever os includes fora do escopo.
- `src-tauri/src/typst.rs`, `src-tauri/src/lib.rs`, `src/api.ts` — processo/arquivos por job, registro e wrapper do novo comando explicitado acima.
- `src-tauri/src/export.rs` — reutilizar o diretório temporário exclusivo já existente para o HTML intermediário de exportações Typst/Pandoc. A investigação de ownership revelou que o caminho anterior `mdraft-typst/export.html` era compartilhado entre exportações; isolar esse arquivo é necessário para o critério aprovado de que jobs não leiam nem removam a saída uns dos outros.
- `scripts/preview-render-unit.mjs`, `scripts/preview-performance-test.mjs`, `scripts/test-all.mjs`, `package.json` — testes de mapeamento e performance e integração no runner; acrescentar testes auxiliares separados para worker/DOM/Typst onde necessário, documentando-os em `AGENTS.md`.
- `scripts/word-sync-test.mjs`, `scripts/scroll-sync-test.mjs`, `scripts/typst-preview-test.mjs` e `scripts/read-aloud-test.mjs` — cobrir seleção/escape durante mapa adiado, restauração de posição, cache Pages e leitura cancelada, aguardando o resultado em vez de fixar prazo artificial para word sync.
- `.github/workflows/quality.yml` — gates determinísticos e, somente se viável, o teste nativo de performance em Windows.
- `AGENTS.md`, este plano, `docs/audits/performance-review-perf-preview-render-worker.md` e o novo ADR complementar — registrar comandos, medições, decisões e eventuais desvios. Preservar os dados e scripts da auditoria.

## Risks and rollback

- **Segurança/fidelidade HTML:** o fallback de sanitização precisa preservar a árvore e a política de URLs/tags. Reverter o caminho de lote inseguro em separado se um caso novo divergir; não relaxar DOMPurify/CSP.
- **Offsets:** um índice incorreto pode pintar/selecionar a palavra errada. Manter comparação com a implementação anterior em testes e falhar sem pintar quando a equivalência não puder ser comprovada.
- **Cancelamento:** terminar workers/processos agressivamente pode atrasar cold start, perder uma atualização atual ou interferir na exportação. Testar gerações, recuperação e ownership dos arquivos; reverter a política de cancelamento independentemente do índice CRLF se necessário.
- **Perfis/testes:** o usuário confirmou que esta é uma máquina de testes e possui backup, mas resultados ainda precisam de estado inicial controlado. No Windows, Tauri usa Known Folders; `APPDATA` redirecionado isoladamente não isola o app.
- **Tamanho e plataformas:** avaliar executável/instalador com a mesma toolchain, perfil e arquitetura; frontend bruto não equivale ao tamanho do binário. Acima de 15% de aumento no tamanho atual, apresentar evidência para avaliação pessoal. Se Linux/WebKitGTK ou CI nativa não estiverem disponíveis, registrar como pendente e não declarar o merge validado.
- **Reversão:** agrupar commits por etapas independentes e preservar a versão `0.8.0`. Não migrar dados nem apagar arquivos do usuário; manter caminho de fallback e testes de exportação.

## Tests and validation

1. **Correção determinística:** `npm run preview:unit`, `npm run asciidoc:export:unit`, `npm run sync:unit`, `npm run block:map:unit`, `npm run read-aloud:unit`, novos testes de worker/DOM e testes Rust com subprocesso falso. Verificar HTML/árvore e ranges, não apenas contagens ou comprimento.
2. **Integração:** `npm run build`, `npm run lint`, `npm run format:check`, `npm run knip`, `npm run test:rust` e suites reais relacionadas, incluindo `smoke`, `sync`, `word-sync`, `preview:zoom`, `asciidoc`, `typst:preview`, `read-aloud`, `export`, `export:browser` e `pdf:native`; executar `npm test` completo antes do merge. No Windows, usar os wrappers MSVC e respeitar o isolamento documentado em `AGENTS.md`.
3. **Performance:** repetir em condições comparáveis as referências da auditoria, com ao menos três amostras quentes e dados brutos: Markdown LF/CRLF em ~0,5/1/10 MB, 72.000 parágrafos, linha/bloco único longo, AsciiDoc ~600 KB e digitação rápida durante abertura/render e alternância de abas/modos. Registrar p50/p95/p99/máximo de entrada, tempo até a última prévia correta, maiores tarefas/intervalos, CPU e memória quando disponíveis. Medir em Windows/WebView2 e Linux/WebKitGTK; distinguir observação real, proxy e hipótese.
4. **Tamanho:** comparar executável e instalador/pacote equivalente da `master` e da branch com ferramentas e configuração iguais; reportar bytes e percentual. O `dist/` é métrica complementar, não substituto do binário.
5. **Segurança:** testar scripts, handlers, URLs perigosas, HTML malformado e estruturas que atravessam lotes nos caminhos live/fallback/export, sem introduzir requisições externas de inicialização.

## Acceptance criteria

- O HTML reproduzido em F01 mantém a mesma árvore da `master` nos dois valores de `map`, no worker e no caminho síncrono/export; os testes de sanitização passam. HTML vazio não anuncia âncoras inexistentes.
- Typst mantém barra e sincronização após tema/preferências; apenas um processo de prévia fica ativo por vez, processos substituídos são encerrados/recolhidos e nenhuma prévia ou exportação pode ler/remover a saída de outro job. Chamadas antigas de `render_typst` sem token continuam funcionando.
- Stop, troca de aba ou edição durante preparação de Read Aloud não inicia uma leitura obsoleta; workers com erro, atraso ou resultado antigo não deixam a fila permanentemente presa nem aplicam conteúdo incorreto.
- Source não inicia nova renderização oculta e invalida trabalho pendente/em execução; ao voltar, a prévia atual é exibida. Word sync retoma corretamente após a estabilização, sem exigir um limite de 600 ms.
- **Proposta mensurável para aprovação:** na mesma máquina e com a mesma fixture de 10 MB/72.000 parágrafos CRLF, a mediana da conversão pura com mapa após a correção é pelo menos **2× mais rápida** que o HEAD anterior à correção, com resultados de offsets equivalentes. Também registrar LF e a experiência nativa completa; não interpretar esse multiplicador como garantia universal ou orçamento absoluto de interface.
- Preservar a meta já registrada no plano anterior para o host de referência de 1,2 MB: p95 de entrada até 100 ms e máximo até 150 ms, com amostra válida durante render. Medir p99 e demais cenários e apresentar eventuais regressões com contexto; não inventar limite adicional sem calibração e acordo.
- `npm test` e gates pertinentes passam; resultados de segurança/export e validações nativas em Windows e Linux são registrados, sem tratar testes não executados como aprovados. Comparação de tamanho é apresentada; aumento acima de 15% aguarda avaliação pessoal do responsável antes do merge.

## Execution notes

- Baseline do HEAD, antes da correção, na mesma máquina e com Node: fixture CRLF de 10.800.000 bytes e 72.000 parágrafos, três execuções quentes de 16.359,6 / 14.929,6 / 14.778,9 ms, mediana de 14.929,6 ms. Após indexar os offsets: 1.122,5 / 1.107,9 / 1.118,0 ms, mediana de 1.118,0 ms (13,35×). É uma medição da conversão pura, não da latência da aplicação. Comando: `node --expose-gc docs/audits/preview-worker-probes.mjs extreme CRLF`.
- O teste real de Typst reproduziu no binário anterior a falha da barra após mudar o tema; após a correção, passou em 53/53 verificações. A fila passou em 18/18; DOM com worker, fallback e sanitização em 12/12; tradução em 51/51; Read Aloud em 58/58; e exportações reais, incluindo duas simultâneas com cancelamento de prévia, em 42/42. Um teste posterior revelou que o cache de Pages precisava atualizar também o token da geração; correção e nova regressão estão aguardando repetição com o binário atualizado.
- Windows x64, mesma toolchain e `release --no-bundle`: executável `master` 18.873.856 bytes versus branch 19.151.872 (+1,47%); MSI 11.927.552 versus 12.201.984 (+2,30%); NSIS 10.437.051 versus 10.705.630 (+2,57%). Uma extração administrativa dos dois MSIs sem instalação mostrou somente o executável como arquivo do produto, portanto o payload extraído também cresce 1,47%; não inclui metadados ou WebView2 compartilhado. Instaladores foram gerados sem assinatura e sem alterar os artefatos existentes, e o da branch foi refeito após a correção independente de caminhos de imagem. O HEAD anterior às correções media 19.159.040 bytes.
- O backend normaliza CRLF para LF ao abrir um arquivo (`src-tauri/src/documents.rs`), portanto o ganho de 13,35× da conversão pura CRLF não deve ser apresentado como melhora medida de abertura nativa. A fixture nativa mantém CRLF no disco e mede o fluxo completo separadamente.
- No WebView2, a fixture extrema exibiu a prévia correspondente cerca de 4,1 s após a última entrada; um perfil registrou uma tarefa principal de 938 ms, incluindo cerca de 734 ms em `getBoundingClientRect` ao forçar layout. Uma experiência isolada de `content-visibility` reduziu o maior bloco a 431 ms, mas não provou correção de rolagem e não foi incorporada. O requisito de 10 MB sem congelamento continua aberto.
- Uma repetição posterior da fixture extrema passou em 5/5 verificações, incluindo word sync nas duas direções após a prévia (694 ms para as duas verificações). A maior tarefa observada ainda foi 887 ms; os p95 de entrada amostrados não cobrem necessariamente uma tecla durante essa tarefa.
- A suíte ampla também detectou que Escape podia ser seguido pela reaplicação de uma seleção enquanto o mapa estava pendente, e que o cache Typst Pages conservava o token anterior. Para Typst Document, a implementação agora reutiliza os intervalos já anotados quando uma troca de modo invalida um mapa pendente, sem nova compilação.
- As repetições posteriores passaram em 59/59 verificações de word sync e 55/55 de Typst (incluindo o exame opcional). A posição de uma aba Pages ainda voltava a zero: uma medição mostrou que o callback de ajuste de largura sobrescrevia a restauração da aba na mesma execução de frame. Invalidar esse ajuste obsoleto preservou 3.535 px na reprodução isolada (12/12).
- Três repetições alternadas no WebView2 com documento de 1.220.283 bytes e 20 pares de teclas: p95 424,6 / 433,1 / 426,2 ms na `master` e 1,9 / 1,7 / 1,8 ms na branch. As teclas medidas coincidiram com tarefa longa na `master` e worker ativo na branch; controle positivo e prévia final passaram. Dados brutos: `../audits/preview-native-comparison.json`. Essa amostra não cobre o layout posterior de 10 MB.
- A compactação experimental de 72.000 parágrafos produziu uma tarefa de 750 ms em uma execução e não foi incorporada. Como o objetivo de 10 MB sem congelamento permanece aberto e uma mudança estrutural foi expressamente excluída deste plano, a proposta concreta de contenção agrupada está em [`2026-11-05-large-preview-layout.md`](2026-11-05-large-preview-layout.md), aprovada posteriormente e em andamento.
- Debian/WSL, WebKitGTK 2.54: build release e testes de pipeline, worker e DOM passaram; a janela real abriu e editou o arquivo extremo e, após salvar novamente com a entrada visível, preservou os 144.000 CRLF. A primeira tentativa de salvar imediatamente após uma rajada gravou apenas o primeiro caractere enquanto os demais ainda chegaram ao editor e o documento permaneceu marcado como alterado. Esse resultado exige reprodução e análise; não é evidência de perda silenciosa nem de regressão exclusiva da branch. A amostra de memória do WebKit foi 1.379.604 KiB de RSS (aproximadamente 1,32 GiB), não pico medido.
- No Linux final, `cargo test --release --lib --offline` passou com 313 testes e quatro ignorados; pipeline, worker e DOM passaram em 51/51, 18/18 e 12/12. O executável `master` mede 23.886.208 bytes e o da branch 24.174.064 bytes (+1,21%). No teste de salvamento imediato, duas repetições de cada versão mantiveram a aba marcada como alterada e o segundo salvamento preservou a entrada inteira e os 144.000 CRLF; os dados estão em `../audits/linux-save-order-results.json`.
- Em solicitação adicional e independente deste plano, a geração de novas imagens Markdown passou a preservar barras Windows em `src/image-syntax.ts`; o teste real de pasta oculta passou em 29/29. A interpretação de referências antigas e a colagem rica estão separadas em [`2026-11-05-legacy-markdown-image-paths.md`](2026-11-05-legacy-markdown-image-paths.md), aprovado posteriormente e em andamento.
- CI receberá os testes determinísticos de worker/DOM; não há evidência de uma sessão WebView2 confiável no runner compartilhado, portanto a medição nativa permanece requisito anterior ao merge.

## Open questions

- A meta relativa mínima de **2×** para a conversão pura CRLF de 10 MB foi aprovada com este plano e atingida na fixture medida; ela não substitui medições de entrada e prévia no aplicativo real.
- O runner de CI Windows oferece sessão WebView2 suficientemente confiável para o gate nativo? Se não, usar CI para os testes determinísticos e registrar o teste nativo em ambiente controlado como requisito anterior ao merge.

# Auditoria de desempenho e qualidade — `perf/preview-render-worker`

**Data:** 2026-11-05

**Base:** `master` `b7da9c585531bf633ddfc7f94e6a5d1f7c094f4c`

**Branch:** `f1c8cf14e5ca4bb2040bea190e2d167bee08304d`

**Veredito:** **reprovar para merge na forma atual**.

A separação do trabalho em workers é uma direção defensável e houve redução do maior intervalo observado na thread principal em um benchmark isolado. Entretanto, há uma regressão reproduzida na estrutura de HTML de documentos grandes, uma falha determinística no reaproveitamento da prévia Typst e lacunas relevantes nos testes que deveriam proteger a meta de desempenho. A conclusão não depende de supor que os números do plano se apliquem a todas as máquinas.

**Convenções:** *Fato* é código inspecionado ou resultado reproduzido; *inferência* é consequência de um encadeamento de código identificado, ainda sem reprodução de ponta a ponta; *hipótese* precisa de medição ou teste adicional. `P/M/G` indicam esforço pequeno/médio/grande. Linhas se referem ao HEAD auditado. Benchmarks auxiliares estão em [`preview-worker-probes.mjs`](preview-worker-probes.mjs) e [`preview-worker-browser-bench.mjs`](preview-worker-browser-bench.mjs); os resultados brutos estão em [`preview-worker-measurements.json`](preview-worker-measurements.json).

## 1. Resumo executivo

Cinco riscos principais, em ordem de decisão de merge:

1. **F01 — HTML muda de estrutura em documentos grandes:** reproduzido em Chrome, tanto no worker quanto no caminho síncrono de exportação. A `master` mantém o conteúdo dentro de uma `<div>`; a branch o move para fora.
2. **F02 — Typst perde a barra Document/Pages e o mapa de palavras:** o reaproveitamento retorna depois de `doRender` já ter apagado ambos; trocar o tema é um acionador concreto.
3. **F03 — Compilações Typst podem disputar o mesmo arquivo temporário:** a implementação inicia a nova antes de garantir o fim da anterior e a limpeza de uma pode apagar a saída da outra. É uma inferência de concorrência, não um erro observado em execução real.
4. **F04 — Read Aloud pode recomeçar depois de Stop ou de uma troca de aba:** a invalidação da solicitação é registrada somente depois de aguardar a renderização. A sequência foi verificada no código; falta reprodução com voz real.
5. **F05/F06 — a proteção da meta de performance é insuficiente:** o novo teste escuta `keydown`, mas injeta `char`; não integra `npm test` nem a CI. Um render obsoleto ainda em execução também bloqueia o próximo no mesmo worker.

Cinco oportunidades de maior retorno imediato são: corrigir o reaproveitamento Typst; iniciar o controle de cancelamento de leitura antes do primeiro `await`; recuperar a fila após falha de `postMessage`; tornar o teste de latência válido e obrigatório; eliminar a serialização de HTML não utilizada na prévia ao vivo. A tabela da seção 9 inclui ganhos, confiança, custo, risco, dependências, validação e momento recomendado. A correção de F01 é obrigatória por fidelidade do documento, mesmo não sendo uma otimização.

**Limite importante da auditoria:** as execuções iniciais de interface não usaram um perfil limpo por um erro meu de isolamento. Seus resultados não foram usados para concluir que há regressão da branch. O incidente e as alternativas de recuperação estão registrados na seção 10.

## 2. Diff completo e contratos atingidos

O diff `master...perf/preview-render-worker` tem **5 commits, 28 arquivos, 2.981 adições e 700 remoções**:

| Commit | Conteúdo |
| --- | --- |
| `3a21d7d` | Worker Markdown, mudança de agendamento e mapa, opção de cursor, cancelamento/cache Typst, testes e plano/ADR. |
| `4b40b0a` | Worker AsciiDoc, fragmentação, pré-leitura de includes e testes relacionados. |
| `cdb4115` | Unidades de preview e AsciiDoc na CI; `preview-unit` no runner geral. |
| `f179971` | Staging fora do DOM ativo, lote único para documentos menores e retorno aos tempos de espera anteriores. |
| `f1c8cf1` | Versão `0.7.8` → `0.8.0`. |

Inventário integral, por grupo:

- **Renderização e interface:** `src/main.ts`, `src/markdown.ts`, `src/preview-render.ts`, `src/preview-worker.ts`, `src/preview-worker-client.ts`, `src/preview-batches.ts`, `src/asciidoc-preview.ts`, `src/asciidoc-render.ts`, `src/asciidoc-worker.ts`, `src/editor.ts`, `src/preferences.ts` e `src/api.ts`.
- **Rust/configuração:** `src-tauri/src/typst.rs`, `src-tauri/src/settings.rs`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` e `src-tauri/tauri.conf.json`.
- **Testes e CI:** `scripts/preview-performance-test.mjs`, `scripts/preview-render-unit.mjs`, `scripts/asciidoc-export-unit.mjs`, `scripts/test-all.mjs` e `.github/workflows/quality.yml`.
- **Pacote e documentação:** `package.json`, `package-lock.json`, `AGENTS.md`, `docs/adr/2026-11-04-preview-render-worker.md`, `docs/plans/2026-11-04-preview-render-performance.md` e `docs/plans/2026-11-04-asciidoc-preview-worker.md`.

O contrato `render_typst` ganhou `token` opcional (`src/api.ts:647`, `src-tauri/src/typst.rs:493`); chamadas sem token continuam aceitas. `cursorBlink` é aditivo e possui default por plataforma (`src-tauri/src/settings.rs:164`, `:324`). Não há dependência npm ou Cargo nova no diff dos manifestos/lockfiles. O CSP já permitia workers locais (`src-tauri/tauri.conf.json:28`). A versão foi alterada além dos itens dos dois planos, sem publicação de release comprovada por este diff.

## 3. Matriz plano × implementação

| Item planejado | Status | Evidência ou desvio |
| --- | --- | --- |
| Extrair parsing Markdown, KaTeX, fragmentos e linhas para pipeline puro | Implementado | `src/preview-render.ts:435`; `highlight.js` permaneceu no DOM, desvio explicado no plano. |
| Worker Markdown e fila de uma tarefa ativa/uma pendente | Implementado parcialmente | `src/preview-worker-client.ts:27`; resultados antigos são descartados, mas a tarefa ativa não é preemptada e erro síncrono pode travar a fila: F06/F10. |
| DOMPurify no thread principal e caminho síncrono de fallback/export | Implementado parcialmente | `src/markdown.ts:134`, `:156`, `:232`; a divisão de HTML bruto em lotes altera a árvore: F01. |
| Staging, troca única e retorno ao debounce antigo | Implementado | `src/markdown.ts:174`, `:186`; `src/main.ts:1308`; a mudança corrige a regressão de layouts repetidos registrada no plano. O limite dos lotes não é rígido: F08. |
| Sem trabalho de prévia no modo Source | Parcial | Novos renders são evitados em `scheduleRender`, mas mudança de modo não invalida tarefa ou timer já ativos: F07. Read Aloud força render por decisão explícita. |
| Fragmentos/mapa só no Split, depois do paint e após período quieto | Parcial | `src/main.ts:1714`, `:4406`; o timer não é cancelado ao mudar de modo e o mapa fica indisponível durante a espera: F07. |
| Mermaid depois da primeira pintura | Parcial | Markdown é iniciado sem `await`, mas não há garantia de frame antes da microtask; em AsciiDoc o staging aguarda todos os diagramas: F12. |
| Opção persistida de cursor; Linux desligado por padrão | Implementado | `src/editor.ts:746`, `src/preferences.ts:1659`, `src-tauri/src/settings.rs:324`; arquivos antigos sem o campo também recebem o default Linux, não somente perfis novos. |
| Typst: cache, cancelamento, um processo e sem compilar em Source | Parcial | Cache e cancelamento existem, mas há perda de controles, sobreposição de processos e trabalho já iniciado que pode continuar: F02/F03/F07. |
| Worker AsciiDoc separado e chunker/markers compartilhados | Implementado | `src/asciidoc-worker.ts`, `src/asciidoc-render.ts:235`, `:396`; fidelidade ampla precisa de testes de DOM/limites. |
| Pré-leitura de includes com jail, guarda de ciclos e fallback para destinos dinâmicos | Implementado com ressalva | `src/asciidoc-render.ts:356`; o scanner lê includes em condicionais inativas: F09. O fallback explícito preserva a correção quando o destino não é conhecido. |
| Unitários do pipeline e da exportação AsciiDoc | Implementado | 36/36 e 28/28 passaram; são testes sem DOM e não detectaram F01. |
| Teste de latência e long tasks no Windows | Criado, aceitação não demonstrada | `scripts/preview-performance-test.mjs:153`, `:186`; F05. Não aparece em `npm test -- --list` nem na CI. |
| Goldens, sanitização, render/export e suítes reais antes do merge | Não comprovado | Os planos relatam goldens e medições históricas, mas não localizei golden automatizado da árvore sanitizada nos novos testes; a validação de interface desta auditoria foi invalidada pelo perfil compartilhado. |
| ADR, registros e documentação de testes | Implementado com inconsistência | ADR aceito; planos marcados `done` apesar de critérios ainda sem evidência suficiente. `AGENTS.md` descreve `preview:perf` na tabela geral, mas o runner não o registra. |

## 4. Avaliação das decisões

| Decisão | Alternativas e avaliação | Recomendação |
| --- | --- | --- |
| Worker para parsing e KaTeX; DOMPurify/DOM no host | Boa separação de responsabilidade. Aumentar só o debounce não reduziria um bloqueio já iniciado; DOM/sanitizador alternativo no worker aumentaria superfície e dependências. O custo é cópia/serialização entre contextos, memória de dois ambientes e maior tempo até a prévia. | Preservar, corrigindo semântica, cancelamento e cobertura. |
| Dois workers, um por engine | Evita inicializar Asciidoctor em sessões apenas Markdown. Custa **967.750 bytes brutos** adicionais só nos dois bundles; bibliotecas usadas também no host podem ser duplicadas. | Preservar até comparar uma alternativa real. Não prometer redução do executável: ainda não foi medido antes/depois. |
| Documento inteiro, não render incremental | Menor alteração arquitetural e menor risco inicial que virtualização por bloco. Mantém custo de documento inteiro, cópias e espera por tarefa obsoleta, especialmente em CRLF grande: F06/F15. | Aceitável como etapa, sujeito a metas explícitas por tamanho; avaliar incremental somente com perfil de uso e benchmark. |
| Sanitizar e inserir em lotes num staging | A troca única evita layouts repetidos e mantém a prévia anterior visível. A suposição de que cada token constitui HTML independente é falsa: F01. Lote indivisível também não limita jank: F08. | Preservar a segurança e a árvore DOM antes de otimizar; usar fallback seguro quando não for possível provar uma fronteira. |
| Mapa em idle, após 600 ms | Reduz trabalho entre tecla e frame. Um callback de idle não é preemptivo; pode executar uma caminhada longa e ficar indisponível durante a janela. A mudança de modo não cancela o callback: F07. | Manter o adiamento se houver teste de uso imediato, cancelamento e orçamento para a caminhada. |
| Cancelar/descartar trabalho obsoleto | Uma pendência substituível limita a fila de memória, mas não interrompe a tarefa ativa. Typst tenta parar subprocessos, porém não os serializa nem isola a saída: F03/F06. | Provar ownership de resultados e arquivos por geração; testar sequência fora de ordem e cancelamento durante escrita. |
| Pré-ler includes antes do Asciidoctor | Resolve a impossibilidade de chamar IPC do worker e preserva fallback para alvos dinâmicos. O scanner é independente dos condicionais e repete leituras sequenciais a cada render: F09. | Fazer a leitura depender da semântica real ou validar/cachar um plano de includes; nunca relaxar o jail. |
| Cursor sólido por padrão no Linux | O custo de CPU no plano fornece motivação; a preferência é reversível. Não medi CPU de repouso nesta auditoria e a alteração também atinge perfis existentes sem o campo. | Preservar como opção, documentando comportamento de upgrade e medindo com WebKitGTK atual. |
| Versão `0.8.0` | Operação de release separada da otimização; não altera dependências. | Confirmar política de versão antes da integração; a alteração isolada não comprova pacote publicado. |

## 5. Achados detalhados

### F01 — Sanitização por lote altera o aninhamento de HTML bruto

**Severidade:** Alta · **Categoria:** Falha · **Evidência:** fato reproduzido · **Esforço:** M/G.

**Localização:** `src/preview-render.ts:331`, `src/preview-batches.ts:14`, `src/markdown.ts:142`, `:176`, `:232`; exportação em `src/main.ts:2683`.

Tokens `marked` consecutivos podem ser partes de uma única árvore HTML. O agrupamento por tamanho colocou `<div class="auditbox">` no fim de um lote e `<p>INSIDE</p></div>` no seguinte. Cada lote é sanitizado e interpretado por um parser HTML independente, que fecha a `div` no primeiro lote. No teste de 375.517–375.542 bytes, `boxContainsInside` foi **true na master e false na branch**, tanto com `map: true` como `false`, na prévia e em `renderPreview` síncrono. O texto permanece no documento, mas muda de elemento/pai; mesmo comprimento de HTML não prova equivalência.

**Impacto:** layout, CSS, semântica/acessibilidade e HTML/print/export podem mudar para Markdown válido. Nenhuma perda do arquivo-fonte foi observada. **Ação:** reconhecer e manter juntas estruturas brutas que atravessam tokens, ou usar uma sanitização comum e segura para o caso em que a fronteira não seja comprovadamente independente. Acrescentar teste DOM com HTML aninhado perto de vários limites, em ambos os modos e na exportação, além do teste de segurança; medir o custo do fallback.

### F02 — Cache Typst retorna depois de apagar controles e mapa

**Severidade:** Alta · **Categoria:** Falha · **Evidência:** fato de fluxo estático · **Esforço:** P.

**Localização:** `src/main.ts:1040`, `:1433`, `:1652`, `:1666`, `:1669`.

`setTheme` agenda render imediato. `doRender` remove `.typst-viewbar` e zera `wordMap`; em seguida, se documento/revisão/modo/raiz coincidirem, `renderTypstPreview` retorna pelo cache sem recriá-los. A prévia fica visível, porém o controle Document/Pages desaparece e a sincronização de palavras pode deixar de funcionar, apesar de `syncReady` ser mantido.

**Ação:** verificar o cache antes de destruir estado, ou reaplicar o resultado em cache e reconstruir somente os elementos necessários. Testar troca de tema e preferências com Typst Document e Pages, depois seleção/sincronização. A inferência sobre a experiência não foi executada em um perfil de teste limpo nesta auditoria.

### F03 — Cancelamento Typst não isola processos nem arquivo de saída

**Severidade:** Alta · **Categoria:** Risco · **Evidência:** fato de código + interleaving inferido · **Esforço:** M/G.

**Localização:** `src-tauri/src/typst.rs:53`, `:505`, `:557`, `:581`, `:584`, `:654`, `:829`; chamada sem token em `src/main.ts:2679`.

Uma geração nova sinaliza a antiga e inicia sua própria tarefa; a antiga só consulta o sinal depois de escrever todo o stdin e no laço que dorme 40 ms. Logo, duas compilações podem coexistir. Ambas em Document usam `<temp>/mdraft-typst/document.html`; a antiga cancelada executa `remove_file(output)`, podendo remover a saída recém-escrita pela nova antes da leitura. Exportação chama o mesmo comando sem token e também pode concorrer. Se um token antigo chegar depois de um novo, `begin_preview` ainda substitui a entrada do registro. O arquivo compartilhado existia na base; a limpeza por cancelamento e a promessa de processo único são novas.

**Impacto:** inferência de falha de preview/export ou conteúdo trocado; não foi observado em um teste real. **Ação:** criar diretório/arquivo exclusivo por job, impedir que um job remova arquivo de outro, ordenar/recusar gerações antigas e cancelar também durante envio de stdin. Testar com compilador falso controlando tempos, processos, saída e export simultâneo.

### F04 — Stop e troca de aba não cancelam início de leitura em espera

**Severidade:** Alta · **Categoria:** Falha · **Evidência:** fluxo estático; efeito de áudio a reproduzir · **Esforço:** P.

**Localização:** `src/main.ts:6053`, `:6118`, `:6121`, `:6136`, `:6158`, `:2190`.

`startReadAloud` aguarda `ensurePreviewRendered()` antes de incrementar `readAloudRequest`. Um Stop ou troca de aba durante essa espera incrementa o contador, mas a continuação antiga cria depois um token novo e pode iniciar a fala. Se o render for invalidado, `ensurePreviewRendered` também não informa ao chamador que a prévia não foi atualizada.

**Ação:** registrar a solicitação e parar a fala anterior antes do primeiro `await`; depois conferir token, identidade/revisão do documento e resultado efetivo da renderização. Testar Stop, troca de aba e edição com worker atrasado e backend de voz falso.

### F05 — O teste de performance não mede as teclas que injeta nem é executado no fluxo padrão

**Severidade:** Alta · **Categoria:** Falha de teste · **Evidência:** fato reproduzido em Chromium, integração inspecionada · **Esforço:** M.

**Localização:** `scripts/preview-performance-test.mjs:153`, `:178`, `:186`, `:217`, `:252`, `:325`; `scripts/test-all.mjs:135`; `.github/workflows/quality.yml:75`.

O coletor observa `keydown`, mas o CDP envia apenas `Input.dispatchKeyEvent {type:"char"}`. No Chrome 156 isolado, um `char` gerou **0 keydown, 1 keypress e 1 input**. Nessa configuração, as fases que exigem contagem mínima receberiam zero; nas fases sem contagem mínima, o código transforma amostra vazia em `p50/p95/max = 0`, o que pode aprovar uma medição inexistente. O p95 é impresso, mas não é comparado ao limite de 100 ms do plano. Long Tasks ausentes também viram zero. Além disso, o teste não confirma que a digitação se sobrepôs a um worker ativo e não consta em `npm test -- --list` ou no workflow Quality.

**Ação:** emitir sequência realista `keyDown`/`char`/`keyUp`, medir input-to-editor e idade a partir de um relógio verificável, exigir contagem em toda fase, sinalizar Long Tasks indisponíveis, provar sobreposição, impor p95 e máximo e registrar a suíte no runner/CI de Windows. Confirmar o evento no WebView2; Chrome headless não substitui o teste nativo.

### F06 — Uma tarefa obsoleta impede a mais recente de começar

**Severidade:** Alta · **Categoria:** Ponto fraco · **Evidência:** fato de fila + impacto inferido · **Esforço:** M.

**Localização:** `src/preview-worker-client.ts:38`, `:79`, `:89`, `:100`; `src/main.ts:2130`.

A fila substitui somente a requisição **pendente**. O job ativo não recebe cancelamento, inclusive após edição, troca de aba ou entrada em Source. A nova versão aguarda a conclusão dele. O benchmark isolado de F15 levou 16,16 s para processar um CRLF de 10,8 MB em Node; não é uma medição de WebView2, mas demonstra uma carga que pode manter a fila ocupada por tempo material.

**Ação:** decidir política mensurável: checkpoints cooperativos com cancelamento, ou terminar/recriar o worker após limiar que compense o cold start. Não permitir starvation com digitação contínua. Medir tempo da última edição até a prévia correta, CPU e memória após mudar de aba; provar que jobs intermediários não são aplicados.

### F07 — Mudar para Source/Preview não invalida trabalho já agendado

**Severidade:** Média · **Categoria:** Falha · **Evidência:** fato de fluxo estático · **Esforço:** P/M.

**Localização:** `src/main.ts:1293`, `:3992`, `:4406`, `:4430`, `:4440`.

`setViewMode("source")` limpa `renderTimer`, mas não incrementa `renderToken` nem `wordMapGeneration`. Um worker iniciado antes da mudança pode terminar e montar a prévia oculta; um mapa agendado no Split pode ser construído em Source ou Preview-only. Isso contraria o critério de evitar trabalho oculto e pode disputar a thread principal com a próxima tecla.

**Ação:** invalidar e cancelar trabalho de render/mapa ao sair do modo apropriado, manter `previewStale` correto e reconstruir a versão atual ao voltar. Testar mudança de modo em cada ponto de espera e durante um bloco grande.

### F08 — O orçamento de lote não é limite de trabalho na thread principal

**Severidade:** Média · **Categoria:** Ponto fraco · **Evidência:** fato reproduzido · **Esforço:** M/G.

**Localização:** `src/preview-batches.ts:8`, `:14`, `:19`, `:36`, `:45`; `src/markdown.ts:182`, `:240`; `src/asciidoc-preview.ts:182`.

Um único chunk nunca é dividido. `batchesForChunks(["x".repeat(1_048_576)])` devolveu um lote de **1.048.576 caracteres**, apesar do alvo de 65.536. `.length` mede unidades UTF-16, não bytes. Sanitização, highlight, passes globais de headings/links/linhas, serialização e a troca final são tarefas síncronas; `settleMainThread` só cede depois de cada lote. O intervalo máximo observado no benchmark de 947.200 bytes continuou em 78,1 ms de mediana, embora menor que na base.

**Ação:** instrumentar cada fase, projetar limites em termos de trabalho e não chamar 64 KiB de garantia. Tratar blocos enormes com estratégia que preserve HTML e sanitização; incluir parágrafo/linha/tabela/fence único grande e muitos elementos. Definir meta de frame e testar p95/pior caso.

### F09 — Pré-leitura AsciiDoc lê includes de condicionais inativas

**Severidade:** Média · **Categoria:** Ponto fraco · **Evidência:** fato reproduzido · **Esforço:** M.

**Localização:** `src/asciidoc-render.ts:231`, `:356`, `:365`, `:374`; `src/asciidoc-preview.ts:300`.

Para `ifdef::missing[]` contendo `include::unused.adoc[]`, a pré-leitura chamou `readFile("C:/audit/unused.adoc")`; o Asciidoctor, na conversão real da mesma fonte, fez **zero leituras**. Em simulação com 25 includes inativos e atraso artificial de 5 ms por leitura, foram feitas 25 leituras sequenciais e o pré-processamento levou 387,4 ms. O tempo inclui a granularidade de timers deste Windows e não é benchmark de disco.

**Impacto:** I/O, cópia e espera desnecessários a cada reconstrução; um render invalidado não interrompe a pré-leitura antes do fim. **Ação:** respeitar condicionais/semântica do preprocessor ou usar protocolo assíncrono de includes com cache seguro e cancelamento; comparar I/O frio/quente e conteúdo com incluídos aninhados, dinâmicos, ausentes e fora do jail.

### F10 — Exceção em `postMessage` deixa o canal permanentemente ocupado

**Severidade:** Média · **Categoria:** Risco de robustez · **Evidência:** injeção de falha reproduzida · **Esforço:** P.

**Localização:** `src/preview-worker-client.ts:50`, `:61`, `:89`, `:100`, `:103`.

Um `Worker` falso que lança `DataCloneError` em `postMessage` faz a primeira promessa rejeitar e deixa a segunda sem solução por pelo menos 250 ms, pois `running` já está `true`. Não há `try/catch` nesse envio, tratamento de `messageerror` ou timeout. Os argumentos atuais são clonáveis; a injeção não demonstra que o erro ocorra em operação normal.

**Ação:** capturar erro síncrono, resolver/limpar ambas as solicitações e escolher fallback ou recriação controlada; lidar com `messageerror` e job que não responde. Adicionar teste com worker falso e contador local de fallback, sem telemetria.

### F11 — A prévia ao vivo serializa um HTML que o chamador não usa

**Severidade:** Baixa · **Categoria:** Oportunidade · **Evidência:** fato medido em cenário sintético · **Esforço:** P.

**Localização:** `src/markdown.ts:186`, `:187`, `:257`, `:261`; `src/main.ts:1714`.

Depois de mover os nós para o host, `describePreview` acessa `host.innerHTML` para preencher `result.html`; o chamador ao vivo usa apenas mapeamento/fragmentos. No DOM sintético com 1.266.935 caracteres serializados, a mediana de cinco acessos foi **2,3 ms** no Chrome headless. Isso cria uma string adicional; alocação física e impacto de GC real não foram medidos.

**Ação:** retornar metadados no caminho ao vivo e só serializar no contrato de exportação síncrona. Validar saída exportada, memória de pico e p95 com documentos maiores.

### F12 — Mermaid de AsciiDoc bloqueia a troca do staging

**Severidade:** Média · **Categoria:** Decisão questionável · **Evidência:** fato de código; impacto ainda não medido · **Esforço:** M.

**Localização:** `src/asciidoc-preview.ts:182`, `:248`, `:342`, `:347`; `src/main.ts:1738`.

`finishAsciidoc` aguarda `renderMermaidIn` antes de inserir o staging no host. Um diagrama lento ou o carregamento frio da biblioteca adia toda a nova prévia. Em Markdown a execução é destacada com `void`, mas isso, isoladamente, não garante que um frame tenha sido pintado antes das microtasks.

**Ação:** trocar o texto primeiro e renderizar diagramas com propriedade por geração, mantendo a proteção contra resultados antigos e a reancoragem. Medir tempo até primeiro texto, tempo até diagramas e edição durante import/render, em ambos os formatos.

### F13 — Documento Markdown vazio passa a declarar linhas mapeadas

**Severidade:** Baixa · **Categoria:** Falha de contrato · **Evidência:** fato reproduzido · **Esforço:** P.

**Localização:** `src/preview-render.ts:387`, `:501`; `src/markdown.ts:257`.

Para fonte vazia, a master retornou `{html:"", linesMapped:false, anchors:0}` e a branch retorna `linesMapped:true` porque compara duas contagens zero. Não foi demonstrado prejuízo visual, mas o sinal afirma disponibilidade de um mapa inexistente.

**Ação:** exigir pelo menos um bloco mapeado e acrescentar teste no contrato DOM, incluindo arquivo somente com comentário.

### F14 — O ganho de responsividade custa quase 1 MB no frontend

**Severidade:** Média · **Categoria:** Trade-off / decisão a acompanhar · **Evidência:** build comparativo reproduzido · **Esforço:** M/G.

**Localização:** `src/preview-worker-client.ts:107`, `:110`; `src/markdown.ts:13`.

Com dependências copiadas idênticas e build Vite igual, `dist/` passou de **15.889.911 para 16.865.396 bytes** (+975.485; +6,14%); JavaScript passou de **11.558.537 para 12.534.022 bytes** (+8,44%). Os workers medem 590.612 e 377.138 bytes brutos. Eles são criados sob demanda e permanecem enquanto a página vive; o staging coexiste com a prévia anterior. O delta do executável instalado, cold start e memória de uma sessão longa não foram medidos.

**Ação:** medir o binário das duas versões com a mesma toolchain; registrar cold start, RSS por processo e p95 ao abrir/alternar formatos. O responsável considera um aumento de 10% a 15% aceitável quando os benefícios justificam o custo; acima disso, pede avaliação pessoal. Avaliar compartilhamento ou carregamento tardio apenas se preservar fallback e compatibilidade CSP.

## 6. Oportunidade em código fora do diff, diretamente afetado

### F15 — Conversão de offsets é quadrática com muitos CRLF/substituições

**Severidade:** Alta para escala · **Categoria:** Oportunidade · **Evidência:** fato medido na branch; algoritmo já existente na base · **Esforço:** M.

**Localização:** `src/source-map.ts:227` (**fora do diff**), chamado por `src/preview-render.ts:242` e alimentado pela normalização em `:471`.

`translateOffset` percorre linearmente as substituições anteriores em cada consulta. Com muitas linhas CRLF e muitos fragmentos, o custo aproxima-se de `O(fragmentos × substituições)`. Em Node 24, 72.000 parágrafos equivalentes com `map:true`, sem matemática, levaram **1.080,2 ms em LF (10.656.000 bytes)** e **16.160,1 ms em CRLF (10.800.000 bytes)**, uma execução cada. O RSS máximo do processo foi respectivamente 301.536 e 330.796 KiB; inclui Node e não é o RSS do aplicativo. Em 6.400 parágrafos, as medianas de três amostras foram 100,6 ms LF e 199,0 ms CRLF. A mesma função linear já estava na `master`; não atribuir a diferença LF/CRLF à branch.

Uma prova de conceito com 12.800 substituições e 6.400 consultas produziu os mesmos resultados em **48,3 ms** com a função atual versus **0,6 ms** com busca binária e prefixos, sem incluir o custo de construir o índice. É microbenchmark sintético, não ganho completo do produto.

**Ação:** pré-computar deslocamentos acumulados e usar busca binária (`O(N + F log N)`), ou uma varredura monotônica se a ordem de consultas for garantida. Testar limites de substituições, CRLF/CR isolado, Unicode UTF-16, código e fórmulas; medir prévia completa e consumo de memória. **Incluir antes do merge:** o responsável confirmou que 10 MB em CRLF com dezenas de milhares de parágrafos é alvo obrigatório.

## 7. Medições, testes e limitações

### Ambiente e método

Windows 10.0.26200, Intel Core Ultra 7 265KF, 20 núcleos lógicos e 68.398.948.352 bytes de RAM; Node `v24.22.0`, npm `12.2.0`, Vite `8.3.5`, Chrome headless `156.0.8078.80`. WebView2 instalado `156.0.4314.58`. As duas revisões foram extraídas com `git archive` para diretórios descartáveis e usaram a **mesma cópia** de `node_modules`; os lockfiles diferem apenas na versão do pacote. Builds frontend completos passaram fora do sandbox após o `EPERM ... realpath` documentado em `AGENTS.md:1015`.

O benchmark de navegador importa somente os renderizadores Markdown e AsciiDoc em uma página vazia servida por Vite; não inicia Tauri, CodeMirror, zoom, scroll, mapa tardio, Mermaid, CSP do produto ou teclado de hardware. São três amostras quentes após uma de aquecimento, em um único host; o intervalo máximo de um timer de 10 ms é um **proxy de disponibilidade da thread**, não latência de tecla nem frame time. Na execução Markdown da tabela a instrumentação viu um worker criado, 11 respostas `ok` e zero erros na branch; na execução separada que acrescentou AsciiDoc, viu dois workers e 15 respostas `ok`. Os testes de HTML contêm um caso benigno e um com `<script>` removido; não constituem gauntlet de segurança.

| Medida | Master | Branch | Leitura |
| --- | ---: | ---: | --- |
| Renderer, 118.400 bytes, mediana | 18,0 ms | 18,4 ms | Tempo total semelhante neste caso. |
| Maior intervalo do timer, 118.400 bytes, mediana | 25,5 ms | 17,4 ms | Proxy melhora; não é p95 de input. |
| Renderer, 947.200 bytes, mediana | 118,8 ms | 130,6 ms | Aproximadamente 10% mais tempo total nesta amostra. |
| Maior intervalo do timer, 947.200 bytes, mediana | 177,5 ms | 78,1 ms | Aproximadamente 56% menor, mas ainda acima de um frame de 60 Hz. |
| Renderer AsciiDoc, 592.009 bytes, mediana | 65,4 ms | 96,2 ms | Aproximadamente 47% mais tempo total nesta amostra sem matemática/includes. |
| Maior intervalo do timer AsciiDoc, 592.009 bytes, mediana | 100,2 ms | 75,4 ms | Proxy cerca de 25% menor na execução separada. |
| HTML bruto cruzando lote | conteúdo dentro da `div` | conteúdo fora da `div` | Reproduzido nos dois valores de `map` e no caminho síncrono. |
| `dist/` não comprimido | 15.889.911 B | 16.865.396 B | +975.485 B / +6,14%; não é delta do executável. |
| JavaScript de `dist/` | 11.558.537 B | 12.534.022 B | +975.485 B / +8,44%. |

Workers isolados: Markdown 590.612 B bruto / 182.171 B gzip; AsciiDoc 377.138 B bruto / 104.227 B gzip. Gzip individual não representa o tamanho final do instalador. O primeiro build dentro do sandbox falhou por `EPERM` de `realpath`; o mesmo build, nas duas cópias, passou fora do sandbox. Os números históricos Linux dos planos são úteis, mas não foram repetidos aqui.

**Validações executadas:** `npm run preview:unit` 36/36; `npm run asciidoc:export:unit` 28/28; `npm run sync:unit` 29/29; `npm run block:map:unit` 15/15; `npm run typst:map:unit` 24/24; `npm run read-aloud:unit` 106/106; `npm run p0:unit` 112/112; `npm run test:sessions` 60/60; `npm run lint`, `format:check`, `knip` e `check:version` passaram. `cargo-vcvars.cmd test --manifest-path src-tauri/Cargo.toml --lib` compilou, mas o executável sob o workspace teve 58 falhas, incluindo `Access is denied. (os error 5)` ao acessar temporários; a **mesma cópia do executável de testes**, executada fora do workspace com temporários próprios, passou **297**, com **2 ignorados**. Essa limitação do host já está documentada em `AGENTS.md`.

**Não comprovado:** UI nativa com perfil realmente isolado; `npm test` completo; p95 de tecla real; antes/depois do executável/instalador; startup frio; consumo de CPU ociosa; memória de longa duração, várias abas e processos; 1 milhão de linhas; AsciiDoc/Typst extremo; Linux/WebKitGTK nesta auditoria; gauntlet de sanitização e exportações completas; cancelamento real de subprocessos. Não extrapolar o tempo de Node ou Chrome para essas metas.

### Reprodução dos probes

Com Node 24, a partir da raiz do repositório:

```powershell
node --expose-gc docs/audits/preview-worker-probes.mjs scale
node --expose-gc docs/audits/preview-worker-probes.mjs extreme LF
node --expose-gc docs/audits/preview-worker-probes.mjs extreme CRLF
node docs/audits/preview-worker-probes.mjs offsets
node docs/audits/preview-worker-probes.mjs includes
node --experimental-transform-types docs/audits/preview-worker-probes.mjs channel
```

Para o navegador, criar uma pasta descartável chamada `mdraft-audit` com subpastas `master` e `branch` extraídas por `git archive master` e `git archive perf/preview-render-worker`, mais uma cópia compartilhada de `node_modules` no pai. Executar `node docs/audits/preview-worker-browser-bench.mjs <caminho-absoluto-da-pasta-mdraft-audit>`. O script cria páginas de teste apenas nessas cópias, usa perfil Chrome próprio e portas locais efêmeras. O resultado bruto é gravado na pasta descartável. Para Tauri no Windows, **não** usar redirecionamento de `APPDATA` como isolamento: compilar com identificador de teste separado ou usar o harness normal sem sobrescrever a variável e com backup/restore verificados.

## 8. Lacunas de testes e observabilidade

- Não há gate de desempenho no runner/CI; o teste existente tem coleta inválida e não garante sobreposição ou p95: F05. O limite opt-in `MDRAFT_PREVIEW_PERF_SECONDS` em `scripts/preview-render-unit.mjs` mede a função pura e não está habilitado por padrão.
- As unidades novas verificam chunks e contagens, mas não os sanitizam como árvore DOM; F01 e F13 passaram despercebidos. Acrescentar goldens **versionados e executáveis** para árvore DOM, fragmentos, linhas e export, com testes de fronteira e arquivos reais.
- Exercitar `<script>`, handlers, URLs perigosas, HTML malformado, `<div>` atravessando lote e KaTeX antes/depois da sanitização nos dois caminhos e nos dois sistemas. Não se afirma aqui existir uma vulnerabilidade explorável.
- Faltam testes de worker que atrasa, trava, falha ao enviar, emite `messageerror`, devolve fora de ordem e é invalidado por edição/modo/aba; faltam testes de processo Typst e leitura com interleavings controlados.
- Não há métricas locais persistentes de sucesso/fallback, tempo de fila, parsing, sanitização, swap, mapa, diagramas, memória ou cancelamento. Adicionar `performance.mark`/contadores **locais e opt-in**, sem rede/telemetria, para distinguir gargalo de fallback.
- Sem feature flag de rollback do worker; o fallback automático trata algumas falhas, não uma regressão semântica válida. Uma chave interna de diagnóstico ou rollback deve ter custo e política de suporte explícitos.

## 9. Plano de ação e oportunidades priorizadas

Pontuação qualitativa `(ganho × confiança) / (esforço × risco)`: ganho e confiança 1–5; esforço P/M/G = 1/2/3; risco baixo/médio/alto = 1/2/3. Ganho inclui correção/risco evitado; não representa velocidade medida em todos os dispositivos. A ordem orienta retorno, mas **todos os itens antes do merge são obrigatórios**, mesmo quando seu score é menor.

| Ordem / item | Ganho esperado e confiança | Esforço / risco / dependências | Validação | Quando | Score |
| --- | --- | --- | --- | --- | ---: |
| 1. F02: preservar barra e mapa no cache Typst | Recupera controle e sincronização; alta | P / baixo / teste com Typst | Tema/preferência em Document e Pages, seleção posterior | Antes do merge | 25 |
| 2. F04: token de fala antes de esperar | Evita fala posterior a Stop/aba; média-alta | P / baixo / backend de voz falso | Worker atrasado, Stop e troca/edição | Antes do merge | 16 |
| 3. F10: limpar falha de envio | Evita fila presa em falha injetada; alta | P / baixo / worker falso | `postMessage` lança, `messageerror`, job seguinte conclui/fallback | Antes do merge | 15 |
| 4. F05: corrigir e registrar benchmark | Proteção real de p95/max; alta | M / baixo / CI Windows com perfil isolado | Falhar com bloqueio injetado; contagem em toda fase | Antes do merge | 10 |
| 5. F11: não serializar no live | ~2,3 ms e uma string de 1,27 M caracteres no teste; alta para este cenário | P / baixo / separar retorno live/export | Comparar DOM/export e memória de pico | Antes do merge, no plano consolidado | 10 |
| 6. F01: preservar árvore HTML entre lotes | Corrige export/preview divergentes; alta | M / médio / estratégia de fronteiras e sanitização | Fixtures acima/abaixo de 300 Ki, `map` on/off e gauntlet | Antes do merge | 6,25 |
| 7. F15: indexar offsets | Redução potencial grande em CRLF; alta no microbenchmark | M / médio / testes de offsets e Unicode | 0,5/1/10 MB LF/CRLF, tempos e correspondência exata | Antes do merge | 6,25 |
| 8. F06/F07: cancelar trabalho obsoleto | Pode eliminar espera atrás de uma conversão longa; média | M / médio / política de cold start e propriedade | Última edição até preview correto, Source/aba e CPU | Antes do merge | 4 |
| 9. F03: isolar/serializar jobs Typst | Elimina disputa de arquivo; média-alta para o risco | G / médio / arquivos por job e teste de subprocesso | Dois renders e export concorrentes com barreiras | Antes do merge | 3,33 |
| 10. F09: tornar includes semânticos/canceláveis | Evita leituras indevidas; alta no caso sintético | M / médio / preservar jail e atributos | Contar IPC/I/O com condicionais e includes aninhados | PR seguinte | 3 |
| 11. F12: pintar texto AsciiDoc antes de Mermaid | Reduz possível espera por diagramas; hipótese | M / médio / controle por geração | First paint, diagramas lentos, edição e reancoragem | PR seguinte | 1,5 |
| 12. F14: prototipar redução de duplicação dos workers | Até 967.750 B brutos estão nos workers, economia real desconhecida | G / médio / Vite, CSP e fallback | `dist`, executável, cold start e memória em Windows/Linux | Backlog | 1 |

Antes do merge, corrigir também F08 com ao menos um limite/contrato honesto e teste de bloco único, e F13 com teste de documento vazio. Depois de qualquer correção, repetir os testes com o binário exato e executar os fluxos nativos em Windows e Linux. Reavaliar o veredito após a suíte de segurança/export e as metas acordadas passarem.

## 10. Incidente da auditoria e integridade do ambiente

Na tentativa inicial de rodar o harness Windows, redirecionei `APPDATA`/`LOCALAPPDATA` para um diretório temporário. O Tauri usa a Known Folder do Windows; o próprio harness usa `APPDATA` para escolher o que salvar. Assim, ele protegeu a pasta errada e o aplicativo de teste **gravou no perfil real**. Esse comportamento já estava documentado em `AGENTS.md:1635`; eu deveria ter lido e aplicado o aviso antes de executar. Interrompi a árvore de processos do teste, removi uma imagem de fixture de 68 bytes criada por ele em `samples/assets` e confirmei que os arquivos de código/fixtures rastreados permanecem sem alterações. `AGENTS.md` recebeu apenas o complemento obrigatório sobre a armadilha específica do harness.

Foram gravados pelo menos `settings.json` e `.window-state.json` do perfil real. Não há cópia exata pré-teste identificada; preferências, recentes, abas ou geometria podem ter sido alterados, e não é possível separar com segurança todas as mudanças feitas pelo teste. Preservei uma cópia do **estado após o teste** em `mdraft-audit/post-test-profile` e encontrei uma cópia histórica de **2026-11-02** em `T:\Temp\mdraft-test-01Fitc\user-state`, também copiada para `mdraft-audit/historical-profile-2026-11-02`. A raiz dessas duas cópias é `C:\Users\bernh\.codex\visualizations\2026\11\05\01a1abd3-aa07-72f2-8f11-09b3e932d99e\mdraft-audit`. Não restaurei a cópia antiga, pois ela poderia apagar mudanças legítimas dos três dias seguintes. Uma consulta somente de leitura a cópias de sombra retornou `Initialization failure`, portanto nenhuma restauração por esse método foi comprovada.

As execuções de interface com esse perfil — inclusive falhas de zoom, word sync e AsciiDoc — são **inválidas como comparação controlada** e foram excluídas do veredito. Os resultados de Chrome headless usaram um perfil separado e não iniciaram MDraft. Nenhum código de produto foi alterado nesta auditoria.

## 11. Respostas e decisões do responsável

Respostas registradas em 2026-11-05:

1. Não há um teto rígido para o tamanho instalado: o critério é o benefício de performance em relação ao custo. Um aumento de 10% a 15% do tamanho atual é aceitável; acima disso, o responsável avaliará pessoalmente. Responsividade, input p95/p99 e tempo entre edição e prévia são prioridades.
2. Documentos de cerca de 10 MB com CRLF e dezenas de milhares de parágrafos são alvo obrigatório. F15 passa a ser requisito antes do merge, embora o algoritmo seja anterior à branch.
3. O intervalo de indisponibilidade do word sync pode ultrapassar 600 ms; a sincronização deve voltar a funcionar corretamente quando a prévia estiver pronta e a edição se estabilizar.
4. A versão `0.8.0` deve permanecer nesta branch.
5. O responsável informou que possui backup e que a máquina é dedicada a testes; a gravação acidental de perfil registrada na seção 10 não causou prejuízo real. A restauração da cópia antiga não foi solicitada.

## 12. Acompanhamento da implementação aprovada

Esta seção registra resultados posteriores à auditoria; os achados e o veredito
acima continuam descrevendo o commit auditado, não são reescritos como se fossem
resultados do código corrigido. A execução está no [plano aprovado](../plans/2026-11-05-preview-worker-hardening.md).

**Fatos medidos:** a conversão pura com mapa da fixture de 10.800.000 bytes,
72.000 parágrafos e CRLF teve mediana de 14.929,6 ms antes e 1.118,0 ms após a
indexação, em três execuções quentes, ou 13,35× mais rápida. O backend converte
CRLF para LF ao abrir arquivos; portanto esse ganho isolado não demonstra a mesma
melhora na abertura nativa. A fixture continua sendo CRLF no disco e suas quebras
foram verificadas após o salvamento no Linux.

No Windows/WebView2, a nova sonda usa `keydown`/`char`/`keyup`, timestamps do
CDP, exige entradas efetivas e verifica um bloqueio proposital de 350 ms. Numa
execução de 1,2 MB, 20 teclas durante workers ativos tiveram p95 2,2 ms e máximo
2,3 ms; na rajada de 49 teclas, p95 2,4 ms e máximo 3,8 ms; a prévia correta
atingiu o callback do próximo frame 670,1 ms após a última entrada. A rajada
continha somente uma tecla com worker ativo porque a primeira edição cancela o
worker: os dois conjuntos não devem ser confundidos. Esses números não medem a
tecla que eventualmente chegue durante o layout posterior.

Para comparar versões com o mesmo instrumento, enviamos 20 pares de teclas à
fixture de 1.220.283 bytes, aguardando 220 ms após cada primeira tecla para
provocar trabalho de renderização. Foram três execuções alternadas por versão,
com controle positivo de bloqueio e conferência da prévia final. Na `master`, os
p95 foram 424,6 / 433,1 / 426,2 ms; na branch, 1,9 / 1,7 / 1,8 ms. Em cada
execução, as 20 teclas medidas coincidiram com uma tarefa longa na `master` e
com um worker ativo na branch. Esta é uma comparação de um padrão de entrada e
um documento, não uma distribuição de uso real ou prova de ausência de jank
em todo o ciclo. P50, p99, máximos e idades individuais estão em
[`preview-native-comparison.json`](preview-native-comparison.json); comando:
`npm test -- --only preview-compare --no-build --verbose --keep`.

Na fixture de 10,8 MB, a abertura até o título levou 271 ms, a prévia correta
atingiu o callback do frame após 4.120,6 ms e o p95 da rajada foi 2,4 ms. Um
perfil adicional encontrou uma tarefa de 938 ms na thread principal, cerca de
734 ms em `getBoundingClientRect` ao forçar layout após inserir a prévia; o
[perfil CDP bruto](preview-extreme-10mb.cpuprofile) foi preservado. Uma
experiência apenas no teste com `content-visibility` reduziu o maior bloco a
431 ms, mas introduziu dois blocos longos e não comprovou a preservação de
rolagem; não foi incorporada. **O requisito de evitar congelamento em 10 MB
continua pendente.** Outra experiência temporária, com 72.000 parágrafos simples
reduzidos de dois elementos para um, produziu uma tarefa de 750 ms e prévia em
3.514,6 ms em uma execução; não foi incorporada porque ainda houve uma pausa
longa e falta prova de equivalência de todos os casos. A amostra não estabelece
uma redução generalizável nem substitui medições repetidas.
Na repetição extrema posterior, as cinco verificações passaram, incluindo word
sync nas duas direções após a prévia; as duas verificações levaram 694 ms juntas.
A maior tarefa observada ainda foi 887 ms. A amostra de teclas em worker ativo
não demonstra a latência de uma tecla enviada durante essa tarefa de layout.

Em Debian/WSL com WebKitGTK 2.54, o build de release e os testes app-free
passaram. A janela real mostrou a fixture e sua prévia; após a edição do arquivo
extremo, o segundo salvamento preservou 144.000 pares CRLF em 10.800.014 bytes.
Na primeira tentativa, o atalho foi enviado imediatamente após a rajada: apenas
o primeiro caractere estava no disco enquanto o restante chegou ao editor e a
aba permanecia marcada como alterada. A repetição controlada com duas execuções
de cada versão teve o mesmo sinal de documento alterado: na `master`, nenhum
caractere havia sido gravado até 30 s após o primeiro atalho; na branch, somente
o primeiro caractere havia sido gravado quando observado. Um segundo atalho,
após a entrada estabilizar, gravou o texto completo nos quatro casos, com os
144.000 CRLF preservados. O ensaio usa `xdotool`, WebKitGTK em WSL e um perfil
descartável; não demonstra perda silenciosa e não isola uma regressão da branch.
Dados e procedimento: [`linux-save-order-results.json`](linux-save-order-results.json)
e [`linux-save-order-probe.py`](linux-save-order-probe.py). Uma amostra pontual registrou cerca de
1,32 GiB de RSS no WebKitWebProcess (1.379.604 KiB) e 221 MiB no processo principal; não é pico
nem medição de uma sessão longa. O harness CDP existente não mede p95 em
WebKitGTK.

| Artefato, mesma toolchain por plataforma | `master` 0.7.8 | Branch 0.8.0 | Variação |
| --- | ---: | ---: | ---: |
| Executável release | 18.873.856 B | 19.151.872 B | +1,47% |
| MSI sem assinatura | 11.927.552 B | 12.201.984 B | +2,30% |
| NSIS sem assinatura | 10.437.051 B | 10.705.630 B | +2,57% |
| Executável Linux x64 | 23.886.208 B | 24.174.064 B | +1,21% |

As medições foram feitas em Intel Core Ultra 7 265KF, Windows 10.0.26200, Node
24.22.0 e Rust 1.99.1; os instaladores foram gerados em diretórios temporários,
com `tauri bundle --no-sign --no-binary-patching`, sem instalar o aplicativo.
Uma extração administrativa dos dois MSIs mostrou um único arquivo em
`PFiles/MDraft`, o executável da tabela: o payload instalado extraído também
cresceu 1,47%. Metadados de instalação, alocação em disco e o WebView2
compartilhado não foram medidos. O Linux foi compilado no Debian/WSL com a mesma
toolchain e `tauri build --no-bundle`; não foi medido um pacote Linux instalado.
Não há aumento acima do limiar de 15% nos artefatos medidos.

Passaram os testes isolados de offsets (51/51), fila (18/18), DOM/segurança
(12/12), Rust no Windows (306 aprovados, dois downloads ignorados), Typst
(55/55, incluindo o exame opcional), Read Aloud (58/58), word sync (59/59) e
exportação real (42/42). Em Typst Pages, o teste reproduziu a restauração de
3.535 px sendo sobrescrita para zero por um callback de ajuste; após invalidar
esse ajuste obsoleto, a reprodução isolada passou (12/12), preservando 3.535 px.
A suíte completa posterior gerou 54 registros de camada sem falhas, incluindo
62/62 para rolagem, 59/59 para word sync, 55/55 para Typst e 12/12 para a
medição nativa de performance. Essa execução antecedeu a correção independente
dos caminhos de imagem; imagem, colagem, DOM e exportação foram repetidos após
ela. O teste Rust de scratch concorrente também foi repetido após ajustar sua
limpeza para não deixar uma pasta vazia. O [resumo das camadas](windows-full-suite-2026-11-05.json) e os backups
temporários foram conferidos antes da limpeza; o estado final do aceite deve
ser lido no plano.
No teste DOM em Chromium headless no Windows, um bloco HTML bruto indivisível
de mais de 1 MiB levou 73,5 ms no caminho síncrono e 76,0 ms no caminho com
worker, em uma amostra cada; são tempos totais do teste, não uma medição da
maior tarefa no WebView2 nem uma comparação antes/depois.

**Achado adicional fora do diff:** a execução do teste de imagens em um diretório
temporário contendo `\.codex` expôs um defeito anterior à branch. O caminho
Markdown absoluto `C:\Users\bernh\.codex\pictures\test.png` é interpretado
pelo `marked` como `C:%5CUsers%5Cbernh.codex%5Cpictures%5Ctest.png`: `\.`
consome o separador. `src/image-syntax.ts:34` insere o caminho sem escapar e a
`master` usa o mesmo parser. O módulo de sintaxe não difere da `master`, ambos os
lockfiles fixam `marked` 18.1.2 e a reprodução direta do parser nesse checkout
da `master` gerou o mesmo `src`; esta última é uma prova isolada do parser, não
um segundo teste completo de interface. Na versão auditada, o arquivo é salvo,
mas sua prévia não carrega. Isso não é regressão do worker.

A pedido posterior do responsável, `src/image-syntax.ts` passou a escapar barras
literais nas **novas** referências Markdown geradas pela importação de imagens.
A reprodução com uma pasta oculta falhou antes e passou depois no aplicativo;
o teste permanente de regras de imagens passou em 29/29. Uma versão temporária
do teste também verificou caminhos absolutos, relativos, UNC e pontuação no parser
(34/34 após a correção); não houve acesso de rede a um UNC. Colagem, sanitização e
exportação relacionadas passaram em seis camadas. Uma verificação isolada no
Linux passou em 5/5 conversões de caminhos Windows, UNC, POSIX com barra literal
e URL. Após aprovação do plano específico, a colagem rica passou a compartilhar
o escape de barras; seus testes de conversão foram ampliados. Documentos já
existentes continuam com interpretação potencialmente ambígua; o [plano
específico](../plans/2026-11-05-legacy-markdown-image-paths.md) está em andamento
e não autoriza reescrita automática de arquivos. A implementação posterior cobre
um subconjunto conservador de referências antigas; ver atualização abaixo.

### Atualização dos planos aprovados em 2026-11-06

O caminho live agrupa parágrafos independentes somente depois da sanitização,
mantendo os nós e as âncoras no DOM; blocos complexos, HTML bruto e exportação
continuam no caminho anterior. Os mapas de palavras e de scroll são produzidos
em lotes canceláveis e publicados somente quando completos. A decisão e seus
limites estão no [ADR](../adr/2026-11-06-large-markdown-preview-layout.md).

Na fixture de 10.800.000 bytes CRLF, três medições no WebView2 com o binário
`056d059cdddc` amostraram entrada durante a montagem e o layout: p95 de
43,6 / 33,7 / 43,6 ms e máximos de 90,8 / 79,2 / 86,7 ms. A prévia final
correspondeu à edição e o word sync nas duas direções voltou em 1,44–2,30 s.
A comparação anterior sem agrupamento teve p95 de 704,2 / 726,3 / 727,0 ms e
máximos de 952,8 / 943,3 / 942,3 ms. A rolagem direta ao fim ainda gerou tarefas
de 100–112 ms; isso não é uma medição de input-to-render durante rolagem.

Após o ajuste final de isolamento dos estilos, três novas execuções do binário
`53a7a69d27fc` tiveram p95 de layout 39,1 / 37,8 / 36,8 ms, p99 de
69,5 / 63,5 / 60,7 ms e máximos de 71,4 / 69,6 / 72,1 ms. A amostragem após
o primeiro paint incluiu teclas durante a construção do mapa: p95 de
7,4 / 8,4 / 5,9 ms e máximos de 14,8 / 22,5 / 10,4 ms. Foram 113–115 teclas
na fase de layout e 126–128 na fase posterior, com três eventos sobrepostos à
associação do mapa em cada execução. A prévia correta chegou 3,56–3,64 s após
a última entrada; isso não é tempo de abertura a frio. Os logs completos estão
em [windows-layout-final-results.json](windows-layout-final-results.json).

No Debian/WSL2 com WebKitGTK, antes da divisão final dos mapas, três amostras
nativas da implementação agrupada tiveram máximos de 355 / 363 / 356 ms contra
1.899 / 2.019 / 1.937 ms sem agrupamento. Cada amostra teve 160 teclas, prévia
final e controle positivo; a sonda calibra o offset entre relógios de eventos e
`performance.now()`. O responsável considerou os máximos Linux aceitáveis.
Dados brutos e procedimento: [resultados](linux-layout-native-results.json) e
[sonda](linux-layout-native-probe.py). A sonda não usa teclado físico.

Na implementação final, as três novas amostras Linux tiveram p95 de
221 / 187 / 241 ms, p99 de 327 / 333 / 352 ms e máximos de 356 / 369 / 374 ms,
com 160 teclas por execução, 1.125 grupos e controles positivos. A amostragem a
cada 500 ms observou pico de RSS somado da árvore de processos identificada de
1.514.580 / 1.535.576 / 1.633.500 KiB; não é pico global do sistema nem inclui
necessariamente processos reparentados. A suíte Rust Linux passou com 314 testes
e quatro ignorados, e os testes app-free de DOM, prévia, worker e colagem passaram
em 23/23, 66/66, 18/18 e 397/397, respectivamente. A sonda nativa não substitui
validação manual de leitor de tela ou de todas as interações no WebKitGTK.

Para imagens antigas, o fallback tenta somente um candidato local reconhecido,
mantém a prioridade do destino Markdown existente e recusa caminhos UNC,
unidades mapeadas e componentes reparse; não altera o texto. O novo comando,
as limitações e a janela de corrida entre checagem e abertura estão no
[ADR de imagens](../adr/2026-11-06-legacy-local-image-resolution.md).
O microbenchmark [de 10.000 imagens](legacy-images-benchmark.mjs) mede apenas
o renderer, sem filesystem ou UI: 57,2–73,1 ms para caminhos comuns e
66,5–70,1 ms para candidatos legados, em três amostras quentes. Na interface
Windows, 100 referências repetidas foram carregadas com uma chamada ao
resolvedor, em 264 ms na amostra após forçar o carregamento das imagens que
normalmente ficam adiadas fora da tela.

O executável Windows final mede 19.189.760 bytes, +1,67% sobre a `master`
medida anteriormente; o executável Linux final sem instrumentação mede
24.206.192 bytes, +1,34% sobre a `master` medida com a mesma toolchain.
O `npm run dist` final gerou MSI de 12.505.088 bytes (+4,84% sobre os
11.927.552 bytes da `master`) e NSIS de 10.718.146 bytes (+2,69% sobre
10.437.051 bytes). O portátil final tem 19.189.760 bytes; não foi medido um
portátil da base equivalente. Os artefatos locais anteriores foram preservados
e restaurados após a cópia dos novos para verificação isolada.
Uma extração administrativa do MSI final contém `mdraft.exe` e
`mdraft_lib.dll` de 465.408 bytes. O MSI 0.8.0 local anterior também continha
essa DLL; `dumpbin /dependents` não a lista como dependência direta do
executável e `dumpbin /exports` não encontrou exports. Isso não prova que seja
seguro removê-la em todas as plataformas ou builds; investigar o empacotamento
em mudança própria antes de tentar reduzi-lo. A extração administrativa não é
uma instalação MSI em perfil limpo.

Oportunidade de backlog: verificar se o MSI Windows pode excluir a DLL sem
quebrar integrações. Ganho máximo mensurável no payload extraído: 465.408 bytes
(aproximadamente 2,4% do executável); redução comprimida do MSI a medir. Esforço
P/M, risco médio por depender do contrato do bundler, sem nova dependência.
Validar com builds limpos antes/depois, inspeção do MSI e instalação/uso nas
plataformas suportadas; não remover a biblioteca apenas pelo resultado de
`dumpbin`.

O build Linux de distribuição gerou DEB de 13.622.848 bytes e AppImage de
119.196.152 bytes. O controle do DEB declara `Package: mdraft`, versão `0.8.0`,
`Replaces: m-draft`, e o launcher extraído usa `Name=MDraft`. O binário
extraído do DEB e o AppImage abriram, editaram e salvaram um arquivo em perfis
temporários separados ([sonda](linux-package-smoke.py)). A instalação Debian
existente 0.4.6 foi preservada; portanto, a instalação real via `apt` não foi
executada. No Windows, uma tentativa de instalar o MSI sem privilégios e com
`INSTALLDIR` temporário falhou com erro 1321 porque `AppSearch` recuperou o
diretório da instalação existente; ela continua registrada, com executável de
mesmo tamanho e data. NSIS e MSI foram extraídos em isolamento; isso não é um
teste de instalação em máquina Windows limpa.

Os executáveis extraídos do MSI e do NSIS e o portátil passaram cada um em
114/114 verificações de smoke, usando o harness com backup e restauração do
perfil. O executável normal gerado pelo build de distribuição também passou
em smoke 114/114, prévia extrema 18/18, word sync 59/59 e imagens 43/43. O
build e as validações do site para 0.8.0 passaram. Não há, neste resultado,
evidência de instalação MSI/NSIS em uma máquina Windows limpa.

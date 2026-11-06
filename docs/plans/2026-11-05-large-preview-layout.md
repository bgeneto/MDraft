# Limitar o trabalho de layout da prévia Markdown grande

**Status:** done (approved 2026-11-05; completed 2026-11-06)

**Date:** 2026-11-05

**ADR:** [grupos de layout na prévia Markdown](../adr/2026-11-06-large-markdown-preview-layout.md).

## Context and goal

O plano [preview-worker-hardening](2026-11-05-preview-worker-hardening.md) aprovou a correção dos workers e dos offsets, mas excluiu renderização incremental ou virtualizada completa. A fixture obrigatória de 10.800.000 bytes, 72.000 parágrafos e CRLF ainda produz uma tarefa principal de 905 ms sem profiler; com profiler, foram 938 ms, sendo cerca de 734 ms em layout forçado por `getBoundingClientRect` após a substituição da prévia. Uma tentativa de `content-visibility` em cada elemento ainda produziu uma tarefa de 431 ms; reduzir 72.000 parágrafos simples de dois elementos para um produziu 750 ms em uma execução. Nenhuma das experiências comprovou todas as interações e nenhuma foi incorporada.

O objetivo é manter digitação e interação responsivas durante a reconstrução da prévia Markdown grande, inclusive após a troca do DOM, preservando conteúdo, segurança, navegação e sincronização. O ganho de 13,35× na conversão pura CRLF não representa a abertura nativa: o backend normaliza CRLF para LF.

## Scope and non-scope

Inclui uma estratégia escalonável para blocos Markdown independentes, adaptando o acabamento da prévia, layout, âncoras e construção do mapa quando necessário. Inclui medição nativa Windows/WebView2 e Linux/WebKitGTK, regressões de seleção, acessibilidade e exportação, documentação e ADR. O primeiro alvo é a fixture obrigatória e os fluxos diretamente associados de edição, aba, scroll, word sync e busca.

Não altera o dialeto, a política de sanitização, os formatos em disco, a versão 0.8.0 ou a configuração persistida; não adiciona dependências por padrão. Typst, AsciiDoc e HTML guest não são reescritos. Um HTML bruto que atravesse blocos ou um bloco individual indivisível continua sendo tratado de forma segura como uma unidade; seus custos e limitações serão medidos separadamente, sem supor que o orçamento da fixture de parágrafos se aplique a eles.

## Approach and rejected alternatives

Primeiro, construir um protótipo mensurável, fora do caminho de produção, que agrupe blocos top-level completos em unidades limitadas e aplique contenção/layout adiado por grupo. Manter os nós no DOM para preservar seleção, copiar e busca nativa; não dividir uma lista, tabela, bloco de código ou árvore de HTML entre grupos. O agrupamento só ocorre após a sanitização e a anotação equivalentes às atuais. Comparar tamanhos de grupo, estimativas de altura e comportamento nos dois webviews antes de fixar limiares.

Se o protótipo cumprir os critérios de desempenho **e** correção, implementar a estratégia apenas na prévia ao vivo de Markdown elegível. Manter os blocos no DOM; adaptar os seletores e CSS que hoje dependem de filhos diretos, preservar ou reconciliar a âncora visível quando estimativas forem substituídas por alturas reais, e evitar consultas geométricas que forcem layout de todos os grupos. Construir índices/word map em lotes canceláveis por geração, preservando seleção e Escape; usar busca binária para âncoras ordenadas quando medições mostrarem que são relevantes. O caminho síncrono de exportação conserva a árvore e saída existentes. Não aplicar contenção quando a árvore não puder ser particionada com segurança.

Se a contenção agrupada não atingir o aceite, registrar o resultado e parar antes de substituir/remover nós fora da viewport: uma janela virtual com placeholders, hidratação, busca e seleção entre blocos exige outra decisão explícita. Isso mantém a alternativa arriscada revisável. Rollback da implementação por reversão independente; não criar opção de preferência permanente apenas para contornar uma regressão ainda não compreendida.

Alternativas rejeitadas para adoção direta: aumentar debounce (não reduz layout); atribuir `content-visibility` a cada parágrafo (431 ms observados e rolagem não verificada); compactar somente spans simples (750 ms observados e árvore alterada); desligar DOMPurify ou separar HTML bruto em lotes arbitrários (segurança/fidelidade); deixar uma prévia parcial sem indicação (conteúdo e acessibilidade imprevisíveis).

## Steps

- [x] Reproduzir o bloqueio atual, salvar dados brutos e medir entrada durante swap, layout, primeiro paint e construção tardia do mapa, com controle positivo.
- [x] Prototipar grupos de tamanhos alternativos e testar WebView2/WebKitGTK; registrar entrada, tarefas, prévia correta e memória disponível. **Limite:** o RSS da árvore de processos foi amostrado para a configuração final no Linux, sem comparação equivalente por tamanho de grupo ou pico global.
- [x] Verificar no protótipo a rolagem até o meio, seleção, busca, espaçamento de parágrafos e o orçamento Windows antes de editar produto; completar zoom e verificação pontual da árvore de acessibilidade no produto. O teste não substitui uma navegação manual com leitor de tela.
- [x] Implementar grupos seguros e canceláveis no caminho live; manter sanitização e exportação equivalentes, e atualizar os consumidores de blocos/âncoras.
- [x] Tornar canceláveis os percursos e mapas que ainda gerem tarefas excessivas; preservar o tratamento da seleção corrente e de Escape.
- [x] Adicionar regressões de correção, segurança, acessibilidade e ciclo de vida; atualizar ADR e documentação.
- [x] Repetir benchmarks e tamanho antes/depois, `npm test`, exportações e verificações nativas nas duas plataformas; registrar os limites de medição, memória, rolagem e leitor de tela.

## Files and modules

- `src/markdown.ts`, `src/preview-render.ts`, `src/main.ts`, `src/source-map.ts` e CSS da prévia: agrupamento, mapeamento, geometria e estilo, apenas onde as medições indicarem necessidade.
- `scripts/preview-performance-test.mjs`, `scripts/preview-dom-test.mjs`, `scripts/word-sync-test.mjs`, `scripts/scroll-sync-test.mjs`, testes de zoom e exportação: medições e regressões observáveis; scripts exploratórios em `docs/audits/`.
- `AGENTS.md`, este plano, a auditoria e eventual ADR: comandos, resultados, decisões e rollback.

## Risks and rollback

Alturas estimadas podem deslocar a posição visível; contenção pode mudar colapso de margens, links, seleção, impressão, acessibilidade ou descoberta por busca. Medir cada contrato antes da adoção. Se houver divergência de árvore/segurança, restaurar o caminho atual; não relaxar a sanitização. Se o navegador não suportar a técnica ou ela não cumprir a meta, registrar a limitação e não anunciar o requisito como atendido. Reverter a alteração por um conjunto isolado de commits; não migrar dados do usuário.

## Tests and validation

Usar a mesma fixture de 10,8 MB/72.000 parágrafos CRLF no disco, mais LF, linhas longas, estrutura aninhada e HTML bruto inseparável. Fazer ao menos três amostras quentes antes/depois por plataforma no mesmo hardware; distinguir input enviado e recebido durante worker, montagem, swap, layout, primeiro paint e mapa. Verificar amostra não vazia, timestamps e controle positivo; não considerar apenas uma rajada que cancela o worker. Registrar p50/p95/p99/máximo, maiores tarefas, tempo até o conteúdo correto e memória; repetir Source/Split, troca de abas, rolagem e sessão prolongada. O harness CDP atual não oferece p95 em WebKitGTK; desenvolver uma sonda nativa verificável ou registrar a medição como indisponível, sem convertê-la em aprovação.

Comparar DOM/HTML exportado e sanitização, IDs/links, seleção e cópia atravessando grupos, busca, leitor de tela, zoom, rolagem nas duas direções, word sync após estabilizar, Escape, imagens, Mermaid, tabelas e código. Executar as suítes pertinentes e `npm test`, e comparar binários equivalentes, incluindo o limiar de 15% acordado.

## Acceptance criteria

- Na máquina Windows de referência, a fixture de 10 MB/72.000 parágrafos apresenta p95 de entrada até 100 ms e máximo até 150 ms em amostras que cubram montagem, swap e layout, em cada uma de três execuções quentes; a sonda também detecta um bloqueio injetado. Estes limites são uma proposta para revisão, não uma medição já alcançada.
- A prévia final corresponde à última edição; abrir, alternar abas, rolar, selecionar e copiar não omite conteúdo nem desloca indevidamente a âncora. Word sync pode demorar mais de 600 ms, mas deve recuperar e respeitar Escape.
- HTML seguro, exportação, busca e navegação mantêm os contratos existentes; o perfil extremo não introduz requisições ou dependências novas e o crescimento de binário é documentado.
- Os testes e as medições reais Windows/Linux passam ou têm limitações explícitas; resultados não executados não contam como aprovados.

## Open questions

- Os limites propostos de p95 até 100 ms e máximo até 150 ms para o arquivo extremo são adequados no host de referência? Na falta de alteração durante a revisão, usá-los como meta deste plano.
- Se a contenção agrupada for insuficiente, aprovar em plano posterior uma viewport virtual com seu contrato de busca, seleção e acessibilidade.

## Execution notes

- Aprovação recebida em 2026-11-05. A sonda agora envia teclas também após a última edição, durante montagem/layout, com injeção limitada; os resultados do controle sem agrupamento foram p95 de 704,2 / 726,3 / 727,0 ms e máximos de 952,8 / 943,3 / 942,3 ms.
- Um protótipo de teste agrupa 64 parágrafos simples antes da montagem. Em três execuções no WebView2 teve p95 de 30,3 / 27,3 / 30,8 ms e máximos de 73,4 / 77,0 / 74,9 ms. Word sync nas duas direções, rolagem até o meio, seleção entre grupos e busca circular passaram em verificações iniciais. Não é código de produto: usa um shim para contagem de filhos e uma fixture restrita a parágrafos. Os dados estão em `../audits/preview-group-results.json`.
- Uma sonda isolada WebKitGTK 2.54 confirmou suporte a `content-visibility`, rolagem e busca em 72.000 parágrafos, com 135 / 119 / 122 ms para append/layout. Não executa o aplicativo nem mede p95. Falta validar geometria, estilos, acessibilidade, alternância de abas e o fluxo completo nativo Linux antes do gate para produção.
- No aplicativo Linux real, com X11/WSL2 e perfil isolado, três execuções da implementação agrupada anterior aos mapas canceláveis tiveram p95 de 90 / 104 / 142 ms e máximos de 355 / 363 / 356 ms, contra máximos de 1.899 / 2.019 / 1.937 ms sem agrupamento; cada execução capturou 160 teclas, a prévia correta e o bloqueio positivo. Os timestamps do WebKit têm offset calibrado por execução e não representam teclado físico. O responsável declarou aceitáveis máximos de 355–363 ms. Dados brutos: `../audits/linux-layout-native-results.json`.
- A implementação real sanitiza antes de criar grupos e só agrupa quando todos os chunks são parágrafos e há âncoras compatíveis; HTML bruto e estruturas complexas mantêm o caminho anterior. No WebView2, a fixture preservou seleção entre grupos, busca, espaçamento, zoom de 50/150/300%, acesso ao parágrafo visível e word sync nas duas direções. Uma rolagem extrema ainda produziu tarefas de cerca de 100 ms; presença pontual na árvore de acessibilidade não substitui teste com leitor de tela.
- Com o binário Windows final (`53a7a69d27fc`), três medições cobriram montagem e layout: p95 39,1 / 37,8 / 36,8 ms, p99 69,5 / 63,5 / 60,7 ms e máximos 71,4 / 69,6 / 72,1 ms. Após o primeiro paint, as teclas sobrepuseram a construção do mapa: p95 7,4 / 8,4 / 5,9 ms e máximos 14,8 / 22,5 / 10,4 ms. A prévia correta chegou 3,56–3,64 s após a última entrada. Dados: `../audits/windows-layout-final-results.json`.
- O binário Linux final, acrescido apenas de instrumentação de teste, teve três máximos de 356 / 369 / 374 ms (p95 221 / 187 / 241 ms), com prévia correta e controle positivo; a variação é da mesma ordem das amostras de 355–363 ms consideradas aceitáveis pelo responsável. O pico de RSS amostrado da árvore identificada foi 1,44–1,56 GiB; não inclui necessariamente processos reparentados. Os testes Rust passaram em 314/314 com quatro ignorados; DOM 23/23, prévia 66/66, worker 18/18 e colagem 397/397. O build Linux sem instrumentação mede 24.206.192 bytes, +1,34% sobre a `master` medida no mesmo ambiente.

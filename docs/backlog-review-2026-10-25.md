# Revisão de implementação e qualidade do backlog — 0.5.0

**Data:** 2026-10-25
**Base:** `d6d5efb95d8f1c95325aaf5ca6c6d01fbae5049a`, versão 0.5.0.
**Escopo:** confrontar os 33 GAPs com código, planos, ADRs, testes e CI;
reproduzir falhas relevantes. Esta revisão não implementa correções nem altera
automaticamente os estados do backlog.

## Parecer

A implementação avançou substancialmente. Os novos controladores, os hashes de
revisão, o handoff, a transformação de referências de exportação e o zoom têm
código real e testes úteis. Não são apenas controles ou planos sem execução.

Entretanto, **não considero o GAP-009 concluído com qualidade suficiente**:
reproduzi uma perda de arquivo no caminho de erro da exportação PDF, execução
de scripts em subframes da superfície declarada sem scripts e interferência
entre duas exportações simultâneas. O GAP-032 também tem um defeito reproduzido
na persistência do aviso de conflito.

O backlog é estruturalmente consistente: **33 IDs únicos, 33 linhas de triagem,
metadados iguais entre tabela e seções**, sem duplicação de IDs. Os estados
atuais são 22 `open`, 5 `in progress`, 5 `done` e 1 `parked`. A inconsistência
principal é semântica: há evidências antigas escritas no presente, uma conclusão
excessiva para impressão e documentação de validação ainda incompleta.

## Achados, por prioridade

### R-01 — P0: falha da exportação PDF apaga um destino preexistente

**Responsabilidade:** GAP-009.
**Código:** `src-tauri/src/print.rs:277–281,310–334`.

`print_pdf` manda o gravador escrever diretamente no caminho escolhido. Se o
gravador retorna erro, chama `discard_partial(target)`, que remove qualquer
arquivo regular nesse caminho. Não verifica se o arquivo já existia nem se o
gravador chegou a escrever nele. A mesma remoção ocorre se a validação posterior
falha. Confirmar uma substituição no seletor não autoriza perder o arquivo antigo
quando a nova gravação falha.

**Reprodução:** um probe compilado usou os corpos reais de `print_pdf`,
`verify_pdf` e `discard_partial`, substituindo somente preparação/driver por
fronteiras controladas. Criou um PDF anterior e fez o driver falhar antes de
escrever. Resultado: `writer_failed=true original_target_exists=false`.
É uma prova do caminho de erro com driver simulado, não uma alegação de ter
provocado uma falha real de impressora.

**Correção necessária:** escrever em um destino temporário exclusivo, validar o
novo PDF e só então substituir o destino. Em qualquer falha, remover apenas o
temporário pertencente à operação. Testar destino anterior, erro antes/durante a
gravação, saída inválida e sucesso.

**Backlog:** reavaliar GAP-009 como `recheck`; a afirmação “No known P0 remains
open” em `docs/backlog.md:1543` já não representa esta revisão. Preservar o
histórico do plano concluído e registrar o plano corretivo explicitamente.

### R-02 — P1: a superfície nativa executa scripts de documentos filhos

**Responsabilidade:** GAP-009; fronteira documentada no ADR de impressão.
**Código:** `src/html-preview.ts:415–438`; `src-tauri/src/print.rs:218–238`.

`buildHtmlNativePrintDocument` procura scripts/handlers/refresh com regex no
texto principal. Um iframe com `src="data:text/html;base64,..."` não contém a
string de script visível ao filtro. Ele é aceito como HTML estático. A janela
nativa permite JavaScript e não impõe uma restrição equivalente a esse conteúdo
filho. A ausência de capability limita IPC; não impede a execução de JavaScript.

**Reprodução real:** preparei o documento com a função real extraída do módulo,
contendo um iframe cujo script substitui seu próprio corpo por
`CHILD_SCRIPT_RAN`. O preparador retornou `needsBrowser=false`. A API nativa
gerou um PDF, e `pdftotext` encontrou esse texto criado pelo script. O marcador
do documento pai também estava presente. Nenhuma rede externa foi usada.

**Limite da conclusão:** isto demonstra quebra da promessa de superfície sem
scripts de documento. Não demonstra acesso privilegiado a comandos Tauri; a
separação de capabilities continua existindo.

**Correção necessária:** definir e aplicar a política para subframes, objetos e
outros contextos ativos, com validação estrutural e restrições da superfície;
encaminhar conteúdo incompatível ao navegador. Testar scripts em filhos,
inclusive URLs codificadas e arquivos locais, não só `<script>` no documento pai.

### R-03 — P1: exportações simultâneas destroem a superfície uma da outra

**Responsabilidade:** GAP-009.
**Código:** `src-tauri/src/print.rs:218–238,310–318`; entradas de impressão em
`src/main.ts:2490,2549`.

Todas as operações usam o label `print`. `create_window` destrói a janela
anterior e tenta criar imediatamente outra com o mesmo label. Não há fila
global de impressão nem bloqueio que preserve uma operação em preparação.

**Reprodução real:** a primeira exportação ficou esperando uma imagem servida
por um servidor local controlado. Iniciei uma segunda exportação com outro
documento e outro destino. As duas falharam:

```text
first: The print surface did not answer the readiness check.
second: Could not create the print surface: a webview with label `print` already exists
```

Os alvos eram descartáveis. Não observei mistura de conteúdo nesta execução;
o resultado comprovado foi a interrupção de ambas as operações.

**Correção necessária:** serializar as operações, ou atribuir e manter uma
superfície exclusiva a cada uma. O ciclo de destruição deve terminar antes da
reutilização do label. Cobrir Print/PDF simultâneos e erro/cancelamento.

### R-04 — P1: poll remove o aviso de conflito encontrado pelo hash

**Responsabilidade:** GAP-032.
**Código:** `src/document-lifecycle.ts:176–179,242–244`.

O save checado pode detectar bytes diferentes com mesmo tamanho/mtime e marcar
`modified`. O poll continua baseado apenas em stat: considera esses metadados
inalterados e chama `deps.conflict(s, null)`. Assim, o aviso e suas ações
desaparecem no próximo intervalo, sem resolução do conflito.

**Reprodução com o controlador real:** save retorna `written:false` e
`change:modified`; stat devolve o tamanho/mtime anteriores. Resultado:
`afterSave="modified"`, `afterNextPoll=null`, `dirty=true`.

**Limite:** o próximo save ainda é protegido pelo hash. Não reproduzi perda de
dados neste caso; a falha é a retirada indevida da decisão apresentada ao usuário.

**Correção necessária:** manter o conflito detectado por conteúdo até uma
resolução explícita ou uma validação suficiente da revisão. Acrescentar ao teste
do mesmo tamanho/mtime um poll posterior e verificar a permanência das ações.

### R-05 — P1: o harness não isola testes de uma instalação já aberta

**Responsabilidade:** GAP-027, integração com GAP-017.
**Código:** `scripts/test-all.mjs:682–724,946–980,1343–1353`.

O preflight protege o executável em `target/release`, mas deixa uma instalação
em outro caminho continuar aberta. Desde o plugin de instância única, uma cópia
de teste com o mesmo identifier não abre outro processo: encaminha seus arquivos
à instalação existente e sai com código 0. Pasta privada de WebView2 não cria um
namespace separado para esse mecanismo. O harness também administra settings e
recovery do identifier normal, portanto essa coexistência não é um isolamento
seguro do estado do usuário.

**Observado:** uma instalação em `C:\Program Files\MDraft\mdraft.exe` estava
aberta. As sete camadas UI da primeira rodada não chegaram aos seus checks e
retornaram `the application exited with code 0 before opening port ...`.
Essas falhas não são sete regressões funcionais do aplicativo. As tentativas
podem ter encaminhado amostras à janela existente; não inspecionei essa janela.

As rodadas seguintes usaram um build temporário com identifier
`io.github.bernh.mdraft.backlogaudit`, configurações separadas e um harness
temporário coerente com esse identifier. Não fechei a instalação existente.
O executável release original foi restaurado e seu hash conferido.

**Correção necessária:** antes de qualquer backup/reset/launch, recusar a
coexistência com qualquer instância do mesmo identifier, ou oferecer namespace
de teste realmente separado. Testar a instalação em Program Files, não apenas
uma cópia em `target/release`.

### R-06 — P2: referências `//host/...` viram URLs de arquivo na saída

**Responsabilidade:** GAP-026.
**Código:** `src/export-paths.ts:195–199`.

`publicationUrl` preserva referências relativas ao protocolo. A página exportada
e a superfície de impressão são `file:`. Consequentemente, um endereço de CDN
não vira HTTP(S), mas uma referência de arquivo/host:

```text
input/output: //cdn.example.org/picture.png
resolved against print.html: file://cdn.example.org/picture.png
```

O comportamento foi reproduzido com `publicationUrl` real e o resolvedor URL.
Não foi feita uma requisição à CDN. Os testes atuais confirmam a preservação da
string, mas não o destino final no contexto `file:`.

**Correção necessária:** definir o esquema de publicação de referências remotas
sem esquema e testar a URL efetivamente resolvida em HTML/Print, mantendo UNC
como caso de filesystem separado.

## Inconsistências documentais e de conclusão

- **GAP-009:** `done` é excessivo diante de R-01/R-02/R-03. O caminho feliz é
  funcional e visualmente mensurado, mas segurança de falha e concorrência não
  estão completas. Também não reutilizar sua prioridade histórica P2 para
  priorizar a correção P0 recém-reproduzida.
- **GAP-019:** a seção Delivered descreve o zoom real, mas Evidence ainda diz
  que zoom altera apenas `editorFontSize`, não funciona na prévia e é desabilitado
  no menu (`backlog.md:982–993`). Isso é evidência histórica sem rotulagem, não
  comportamento atual. Os 24 checks de zoom passaram com Typst disponível.
- **GAP-027:** o primeiro slice de CI é registrado como entregue e existe em
  `.github/workflows/quality.yml:48–72`, mas Evidence ainda afirma que nenhum
  workflow executa os testes JS de segurança/sessões (`backlog.md:1313–1315`).
  `open` continua correto para crash/relaunch e cobertura restante; corrigir o
  texto e não planejar outra implementação do slice de CI já existente.
- **GAP-017:** falta `docs/adr/2026-10-25-single-instance-boundary.md`, ainda
  anunciado como “to be written” no plano, apesar da dependência e da fronteira
  de inicialização já implementadas. Encerrar a entrega da Fase 1 exige esse
  registro e as verificações restantes. Associações de arquivo são outra fase,
  não prova de que o handoff esteja ausente.
- **GAP-032:** código e testes de hash estão presentes. A pendência de execução
  do job no GitHub é real para o commit auditado: a branch local está sete
  commits à frente de `origin/master`; a consulta Actions não encontrou runs
  de `d6d5efb`. Os runs recentes bem-sucedidos pertencem a `23ae7c9`, anterior a
  esse slice. Configuração entregue não significa execução remota confirmada.
- **GAP-012:** já reconhece uma entrega parcial, mas algumas evidências misturam
  o antigo browser-only com a impressão nativa já adicionada. Atualizar as
  frases de capacidade e os comentários antigos; o comentário de
  `exportPdfBrowser`, por exemplo, ainda generaliza “WebView2 provides no print
  interface”.
- **Sequenciamento:** Suggested order ainda apresenta impressão nativa como
  trabalho futuro enquanto a linha GAP-009 está `done`. Deve passar a distinguir
  correção da implementação existente, validação pendente e expansão futura.

## Matriz de todos os GAPs

“Correto” abaixo significa compatibilidade de estado/escopo com a inspeção,
não uma certificação exaustiva de todos os cenários de interface/plataforma.

| GAP | Estado registrado | Resultado da revisão |
| --- | --- | --- |
| 001 | done | Correto no escopo original de recovery; scheduler/store presentes e cobertos. Crash/relaunch totalmente automatizado segue em 027. |
| 002 | done | Correto como entrega inicial stat-based; não confundir com a extensão 032. |
| 003 | done | Helpers e dispatch Typst presentes; limites de comandos não suportados explícitos. Sem nova falha reproduzida nesta revisão. |
| 004 | open | Correto: fechamento seguro entregue; Save All independente ainda ausente. |
| 005 | open | Correto: recusa binária/UTF-8 e proteção legada presentes; classificação compartilhada e política de tamanho continuam faltando. |
| 006 | open | Correto: não há árvore de pasta/workspace implementada. |
| 007 | open | Correto: Find do editor não é pesquisa entre arquivos. |
| 008 | open | Correto: não há seletor fuzzy de arquivos/tabs; Ctrl+P é Print. |
| 009 | done | Reavaliar como recheck: caminho feliz implementado, mas R-01 P0 e R-02/R-03 P1 impedem conclusão segura. |
| 010 | open | Correto: inserir tabela não implementa navegação/edição estrutural de células/linhas. |
| 011 | open | Correto: busca no editor não entrega busca nos três previews. |
| 012 | in progress | Correto como parcial; ainda há textos falsos/históricos sem indicação. |
| 013 | open | Correto: comando de inserção YAML não é interpretação de front matter no renderer. |
| 014 | open | Correto: o dialeto acadêmico completo não está instalado pela presença de GFM/KaTeX. |
| 015 | open | Correto: centering de typewriter ainda condiciona `selectionSet && !docChanged` em `editor.ts:685`. |
| 016 | open | Correto: source mapping e PDF.js não equivalem a task toggles, toolbar Pages e demais interações propostas. |
| 017 | in progress | Fase 1 implementada e 12/12 UI; faltam registro ADR/verificações do plano. Fase 2 de associações permanece separada. |
| 018 | open | Correto: wrappers/placeholders de links não são os diálogos e a edição de destino propostos. |
| 019 | in progress | Funcionalidade Windows implementada, 24/24 UI; pendências de plataforma registradas. Evidence precisa atualização. |
| 020 | open | Correto: não há entrega do escopo de idiomas/dicionários e idioma por documento proposto. |
| 021 | open | Correto: UTF-16/32 são recusados com explicação; não há round-trip nessas codificações. |
| 022 | open | Correto: autocompletion de gramática não entrega heading/path/include completion. |
| 023 | open | Correto como conjunto de conveniências pendentes; caracteres selecionados já aparecem no status, mas isso não entrega palavras/tempo de leitura nem os demais itens. |
| 024 | parked | Correto: interface continua com textos sem infraestrutura de localização. |
| 025 | done | Controlador e snapshots presentes; 110/110 unit e 34/34 UI passam. As falhas novas da superfície nativa pertencem a 009. |
| 026 | in progress | Transformação real e 42/42 unit + 21/21 UI; R-06 e inspeções de saída restantes impedem tratar como terminado. |
| 027 | open | Correto para o escopo restante; slice de CI já implementado, R-05 exige melhorar isolamento. |
| 028 | open | Correto: não foi acrescentado o keymap de continuação de listas/citações em AsciiDoc/Typst. |
| 029 | open | Correto: erros/toasts de compilador não entregam diagnósticos estruturados e navegação. |
| 030 | open | Correto: modal seguro novo é avanço parcial, não uma auditoria geral de teclado/acessibilidade. |
| 031 | open | Correto: journal de não salvos não é histórico versionado de arquivos salvos. |
| 032 | in progress | Guarda por hash implementada; R-04 e verificações restantes devem ser resolvidos. |
| 033 | open | Correto: fontes de corpo embutidas não tornam KaTeX/CSS/recursos um pacote offline completo. |

## Validação executada e seus limites

- Windows Rust: **147 passed, 2 ignored**, através do harness/MSVC wrapper.
- App-free: `p0:unit` **110/110**, `test:sessions` **60/60**,
  `export:paths:unit` **42/42**. ESLint, knip e format:check passam.
- Perfil/identifier isolado: `p0-lifecycle` **34/34**, `single-instance`
  **12/12**, `preview-zoom` **24/24**, `export-browser` **21/21**, `menu`
  **97/97**, `close` **4/4**, `pdf-native` **11/11**.
- O PDF real passou **36/36** checks Poppler na fixture e **14/14** no HTML
  estático, usando WebView2 como gravador e Poppler no WSL como medidor.
  Isto não é uma execução do aplicativo Linux nem nova inspeção visual humana
  das páginas; o script remove as imagens de sua pasta temporária ao terminar.
- A primeira rodada isolada de zoom parou por falta de Typst no novo namespace.
  A repetição com o Typst 0.15.1 já instalado no PATH passou 24/24.
- O modo `auto` do checker PDF escolheu o Poppler nativo apenas por encontrar
  `pdfinfo`; `pdffonts` não estava disponível e o teste parou com
  `spawnSync pdffonts ENOENT`. Repeti uma cópia temporária do driver com
  `--rasterizer wsl` e alvos no workspace, e todos os checks passaram. Melhorar
  a detecção do conjunto de ferramentas e tornar a seleção propagável pelo
  harness; esse erro não prova defeito no PDF produzido.
- Os probes adicionais falham propositalmente nas expectativas de segurança:
  scripts filhos não recusados, script executado no PDF e concorrência que
  interrompe ambas as operações. Logs: `T:\Temp\mdraft-test-JmtXq0\logs`.
  A rodada de repetição/Poppler está em `T:\Temp\mdraft-test-w5dwsf\logs`;
  os demais checks isolados, em `T:\Temp\mdraft-test-amLETd\logs`.
- Build temporário isolado: prefixo SHA-256 `8c27993d1bf5`. O binário original
  foi restaurado para `692e826a9288c9bd48737345bc24b559b485d78865e0e184f67a2e820335b2fb`.
  Não foi alterado o identifier dos arquivos de configuração do repositório.
- Não executei as 41 camadas completas nem uma nova rodada nativa Linux.
  Testes verdes do caminho feliz não invalidam os probes de erro e concorrência.
- Durante a revisão surgiu uma alteração externa em `src/main.ts`, somente
  acrescentando uma quebra de linha no texto About. Ela foi preservada e não
  faz parte desta revisão. Não implementei correções no código do aplicativo.

## Próxima sequência recomendada

**Execução posterior aprovada:** as correções e suas novas evidências estão no
[plano de correção](plans/2026-10-25-print-safety-and-pdf-workflow.md). Esta revisão
preserva os resultados anteriores como histórico; o backlog vivo distingue os
itens corrigidos das verificações de plataforma e do CI remoto ainda pendentes.

1. Corrigir R-01 P0 antes de novas funcionalidades.
2. Corrigir a fronteira de scripts e a propriedade das operações de impressão
   (R-02/R-03), com testes negativos reais além da fixture de qualidade.
3. Corrigir R-04 e tornar o harness seguro diante de uma instalação aberta
   (R-05); então repetir os checks afetados.
4. Atualizar o backlog/planos com entregas parciais e evidências históricas
   claramente separadas; completar ADR/validações pendentes, corrigir R-06 e
   registrar o primeiro CI remoto quando os commits forem enviados.

Não há motivo para reimplementar handoff, zoom, hash ou toda a exportação.
O trabalho seguinte é completar e corrigir essas entregas com testes que
reproduzam os defeitos acima.

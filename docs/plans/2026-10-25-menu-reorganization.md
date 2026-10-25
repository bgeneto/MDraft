# Reorganização dos menus por intenção do usuário

**Status:** in progress — árvore, rotas, disponibilidade, docs e validação
automatizada entregues; Linux verificado no WSL2; tree test/teste de tarefas,
macOS, janela estreita e escalas 150%/200% ainda pendentes.
**Date:** 2026-10-25
**ADR:** `../adr/2026-10-25-menu-information-architecture.md`

## Context and goal

O usuário solicitou uma análise de IHC/UI/UX e uma proposta completa de menus,
incluindo ações existentes que ainda não aparecem na barra principal. Esta é
uma proposta para revisão. Nenhum código do aplicativo foi alterado.

A análise considera a árvore nativa em `src-tauri/src/menu.rs`, os handlers e
controles em `src/main.ts`, os menus de contexto de `src/context-menu.ts` e
`src/tabs.ts`, as preferências em `src/preferences.ts`, os keymaps instalados
em `src/editor.ts`, os documentos de `src/content.ts` e o backlog vigente.
É uma inspeção do código atual, incluindo mudanças locais existentes, sem
teste de usabilidade ou verificação da interface em execução nesta etapa.

### Diagnóstico

- A separação atual entre Paragraph e Format tem uma lógica técnica:
  operações de bloco e operações inline. Os rótulos não comunicam essa
  distinção de maneira suficiente a quem está escrevendo um documento.
- Paragraph contém títulos, listas, tabelas, equações, código, alertas,
  sumário e metadados. A categoria é estreita para seu conteúdo e extensa
  para consulta rápida.
- Format contém estilo de texto, links, imagens e duas modalidades de
  matemática. A intenção de inserir conteúdo se mistura à de alterar texto.
- File contém navegação entre abas e preferências; Themes contém somente
  três opções, enquanto outras escolhas visuais ficam nas preferências.
- Há duas entradas visíveis muito próximas: Math Block e Display Math. Os
  handlers diferem quando existe seleção; não podem ser simplesmente
  apagados ou tratados como equivalentes sem uma decisão de comportamento.
- Install Pandoc e Install Typst aparecem em Help e Export. A ação é a
  mesma, mas os dois locais competem como endereço principal.
- Operações importantes estão em menus de contexto, atalhos, preferências
  ou controles pequenos, sem um caminho correspondente na barra principal.
- Há uma assimetria dentro da própria faixa de abas: `entriesForBar()` já
  oferece Close All Tabs no clique direito sobre a área vazia, mas
  `entriesForTab()` não oferece a ação no clique direito sobre uma aba.
  A reorganização precisa conferir a consistência nas duas direções:
  operações contextuais promovidas à barra e operações pertinentes da
  barra disponíveis também no contexto das abas.
- A nomenclatura tem problemas próprios: Strong/Emphasis são menos diretos
  que Bold/Italic; Code Fences descreve sintaxe; Increase Heading Level é
  ambíguo quanto a H1/H2; Toggle Checked estabelece um estado; Plain List
  Item remove também o marcador de lista; Zoom altera a fonte do editor.
- O estado dos menus precisa acompanhar a linguagem e o contexto. Um item
  que somente avisa depois do clique que não pode funcionar tem baixo valor
  de descoberta.

O objetivo é que o usuário consiga prever a categoria de uma ação por sua
intenção, ver o estado atual e reconhecer o efeito antes de executar.

## Scope and non-scope

### Escopo proposto para a primeira implementação

1. Reorganizar a barra, seus itens e seus separadores; melhorar os rótulos.
2. Dar acesso pela barra às operações existentes selecionadas abaixo.
   Garantir a paridade das operações de fechamento entre Arquivo e o menu
   contextual de uma aba, acrescentando Fechar todas as abas a este último
   e preservando o acesso existente pela área vazia da faixa.
3. Sincronizar disponibilidade, rótulos condicionais e estado com as outras
   superfícies. Um novo caminho de menu exige implementação e validação,
   mesmo quando a operação já existe.
4. Adicionar endereçamento de seções ao painel de preferências para que
   Idioma da revisão, Fontes e leitura e Configurar exportação abram no lugar
   correspondente.
5. Normalizar duas pequenas diferenças necessárias à proposta: a equação
   em bloco passa a ter uma apresentação única com tratamento de seleção;
   restaurar o zoom deixa de alterar a largura do conteúdo e as fontes-base.
   O zoom real de documento entregue em trabalho concorrente é incorporado à
   barra como `View › Zoom`.
6. Atualizar os documentos e atalhos internos, guia e testes afetados.

### Fora deste escopo

- Tradução integral do produto. Os rótulos em português neste documento
  servem para discutir a proposta; a aplicação pode continuar em inglês.
  Localização é GAP-024.
- As funções novas da lista de incrementos posteriores, incluindo Salvar
  todos, reabrir aba fechada e busca na prévia.
- Novo motor de exportação, impressão interna, gerenciamento de arquivos,
  alteração do dialeto, nova dependência, telemetria ou atividade de rede.
- Um novo sistema geral de plugins, comandos ou atalhos personalizáveis.
- Transformar alterações de fontes/tema em estilos locais de um trecho do
  documento. As preferências continuam globais, com os efeitos atuais sobre
  prévia e exportações documentados.
- Implementar interface que mostre itens futuros ainda sem função.

## Approach and rejected alternatives

### Barra recomendada

| Português para discussão | Inglês para o produto | Intenção |
| --- | --- | --- |
| Arquivo | File | Abrir, guardar, exportar e fechar documentos |
| Editar | Edit | Alterar texto, seleção e área de transferência |
| Inserir | Insert | Acrescentar elementos e conteúdo |
| Formatar | Format | Aplicar estilo e estrutura ao texto |
| Navegar | Navigate | Mudar de posição, aba ou destino |
| Exibir | View | Escolher o que aparece e como é apresentado |
| Ferramentas | Tools | Revisão, programas auxiliares e preferências |
| Ajuda | Help | Aprender e consultar informações do aplicativo |

O número oito é uma hipótese de organização para este conjunto de comandos,
não uma regra cognitiva nem um resultado medido. A proposta se sustenta na
separação das tarefas e deve ser validada com usuários.

Há um endereço principal por ação. Menus de contexto e botões continuam
oferecendo atalhos locais para a mesma operação. Cada submenu tem apenas um
nível abaixo do menu principal; os separadores expressam grupos de intenção.

### Árvore completa da primeira implementação

Nesta árvore, `*` indica uma operação existente que recebe um caminho novo
na barra ou uma nova ligação à interface existente. Não significa que o item
já esteja implementado. `!` indica a normalização de comportamento explicitada
no escopo. O restante é realocação ou melhoria de rótulo de itens já presentes.
As marcações são exclusivas da proposta e não aparecem no produto.

```text
Arquivo
  Novo documento
  Abrir…
  Abrir recente > arquivos atuais; Limpar histórico de arquivos recentes
  ─────────────────────────
  Salvar
  Salvar como…
  [✓] Salvamento automático
  Recarregar do disco
  ─────────────────────────
  Exportar > HTML…; PDF…; Word (.docx)…; OpenDocument (.odt)…;
             LaTeX…; reStructuredText…; AsciiDoc…; EPUB…; RTF…;
             Textile…; MediaWiki…; OPML…; formatos personalizados
  Imprimir / Salvar PDF pelo navegador…
  Mostrar na pasta
  ─────────────────────────
  Fechar aba
  Fechar abas > Outras*; À esquerda*; À direita*; Outras sem alterações*; Todas
  Fechar janela
  Sair

Editar
  Desfazer
  Refazer
  ─────────────────────────
  Recortar
  Copiar
  Colar
  Colar sem formatação*
  Excluir seleção*
  Selecionar tudo
  ─────────────────────────
  Localizar no código-fonte…
  Substituir no código-fonte…
  Próxima ocorrência*
  Ocorrência anterior*
  Selecionar ocorrências > Adicionar próxima*; Selecionar todas*
  ─────────────────────────
  Converter seleção > MAIÚSCULAS*; minúsculas*; Iniciais de cada palavra*
  Linhas > Duplicar*; Mover para cima*; Mover para baixo*
  Comentar / Descomentar*

Inserir
  Link
  Imagem
  Tabela
  ─────────────────────────
  Bloco de código
  Equação no texto
  Equação em bloco!
  Bloco de aviso > Nota; Dica; Importante; Aviso; Cuidado
  ─────────────────────────
  Linha horizontal
  Sumário do documento
  Metadados YAML / Atributos do documento
  ─────────────────────────
  Parágrafo antes
  Parágrafo depois

Formatar
  Negrito
  Itálico
  Tachado
  Código no texto
  ─────────────────────────
  Estilo de parágrafo > Texto normal; Título 1; Título 2; Título 3;
                       Título 4; Título 5; Título 6
  Promover título (H2 → H1)
  Rebaixar título (H1 → H2)
  Citação em bloco
  ─────────────────────────
  Lista > Com marcadores; Numerada; De tarefas
  Tarefas > Marcar como concluída; Marcar como pendente; Converter em texto normal
  Aumentar recuo
  Diminuir recuo
  ─────────────────────────
  Formatar código-fonte do documento*

Navegar
  Ir para linha…*
  ─────────────────────────
  Próxima aba
  Aba anterior
  Abas abertas > lista das abas, com a atual marcada*
  Mover aba para a esquerda*
  Mover aba para a direita*
  ─────────────────────────
  Abrir destino sob o cursor*
  Adicionar aos favoritos / Remover dos favoritos*

Exibir
  (●) Somente editor
  ( ) Editor e prévia
  ( ) Somente prévia
  Prévia Typst > Texto contínuo*; Páginas de impressão*
  ─────────────────────────
  Barra lateral > Mostrar barra lateral; Estrutura do documento;
                 Favoritos; Arquivos recentes
  [✓] Barra de status
  ─────────────────────────
  [ ] Destacar linha atual — modo foco
  [ ] Acompanhar cursor — modo máquina de escrever
  [✓] Sincronizar rolagem
  ─────────────────────────
  Zoom > Aumentar; Diminuir; Restaurar zoom!
  Tema da interface > Seguir sistema; Claro; Escuro
  Cores do código > Acompanhar tema*; Paper*; Ink*; Catppuccin Latte*;
                   GitHub Dark*; One Dark*; Solarized Light*; Solarized Dark*; Nord*
  Fontes e leitura…*
  Blocos e seções > Recolher atual*; Expandir atual*; Recolher todos*; Expandir todos*
  ─────────────────────────
  [ ] Tela cheia

Ferramentas
  [✓] Verificar ortografia ao digitar*
  Idioma da revisão…*
  ─────────────────────────
  Configurar exportação…*
  Pandoc: verificar ou instalar…
  Typst: verificar ou instalar…
  ─────────────────────────
  Preferências…

Ajuda
  Boas-vindas e exemplos*
  Referência Markdown
  Referência AsciiDoc
  Referência Typst
  Atalhos de teclado
  ─────────────────────────
  Licenças das fontes
  Sobre o MDraft
```

Os estados marcados na árvore são ilustrativos. A interface deve sempre
mostrar o estado real. As alternativas exclusivas podem usar checks se o
backend nativo não oferecer radio items; somente uma deve estar marcada.

### Decisões sobre os casos ambíguos

**Inserir e Formatar.** Link, imagem, tabela, código em bloco, equações,
avisos, separador, sumário e metadados são elementos a acrescentar. Títulos,
listas e citação descrevem o papel do texto e ficam em Formatar. Código no
texto continua em Formatar junto às outras operações sobre o trecho. Uma
seleção pode ser aproveitada por uma operação de Inserir; a distinção é a
intenção do usuário, não a presença ou ausência de seleção.

**Limite entre promessa e comportamento.** As ações atuais variam por
linguagem: listas e citações podem transformar linhas ou inserir um modelo;
HTML usa wrappers/blocos. A reorganização não promete conversão estrutural
completa de HTML ou remoção inteligente de estilos. Essas capacidades
precisariam de escopo próprio.

**Matemática.** Manter dois conceitos visíveis: equação no texto e equação
em bloco. O comando em bloco aproveita uma seleção; sem seleção, insere um
bloco vazio com cursor no lugar correto. `para.mathBlock` e
`format.displayMath` permanecem como identificadores aceitos, delegando ao
mesmo comportamento após validação por dialeto. Preservar o atalho atual da
equação em bloco. Não alterar ou normalizar o conteúdo matemático selecionado.

**Títulos.** Promover e rebaixar são acompanhados de exemplos de direção.
Em inglês, usar Promote Heading / Demote Heading. Uma explicação curta
distingue nível hierárquico de tamanho visual. O tratamento específico do
título de documento do AsciiDoc permanece o atual.

**Tarefas.** Os handlers atuais estabelecem concluída ou pendente; seus
rótulos devem dizer isso. O handler chamado Plain List Item remove o
marcador de tarefa e o da lista: o rótulo proposto é Converter em texto
normal. Converter tarefa em item de lista preservando o marcador seria
uma ação diferente, ainda não implementada.

**Imagem e link.** Hoje esses comandos inserem modelos de sintaxe; não abrem
seletores. Os rótulos da primeira etapa ficam sem reticências. Imagem de
arquivo… e Link… com formulário pertencem aos incrementos posteriores.

**PDF e impressão.** PDF… em Exportar é a geração de arquivo pelo caminho
atual de compilação/conversão. Imprimir / Salvar PDF pelo navegador… chama
o caminho existente de impressão externa. Informar que abre o navegador;
não prometer diálogo nativo, destino conhecido ou suporte a Typst nesse
caminho. Os programas exigidos continuam os realmente exigidos hoje pelo
fluxo, inclusive as verificações do frontend. Mudanças de requisitos do
pipeline pertencem a planos de exportação, não a esta reorganização.

**Formatos de exportação.** Preservar todos os formatos configurados e os
personalizados, seus identificadores e sua ordem. Usar nomes/ extensões
reconhecíveis nos padrões. Não reescrever rótulos personalizados do usuário.
Evitar submenus dentro de Exportar; se a lista personalizada crescer muito,
propor depois um seletor de formatos em vez de mais níveis de cascata.

**Zoom.** O ajuste entregue no checkout é um zoom de documento: `View › Zoom`
com `Zoom In`, `Zoom Out` e `Reset Zoom`. O rótulo e o alcance acompanham o
plano concorrente de preview zoom; os IDs e atalhos existentes foram mantidos e
os comandos ficam disponíveis em todos os modos de exibição. `Reset Zoom` altera
somente `zoomLevel`, sem redefinir `editorMaxWidth` nem as fontes-base
(`editorFontSize`, `bodyFontSize`). O rótulo original "Editor Text Size" foi
substituído por "Zoom" durante a implementação; registrar como desvio.

**Temas, cores e fontes.** Tema da interface escolhe sistema/claro/escuro;
Cores do código escolhe a paleta; Fontes e leitura abre Typography nas
preferências. Escolher fonte muda preferências globais, não aplica uma
fonte a uma palavra selecionada. Alguns ajustes participam das exportações;
a documentação deve manter essa distinção explícita.

**Prévia e estrutura.** Estrutura do documento abre o painel que já existe.
Sumário do documento insere conteúdo no arquivo. Texto contínuo e Páginas
de impressão são alternativas da prévia Typst, dentro dos modos gerais
Somente editor / Editor e prévia / Somente prévia.

**Localizar.** O recurso atual busca no código-fonte. O rótulo e o foco
precisam informar esse alvo. Se acionado em Somente prévia, revelar o editor
e seu painel de busca. Busca no texto renderizado é GAP-011 e fica fora da
primeira etapa. Os controles de caso, palavra inteira e regex continuam
no painel de busca; não precisam virar itens separados da barra.

**Favoritos.** Exibir > Barra lateral > Favoritos mostra a coleção. Navegar
> Adicionar/Remover dos favoritos altera a participação do documento atual.
A distinção é entre mostrar o painel e modificar a coleção. Não adicionar
Limpar todos os favoritos: a remoção individual é uma decisão vigente.

**Navegação entre abas.** A barra opera sobre a aba ativa; o menu de contexto
continua operando sobre a aba clicada, mesmo inativa. Mover uma aba muda sua
ordem; Próxima/Aba anterior muda a aba ativa. A lista Abas abertas reutiliza
as sessões existentes, com nomes suficientes para distinguir arquivos de
mesmo nome e documentos sem título. Não é um quick open com busca fuzzy.

**Programas auxiliares.** Ferramentas é o endereço principal para instalar
ou verificar Pandoc/Typst. Se Exportar estiver indisponível, seu rótulo
informa o motivo e a orientação aponta para Ferramentas. A instalação
continua ocorrendo somente por uma ação explícita do usuário. Preferências
continuam podendo oferecer os mesmos controles na seção Export.

### Paridade entre o menu principal e os contextos da faixa de abas

**Complemento solicitado pelo usuário em 2026-10-25.** O escopo inclui
explicitamente revisar os dois contextos de `src/tabs.ts`, além do menu
nativo. A consistência deve abranger presença, nome, alvo, disponibilidade
e tratamento de alterações não salvas.

A inspeção encontrou duas superfícies diferentes:

- **Clique direito sobre uma aba:** hoje tem Close, Close Others, Close All
  to the Left, Close All to the Right e Close Unchanged; falta Close All Tabs.
- **Clique direito na área vazia da faixa:** hoje tem New Tab, Close All Tabs
  e Close Unchanged. O acesso a fechar todas nesse contexto deve permanecer.

#### Família de fechamento no menu de uma aba

Manter as operações diretamente no menu contextual, com separadores entre
os grupos. O submenu Fechar abas continua sendo uma organização do menu
principal; o contexto tem espaço para oferecer seus comandos diretamente.

```text
Fechar aba
Fechar outras abas
Fechar abas à esquerda
Fechar abas à direita
Fechar outras abas sem alterações
─────────────────────────
Fechar todas as abas
─────────────────────────
Salvar
Salvar como…
─────────────────────────
Formatar código-fonte do documento
Adicionar aos favoritos / Remover dos favoritos
Mostrar na pasta
```

Fechar todas as abas fecha também a aba clicada e a aba ativa. Seu alcance
global deve ficar explícito no rótulo, e o separador o distingue dos
fechamentos que preservam a aba de referência. Não atribuir atalho novo
a essa operação nesta etapa.

O código atual de Close Unchanged preserva a aba de referência: a clicada
no contexto de uma aba, ou a ativa no contexto da área vazia. O nome comum
proposto é **Fechar outras abas sem alterações**, com **Outras sem alterações**
como item de Arquivo > Fechar abas. Isso explicita o alcance e preserva o
comportamento existente.

#### Matriz de presença e alvo

| Operação | Menu principal | Contexto de uma aba | Contexto da área vazia |
| --- | --- | --- | --- |
| Novo documento | Arquivo > Novo documento | Não incluir neste contexto | Novo documento; manter a ação existente New Tab |
| Fechar aba | Aba ativa | Aba clicada | Não incluir: não há aba clicada |
| Fechar outras abas | Todas, exceto a ativa | Todas, exceto a clicada | Não incluir neste contexto |
| Fechar abas à esquerda | À esquerda da ativa | À esquerda da clicada | Não incluir neste contexto |
| Fechar abas à direita | À direita da ativa | À direita da clicada | Não incluir neste contexto |
| Fechar outras abas sem alterações | Abas sem alterações, exceto a ativa | Abas sem alterações, exceto a clicada | Abas sem alterações, exceto a ativa |
| Fechar todas as abas | Todas | Todas — acrescentar o item ausente | Todas — preservar o item existente |
| Salvar / Salvar como | Aba ativa | Aba clicada; preservar os dois itens | Não incluir neste contexto |
| Mostrar na pasta | Documento ativo | Documento clicado; preservar o item | Não incluir neste contexto |
| Formatar código-fonte / Favoritar | Documento ativo, nos respectivos menus | Documento clicado; preservar os itens | Não incluir neste contexto |

A área vazia reúne as ações globais da faixa: Novo documento, Fechar outras
abas sem alterações e Fechar todas as abas. Operações como esquerda/direita
e fechar outras dependem de uma referência e permanecem nos menus em que
essa referência está clara. A paridade cobre as ações pertinentes a cada
contexto; não exige reproduzir o menu Arquivo inteiro em cada aba.

#### Execução, disponibilidade e segurança

- Reutilizar as mesmas operações de fechamento individual e em lote do
  ciclo de vida existente, passando os IDs corretos; evitar uma segunda
  implementação das decisões de salvar, descartar ou cancelar.
- Um clique direito numa aba inativa conserva seu papel de referência.
  Não ativá-la nem trocar silenciosamente o alvo para a aba ativa para
  executar salvar, fechar outras, esquerda/direita ou formatar.
- Desabilitar esquerda/direita sem vizinhos, outras quando há somente uma
  aba e outras sem alterações quando não há candidata além da referência.
- Fechar todas continua disponível com uma única aba. Depois do fechamento
  bem-sucedido do conjunto, manter o comportamento atual de criar um novo
  documento vazio; a operação não fecha a janela do aplicativo.
- Resolver e validar o conjunto de IDs ao acionar a operação. Se a aba de
  referência de uma ação relativa já não existir, não usar outra aba como
  referência implícita. Uma aba criada depois do início do fechamento não
  passa a integrar o lote que já foi iniciado.
- Usar o mesmo fluxo Salvar / Descartar / Cancelar em todos os acessos.
  Cancelar, cancelar Salvar como ou uma falha de gravação mantém todas as
  abas do lote abertas; salvamentos anteriores bem-sucedidos permanecem,
  e descartes pendentes não se aplicam parcialmente.
- Conservar texto, estado de alterações, histórico de undo, ordem e foco
  de acordo com as regras atuais quando o fechamento for cancelado. Manter
  as guardas de revisão para digitação durante decisões e gravações.

### Ações existentes que ganham visibilidade

| Ação | Onde existe hoje | Destino proposto |
| --- | --- | --- |
| Formatar código-fonte | Menu de contexto do editor e da aba; `formatSession` | Formatar |
| Colar sem formatação | Ctrl/Cmd+Shift+V; tratamento de paste | Editar |
| Excluir seleção | Menu de contexto do editor | Editar |
| MAIÚSCULAS, minúsculas, iniciais | Menu de contexto do editor | Editar > Converter seleção |
| Duplicar e mover linhas | Contexto e comandos do CodeMirror | Editar > Linhas |
| Comentar/descomentar | Contexto, quando a linguagem informa sintaxe | Editar |
| Próxima/anterior ocorrência | `searchKeymap` instalado | Editar |
| Selecionar próximas/todas ocorrências | `searchKeymap` instalado | Editar > Selecionar ocorrências |
| Ir para linha | `gotoLine` no keymap instalado | Navegar |
| Recolher/expandir | Gutter e `foldKeymap` instalado | Exibir > Blocos e seções |
| Fechar outras/esquerda/direita/sem alterações | Menu de contexto das abas | Arquivo > Fechar abas |
| Reordenar abas | Arraste e Alt+Shift+setas com foco na aba | Navegar |
| Escolher entre abas abertas | Faixa de abas e armazenamento de sessões | Navegar > Abas abertas |
| Adicionar/remover favorito | Contexto do editor e das abas | Arquivo |
| Abrir link/arquivo/imagem/âncora | Ctrl/Cmd+clique e contexto | Navegar > Abrir destino sob o cursor |
| Ortografia ligada/desligada | Indicador da barra de status e preferências | Ferramentas |
| Idioma/dicionário | Preferências > Editor | Ferramentas > Idioma da revisão |
| Prévia Typst Document/Pages | Botões da própria prévia | Exibir > Prévia Typst |
| Paletas de código | Preferências > Appearance | Exibir > Cores do código |
| Fontes e leitura | Preferências > Typography | Exibir > Fontes e leitura |
| Configurar formatos de exportação | Preferências > Export | Ferramentas > Configurar exportação |
| Documento de boas-vindas | `WELCOME`, abertura inicial | Ajuda |

Estas constatações são sobre existência no código, não uma afirmação de que
todos os atalhos sejam alcançáveis na interface atual. Em particular,
Ctrl+Shift+[ e Ctrl+Shift+] do foldKeymap concorrem com os atalhos globais
das listas. Ctrl+Shift+L é o atalho da barra lateral, não de selecionar
ocorrências; selecionar a próxima ocorrência é Ctrl+D e não conflita com
aquele atalho. A etapa de implementação deve resolver a prioridade sem
retirar atalhos de listas/barra lateral já anunciados. Não copiar cegamente
os atalhos padrão da biblioteca para os novos itens.

### Migração de todos os comandos atualmente expostos

Os IDs são detalhes de compatibilidade: mudar o endereço ou o rótulo não
exige renomeá-los. Esta tabela cobre os itens construídos pelo menu atual.

| IDs atuais | Endereço final / tratamento |
| --- | --- |
| `file.new`, `file.open` | Arquivo > Novo documento / Abrir |
| `file.openRecent`, `recent.file:…`, `recent.empty`, `recent.clear` | Arquivo > Abrir recente; preservar cap e identidade por caminho |
| `file.save`, `file.saveAs`, `file.autoSave`, `file.reload` | Arquivo; manter fluxos de segurança |
| `file.close`, `file.closeAll` | Arquivo > Fechar aba / Fechar abas > Todas |
| `file.nextTab`, `file.prevTab` | Navegar > Próxima aba / Aba anterior |
| `file.reveal` | Arquivo > Mostrar na pasta |
| `file.preferences` | Ferramentas > Preferências |
| Close Window / Quit predefinidos | Arquivo > Fechar janela / Sair, respeitando o sistema |
| Undo / Redo / Cut / Copy / Paste / Select All predefinidos | Editar; manter propriedade nativa do foco |
| `edit.find`, `edit.replace` | Editar > Localizar / Substituir no código-fonte |
| `para.h1`, `para.h2`, `para.h3`, `para.h4`, `para.h5`, `para.h6`, `para.paragraph` | Formatar > Estilo de parágrafo |
| `para.increaseHeading`, `para.decreaseHeading` | Formatar > Promover título / Rebaixar título |
| `para.quote` | Formatar > Citação em bloco |
| `para.ol`, `para.ul`, `para.task` | Formatar > Lista > Numerada / Com marcadores / De tarefas |
| `para.taskDone`, `para.taskTodo`, `para.taskPlain` | Formatar > Tarefas > Concluída / Pendente / Texto normal |
| `para.indent`, `para.outdent` | Formatar > Aumentar / Diminuir recuo |
| `para.table`, `para.codeBlock` | Inserir > Tabela / Bloco de código |
| `para.mathBlock`, `format.displayMath` | Inserir > Equação em bloco; uma entrada visível e IDs aceitos |
| `para.alertNote`, `para.alertTip`, `para.alertImportant`, `para.alertWarning`, `para.alertCaution` | Inserir > Bloco de aviso |
| `para.insertBefore`, `para.insertAfter` | Inserir > Parágrafo antes / depois |
| `para.hr`, `para.toc`, `para.yaml` | Inserir > Linha horizontal / Sumário / Metadados ou atributos |
| `format.bold`, `format.italic`, `format.strike`, `format.code` | Formatar > Negrito / Itálico / Tachado / Código no texto |
| `format.link`, `format.image`, `format.math` | Inserir > Link / Imagem / Equação no texto |
| `view.source`, `view.split`, `view.preview` | Exibir > Somente editor / Editor e prévia / Somente prévia |
| `view.sidebar`, `view.outline`, `view.favorites`, `view.recent` | Exibir > Barra lateral |
| `view.statusBar`, `view.focus`, `view.typewriter`, `view.syncScroll`, `view.fullscreen` | Exibir; rótulos e estado consistentes |
| `view.zoomIn`, `view.zoomOut`, `view.zoomReset` | Exibir > Zoom > Aumentar / Diminuir / Restaurar; reset limitado ao zoom |
| `themes.system`, `themes.light`, `themes.dark` | Exibir > Tema da interface |
| `export.html` | Arquivo > Exportar > HTML |
| `export.pdf` | Arquivo > Imprimir / Salvar PDF pelo navegador |
| `export.pandoc.…` | Arquivo > Exportar > formato correspondente, incluindo PDF |
| `export.installPandoc`, `help.pandoc` | Ferramentas > Pandoc: verificar ou instalar; preservar aliases |
| `export.installTypst`, `help.installTypst` | Ferramentas > Typst: verificar ou instalar; preservar aliases |
| `help.reference`, `help.asciidocReference`, `help.typstReference` | Ajuda > referências individuais |
| `help.shortcuts`, `help.licences`, `help.about` | Ajuda > Atalhos / Licenças / Sobre |
| Submenu MDraft do macOS | Preferências, Sobre e Sair no menu do aplicativo; preservar Services/Hide/Show All |

### Disponibilidade e comportamento por contexto

Manter a árvore principal estável. Desabilitar comandos indisponíveis com
motivo breve quando necessário; o handler também deve validar o contexto,
pois pode ser chamado por um atalho ou menu ainda não atualizado. Motivos
não podem depender apenas de tooltips, pouco confiáveis no menu nativo.

| Ação | Regra observável |
| --- | --- |
| Editar conteúdo | Respeitar somente leitura, aba iniciadora e seleção |
| Operações de área de transferência | Campo de busca/preferências mantém sua própria seleção e paste nativo |
| Formatar código-fonte | Markdown/HTML/Typst; indisponível em AsciiDoc, somente leitura e enquanto ocupado |
| Equações | Rotas atuais em Markdown/AsciiDoc/Typst; indisponíveis em HTML |
| Lista de tarefas e estados | Markdown/AsciiDoc; indisponíveis em HTML/Typst |
| Avisos | Markdown/AsciiDoc; indisponíveis em HTML/Typst |
| Metadados | YAML em Markdown, atributos em AsciiDoc; indisponíveis em HTML/Typst |
| Sumário inserido | Markdown/AsciiDoc/Typst; indisponível em HTML |
| Promover/rebaixar título | Rotas atuais de Markdown/AsciiDoc/Typst; indisponível em HTML |
| Prévia Typst | Somente documento Typst e condições necessárias à prévia |
| Sincronizar rolagem | Efeito em Editor e prévia; indicar indisponibilidade nos outros modos |
| Ortografia | Indicar ausência de suporte em HTML ou de dicionário instalado |
| Comentar | Habilitar somente quando a linguagem informa sintaxe de comentário |
| Favoritar / Mostrar na pasta | Documento com caminho; desabilitar sem nome |
| Abrir destino sob cursor | Destino válido na posição atual; rótulo pode esclarecer link/arquivo/imagem/título |
| Operações de fechar/mover abas | Habilitar somente se há alvo; preservar fechamento cancelável |
| Zoom | Efeito no documento ativo em qualquer modo; reset altera somente o zoom |
| Exportação e impressão | Validar linguagem, programas necessários e particularidades reais de cada fluxo |
| Estrutura/favoritos/recentes no modo foco | Explicar que o modo foco oculta a barra lateral; evitar marcar painel como visível quando está oculto |

Negrito, itálico etc. não devem receber checkmarks de estado sem detecção
confiável da seleção e de casos mistos. A primeira etapa pode mantê-los como
ações, já que os handlers atuais inserem/envolvem sintaxe.

### Incrementos posteriores: funções que ainda precisam ser desenvolvidas

| Prioridade de UX | Item e destino | Trabalho novo / vínculo com backlog |
| --- | --- | --- |
| Alta | Arquivo > Salvar todos | Operação própria com falhas/cancelamento por documento; GAP-004 |
| Alta | Navegar > Abrir rapidamente… | Busca em abas/recentes/favoritos; GAP-008; a lista simples de abas não entrega isso |
| Alta | Ferramentas > Buscar comando… | Paleta pesquisável por ação, sinônimo, caminho, atalho e disponibilidade; incremento posterior relacionado a GAP-008 |
| Alta | Editar > Localizar na prévia… | Busca no texto renderizado, incluindo HTML guest e Typst Pages; GAP-011 |
| Média | Arquivo > Reabrir aba fechada | Restaurar o estado adequado, distinguindo de recuperação de crash; GAP-023 |
| Média | Arquivo / contexto da aba > Copiar caminho | Novo comando de clipboard; GAP-023 |
| Média | Inserir > Imagem de arquivo… | Seletor que reutiliza importação/regras de imagens; colar/soltar já existem, o seletor não |
| Média | Inserir > Link… / Editar link… | Formulário com texto e destino e tratamento da seleção; GAP-018 |
| Média | Arquivo > Novo com formato > Markdown/HTML/Typst/AsciiDoc | Escolha por documento sem alterar o padrão global; nova interação |
| Média | Exibir > Quebra de linha / Números de linha | Hoje sempre ativos; novas preferências e persistência, GAP-023 |
| Média | Ferramentas > Estatísticas do documento | Painel novo; métricas básicas já existem no status; seleção/tempo de leitura ampliam escopo, GAP-023 |
| Entregue | Exibir > Zoom | Plano concorrente de preview zoom; não é mais incremento posterior |
| Posterior | Inserir > Diagrama Mermaid | Modelo útil sobre renderização existente, com disponibilidade por linguagem; novo comando de autoria |
| Posterior | Formatar > Remover formatação | Remoção sintática por linguagem; não tratar como troca trivial de strings |
| Posterior | Ações de tabela, equações e prévia | Somente com implementações próprias e contexto adequado; GAP-010 e GAP-016 |

Os itens futuros não devem aparecer desabilitados permanentemente como
promessa de função. Publicá-los quando seu comportamento estiver implementado
e validado. Quick open e paleta são duas interações distintas. Reservar
Ctrl+Shift+P como candidato à paleta; decidir Ctrl+P em conjunto com impressão
e quick open, sem atribuí-lo a duas funções.

### Consistência, acessibilidade e menus de contexto

- Mostrar os atalhos existentes e preservá-los durante a reorganização.
  Tab/Shift+Tab continuam locais ao editor, sem capturar campos e diálogos.
- Usar reticências quando a ação pede uma escolha para ser concluída, como
  Abrir, Salvar como e exportar para um arquivo. Submenus usam seta.
- Usar check para escolhas independentes e exclusão mútua para modo/tema.
  A seleção de painel deve refletir também sua visibilidade efetiva.
- Manter estados de menu, controles da barra e preferências sincronizados
  depois de cliques, atalhos, troca de aba e reconstrução do menu.
- Oferecer navegação com teclado, foco visível e mnemonics sem colisões
  dentro de cada menu. Validar teclado ABNT2 e IME antes de novos atalhos.
- O menu de contexto do editor fica menor depois de ganhar um endereço
  principal para ações hoje exclusivas. Priorizar link sob cursor,
  edição básica, comentário e formatação. Transformações menos frequentes
  podem ficar apenas na barra/paleta, se a validação confirmar.
- O contexto da aba continua concentrado em salvar, fechar, favorito,
  formatação e localização daquele documento. O menu nativo opera sobre
  a aba ativa; ambos compartilham execução e guardas, não o alvo implícito.
- Conferir a matriz de paridade dos dois contextos da faixa. Fechar todas
  as abas deve existir tanto no contexto de uma aba quanto na área vazia,
  além de Arquivo > Fechar abas > Todas, com o mesmo alcance global.
- No macOS, Preferências/Sobre/Sair seguem o menu do aplicativo; no
  Windows/Linux seguem a distribuição acima. Não criar duplicação só
  para forçar uma árvore idêntica entre sistemas.

### Alternativas consideradas

- **Somente renomear Paragraph para Block.** Preserva a distinção técnica,
  mas Block é menos familiar e continua misturando criação de conteúdo,
  estrutura e metadados.
- **Fundir Paragraph e Format em um único menu.** Reduz categorias e produz
  um menu longo, com baixa previsibilidade para imagem, tabela e equação.
- **Criar menus Tabela, Matemática, Documento e Abas desde já.** Fragmenta
  a barra para conjuntos ainda pequenos. Podem ser reavaliados quando
  existirem mais operações próprias de cada domínio.
- **Manter Themes no primeiro nível.** Concede uma categoria inteira a três
  escolhas que pertencem naturalmente a Exibir.
- **Mover toda preferência para Exibir.** Ortografia, instalação de programas
  e configuração de exportação não são operações de visualização.
- **Usar apenas paleta de comandos.** Boa complementação para busca por
  intenção; exige conhecer sua existência e não substitui a descoberta pela
  barra ou a operação convencional por mouse.

## Steps

- [x] Investigar menus, handlers, controles, preferências e keymaps existentes.
- [x] Registrar proposta, inventário, destinos, limites e incrementos futuros.
- [x] Avaliar os dois contextos da faixa de abas e incorporar a paridade de
      fechamento solicitada pelo usuário, incluindo o item Fechar todas ausente
      no contexto de uma aba. O plano foi aprovado e implementado; a validação
      de descoberta permanece.
- [x] Obter aprovação explícita da proposta e registrar o status como approved.
- [x] Registrar ADR com categorias, limites Inserir/Formatar e endereço principal
      de cada operação. Revisar os arquivos afetados antes de implementar.
- [x] Reorganizar árvore e rótulos preservando IDs, configurações e atalhos;
      consolidar somente a apresentação das rotas duplicadas descritas.
- [x] Expor operações existentes pela barra, compartilhando execução e guardas
      com os controles atuais. Implementar links para seções de preferências.
- [x] Acrescentar Fechar todas as abas ao contexto de uma aba; preservar a ação
      na área vazia e aplicar a matriz de nomes, alvos e disponibilidade,
      incluindo Outras sem alterações nos três acessos pertinentes.
- [x] Sincronizar disponibilidade, estado e rótulos condicionais entre Rust e
      frontend; normalizar matemática em bloco e reset de zoom conforme escopo.
- [x] Atualizar documentos internos de ajuda, guia, capturas pertinentes e
      somente os trechos do backlog realmente entregues.
- [x] Executar validação automatizada e inspeção manual no Windows, por
      linguagem e modo de exibição.
- [x] Inspecionar menus no Linux (WSL2/Debian 13, GTK nativo).
- [ ] Inspecionar macOS, janela estreita e escalas 150%/200%.
- [ ] Realizar tree test e teste de tarefas; registrar resultados e ajustes.
- [x] Atualizar checkboxes, desvios e status; manter incrementos futuros separados.

## Files and modules

Esta seção registra os arquivos que a implementação tocou; a lista original de
alvos foi confirmada e ampliada durante a execução.

| Arquivo / módulo | Motivo |
| --- | --- |
| `src-tauri/src/menu.rs` | Árvore, labels, registro de atalhos, estado, disponibilidade, Open Tabs e `menu_items` |
| `src/main.ts` | Handlers, roteamento, estado, deep links, colar sem formatação, reset e normalização da equação |
| `src/tabs.ts` | Fechar todas no contexto da aba, nomes da família e resolução do alvo no clique |
| `src/editor.ts` | Comandos do CodeMirror expostos sem simular atalhos (busca, ocorrências, linhas, comentário, folding) |
| `src/preferences.ts` | `openAt(sectionId)` para os deep links |
| `src/api.ts` | Campos de `MenuState`, `OpenTabItem`, `set_open_tabs` e `menu_items` |
| `src/content.ts` | Ajuda e tabela de atalhos coerentes com a árvore final |
| `src/clipboard.ts` | Reutilizado por Editar › Colar sem formatação; sem alteração de contrato |
| `src/context-menu.ts` | Fonte de `titleCase` reutilizada pelo menu principal; sem alteração de comportamento |
| `docs/guide.md`, `README.md`, `docs/export.md`, `docs/backlog.md` | Caminhos, promessas e entregas reais |
| `AGENTS.md` | Contagens, nova suíte, trap do estado de exportação e tabela de scripts |
| `docs/adr/2026-10-25-menu-information-architecture.md` | Decisão durável de arquitetura da informação |
| `scripts/menu-test.mjs` | Nova suíte de inventário, disponibilidade, deep links e rotas |
| `package.json`, `scripts/test-all.mjs` | Camada `npm run menu` registrada no runner |
| `scripts/document-tabs-test.mjs`, `scripts/dom-smoke.mjs`, `scripts/format-document-test.mjs` | Cobertura dos novos caminhos e contagens |
| `scripts/p0-lifecycle-test.mjs` | Executado sem alteração para confirmar cancelamento/falha do fechamento em lote |
| ADR e este plano | Decisão aprovada, progresso, desvios e evidência de validação |

Se um harness novo for necessário, incluí-lo em `package.json`,
`scripts/test-all.mjs` e nas tabelas de scripts, conforme AGENTS.md. Não
adicionar harness por hábito quando um existente cobre a observação necessária.

## Risks and rollback

- **Memória muscular:** mover endereço e preservar atalho/ID reduz o custo;
  ajuda e documentação devem mostrar o caminho atual desde a entrega.
- **Novo nome prometer comportamento inexistente:** testar as regras acima,
  especialmente imagem/link sem seletor, busca na fonte, PDF no navegador,
  tamanho da fonte e tarefa convertida em texto normal.
- **Ações sobre a aba errada:** passar identidade explícita para execução;
  testar troca de aba durante diálogos e ações em aba inativa.
- **Paridade incompleta na faixa de abas:** testar separadamente clique em
  aba e em área vazia. A existência de closeAll em `entriesForBar()` não
  comprova que o item existe em `entriesForTab()`. Fechar todas inclui a
  referência; outras e outras sem alterações a preservam.
- **Estado nativo obsoleto:** sincronizar na troca de linguagem, modo,
  preferências, fullscreen e rebuild de exportações/recentes.
- **Conflitos de atalhos:** reter os anunciados pelo app; não adotar defaults
  do CodeMirror sem reconciliar captura global, foco, ABNT2 e IME.
- **Mudanças locais concorrentes:** o checkout já tinha alterações antes
  desta proposta. A implementação deve partir delas e evitar restaurações
  amplas de arquivos ou árvore de trabalho.
- **Mudança de saída matemática:** validar seleção/vazio por dialeto e
  preservar bytes da expressão, undo e posição do cursor.
- **Categorias ou submenus pouco encontráveis:** medir as tarefas e ajustar
  com evidência; não criar aliases em vários menus por antecipação.
- **Rollback:** implementar em commits revisáveis separados por árvore,
  novos acessos e normalizações. Reverter somente esses commits/trechos,
  mantendo IDs e compatibilidade de configurações e o restante do trabalho
  local. Nenhuma migração irreversível de settings é necessária.

## Tests and validation

### Nesta fase de proposta

- Inspeção estática das fontes listadas e comparação com o backlog.
- Conferência de cobertura dos IDs atualmente construídos pelo menu.
- Inspeção de `entriesForTab()` e `entriesForBar()` e dos testes existentes:
  Fechar todas já existe na área vazia e falta no contexto de uma aba;
  registrado como requisito da futura implementação, sem alteração de código.
- Não executar build ou testes de aplicação para uma mudança apenas documental.
- Nenhum teste com pessoas foi realizado; ganhos de descoberta são hipóteses.

### Durante a implementação aprovada

- Seguir as camadas de Testing em AGENTS.md, começando por `npm run build` e
  testes Rust pelo wrapper MSVC neste host, depois os testes de UI pertinentes
  ao inventário acima. Executar as verificações obrigatórias da política do
  repositório; usar o runner para preparar fixtures e instâncias corretamente.
- Validar que todo item exposto tem handler real; os IDs e atalhos existentes
  seguem aceitos, e menus reconstruídos não perdem ligações ou estado.
- Conferir checkmarks, indisponibilidade com motivo, dialeto, somente leitura,
  foco em campos e abas, ações atrasadas e seleção preservada.
- Em `scripts/document-tabs-test.mjs`, conferir os nomes, a presença e a
  disponibilidade da família completa de fechamento no menu principal e no
  contexto de uma aba; conferir também o conjunto previsto para a área vazia.
  Testar primeira, intermediária e última aba, uma única aba e mistura de
  documentos com e sem alterações, incluindo aba clicada diferente da ativa.
- Executar Fechar todas pelos três acessos e comprovar o mesmo alcance,
  inclusive fechar a aba clicada e a ativa. Após sucesso, deve restar somente
  o novo documento vazio previsto pelo ciclo de vida, com a janela aberta.
- Validar Fechar outras abas sem alterações nos três acessos: somente as
  candidatas sem alterações fecham e a referência permanece aberta.
- Usar a cobertura de `scripts/p0-lifecycle-test.mjs` para o novo acesso do
  contexto da aba a Fechar todas: Salvar, Descartar, Cancelar, cancelamento
  do seletor Salvar como, falha de gravação e digitação durante a decisão.
  Cancelamento/falha deve preservar todas as abas e seu texto; salvamentos
  já concluídos podem permanecer, mas não pode haver descarte parcial.
- Validar a operação do contexto com mouse e Shift+F10/Menu, fechamento do
  menu por Escape e retorno de foco; não depender somente do ID closeAll
  aparecer em algum dos menus.
- Testar matemática vazia e selecionada nos formatos suportados; formatação
  com undo e bytes matemáticos preservados; reset de zoom sem mudar largura.
- Inspecionar menus em Windows e Linux, janela estreita, escala de 100% e
  150%/200%, mouse e teclado, com documentos Markdown, HTML, Typst e AsciiDoc.
- macOS: preservar convenções de menu nativo e validar onde houver ambiente
  disponível; registrar honestamente qualquer plataforma não verificada.
- Confirmar que F5/Ctrl+R continuam impedindo reload destrutivo da aplicação.
- Registrar traps apenas se os três critérios de AGENTS.md forem atendidos.

### Resultados da implementação e validação (2026-10-25)

- `npm run build`, `npm run lint`, `npm run format:check` e `npm run knip`
  passaram. `cargo clippy --all-targets -- -D warnings` passou.
- `node scripts/test-all.mjs --only rust --no-build`: **140 passed, 2 ignored**
  (Windows). Os testes novos de menu cobrem estado, disponibilidade, labels e
  a regra de não reabilitar linhas de exportação/recentes.
- `npm test -- --only menu --no-build`: **87/87**. A suíte nova verifica as oito
  categorias, posicionamento, rótulos, disponibilidade por idioma/modo/seleção,
  deep links, Open Tabs, favoritos, reset de zoom, equação em bloco, colar sem
  formatação, Fechar todas pelos dois acessos e cancelamento de lote sujo.
- Também passaram: `npm run smoke` **108/108**, `npm run tabs` **107/107**,
  `npm run favorites` **56/56**, `npm run shortcuts` **43/43**,
  `npm run format:document` **141/141**, `npm run p0:lifecycle` **34/34** e
  `npm run recent` **26/26** numa instância recém-lançada. A primeira execução
  de `recent-menu` numa instância não isolada viu 12 de 27 linhas e passou no
  relançamento limpo; o sintoma e a causa provável estão nos Traps do AGENTS.md.
- Inspeção manual no Windows: inventário real do menu, Open Tabs, link sob o
  cursor, deep links de Preferências, colar sem formatação, disponibilidade em
  Markdown/Typst/AsciiDoc/HTML, ambos os acessos a Fechar todas e cancelamento
  com buffer sujo.
- Linux (WSL2, Debian 13 trixie): `bash scripts/build-linux.sh --bundles deb`
  produziu o `.deb` (12 MB) e o binário (19 MB). `cargo test` nativo passou
  **139 passed, 2 ignored**. A árvore GTK nativa foi inspecionada por captura:
  as oito categorias e os submenus Export, Close Tabs, Open Tabs, Zoom, Code
  Colors, Paragraph Style, Lists e Alert Block mostram os rótulos, checks e
  estados de disponibilidade esperados. O conteúdo WebKit não pôde ser
  capturado/focado de forma confiável no WSLg, então a interação de conteúdo no
  Linux não foi validada; não houve erro de menu observado.
- Não verificado: macOS, janela estreita e escalas 150%/200%; o host não tem
  Typst instalado, então a prévia Typst foi validada apenas no estado
  desabilitado com o motivo `needs Typst`. Tree test e teste de tarefas com
  pessoas não foram executados; os ganhos de descoberta continuam hipóteses.

### Validação de descoberta

Fazer um tree test com os rótulos antes de programar a árvore, seguido de
teste de tarefas na interface implementada. Incluir pessoas habituadas a
Markdown e pessoas com experiência em editores comuns; não medir só quem
já conhece o aplicativo. Usar documentos temporários para testes destrutivos.

Tarefas: inserir imagem; criar tabela; aplicar título; converter em lista;
concluir tarefa; inserir equação; formatar código-fonte; colar sem formatação;
fechar outras abas; fechar todas pelo contexto de uma aba e cancelar diante
de alterações não salvas; favoritar; trocar idioma da revisão; mostrar páginas Typst;
salvar PDF; voltar ao texto do código-fonte a partir da prévia.

Registrar primeiro menu escolhido, sucesso sem ajuda, tempo até a ação e
tentativas em categorias erradas. Comparar com a árvore atual, alternando a
ordem entre participantes para reduzir aprendizado. Um pequeno grupo fornece
evidência formativa, não comprovação estatística da superioridade da proposta.

Critério preliminar: pelo menos 80% das tarefas essenciais encontradas sem
ajuda, queda de escolhas de categoria errada frente à árvore atual e nenhum
erro de alvo que altere outro documento. Revisar o limiar com o perfil dos
participantes antes de tratar o resultado como aceitação definitiva.

## Acceptance criteria

- A barra tem as oito categorias propostas, com adaptação do menu do app no macOS.
- Toda ação atual tem destino documentado ou alias de compatibilidade; não
  desaparecem formatos personalizados, referências, licenças ou ações nativas.
- Imagens, links, tabelas e equações são encontrados em Inserir; estilos,
  títulos e listas em Formatar; temas e paletas em Exibir.
- As operações existentes promovidas da tabela têm execução real e consistente
  por menu, contexto e atalho quando aplicável.
- Fechar todas as abas está disponível no menu principal, no contexto de uma
  aba e no da área vazia, incluindo com uma única aba, e tem o mesmo alcance
  e fluxo de fechamento cancelável nos três caminhos.
- Outras, esquerda/direita e outras sem alterações usam a aba ativa no menu
  principal e a clicada no contexto da aba; disponibilidade e nomes refletem
  a matriz. A área vazia preserva suas ações globais e não adota uma aba
  clicada inexistente como referência.
- Cancelar ou falhar ao salvar durante Fechar todas mantém todas as abas do
  lote abertas e conserva seu texto; o sucesso mantém a janela aberta com
  o novo documento vazio do comportamento atual.
- O usuário consegue distinguir mostrar a estrutura de inserir um sumário,
  mostrar Favoritos de favoritar e gerar PDF de imprimir pelo navegador.
- A disponibilidade informa o contexto atual e não oferece ações sem efeito.
- Colar em campos e comandos de abas inativas continuam respeitando seus alvos.
- Restaurar zoom preserva a largura e as fontes-base; equação em bloco aproveita a seleção
  e preserva a expressão; a documentação descreve o comportamento real.
- Atalhos atuais permanecem operantes e coerentes com a ajuda, sem capturas
  indevidas de Tab/Shift+Tab ou reativação de reload destrutivo.
- Nenhuma das funções futuras aparece como implementada por esta entrega.
- Validação automatizada e observações manuais são registradas; a avaliação
  de descoberta distingue hipóteses, resultados e limitações da amostra.

## Open questions

- **Idioma dos rótulos:** decidido em 2026-10-25: manter inglês. Tradução
  completa segue GAP-024.
- **Oito categorias:** decidido manter as oito categorias; Navegar e
  Ferramentas continuam no tree test como hipóteses de descoberta.
- **Formato da primeira entrega:** decidido entregar a reorganização, os
  acessos às operações existentes, a matriz completa de disponibilidade e os
  dois ajustes explícitos; funções futuras continuam fora do escopo.
- **Prioridade dos incrementos novos:** mantida a lista de incrementos
  posteriores; Salvar todos, abertura rápida e paleta não entram nesta entrega.
- **Atalhos novos:** decidido não introduzir atalhos novos; os atalhos atuais
  permanecem e Ctrl+P continua reservado para decisão futura.
- **Menu contextual menor:** nesta entrega apenas se acrescenta o endereço
  principal; a redução de itens fica para uma validação posterior.

### Decisões aprovadas em 2026-10-25

- **Favoritos:** `Add to/Remove from Favorites` fica em Arquivo, junto de
  Mostrar na pasta; Exibir > Barra lateral > Favoritos apenas mostra o painel.
- **Rótulos:** Find e Find and Replace ficam sem reticências; as ocorrências
  passam a ser Find Next/Find Previous; a impressão usa
  `Print (opens browser)…`; o idioma da revisão usa `Spelling Language…`; a
  prévia Typst usa Document/Pages, como os botões existentes.
- **Zoom (desvio):** o trabalho concorrente de preview zoom implementou um zoom
  de documento. A barra usa `View › Zoom` com `Zoom In/Out/Reset`, mantém os IDs
  e atalhos e fica disponível em todos os modos; `Reset Zoom` altera somente
  `zoomLevel`, não `editorMaxWidth` nem as fontes-base. O rótulo original
  `Editor Text Size` foi substituído.
- **Metadados:** o rótulo é dinâmico (`YAML Front Matter` em Markdown,
  `Document Attributes` em AsciiDoc) e o item fica indisponível em HTML/Typst.
- **Abas abertas:** submenu nativo dinâmico, com a aba ativa marcada. A lista
  de sessões é a fonte; não é um quick open com busca.
- **Disponibilidade:** matriz completa, incluindo idioma, somente leitura,
  seleção, link sob o cursor, posição da aba e presença de caminho. A seleção
  é sincronizada com debounce e o handler continua validando o contexto.
- **Colar sem formatação:** entra no menu Editar, usando a Clipboard API; as
  imagens continuam seguindo as regras de paste existentes.
- **macOS:** implementação condicional de Preferences/About/Quit no menu do
  aplicativo. Não há ambiente macOS para validação nesta máquina; isso deve ser
  registrado na validação.
- **Preferências:** `Review Language…`, `Fonts and Reading…` e
  `Configure Export…` abrem a seção correspondente do painel existente.
- **Estado e rebuild:** o último estado do menu e a lista de abas ficam
  cacheados no lado Rust, para que um rebuild de Export/Open Recent não perca
  checks, disponibilidade nem a lista de abas.

### Referências de design

As recomendações de agrupamento, rótulos orientados a tarefas, profundidade
pequena e caminhos alternativos para ações contextuais são compatíveis com
as seguintes fontes primárias. A árvore específica do MDraft é uma proposta
derivada da inspeção do produto, não uma prescrição dessas fontes.

- [Microsoft: Menus and context menus](https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/menus-and-context-menus).
- [GNOME HIG: Menus](https://developer.gnome.org/hig/patterns/controls/menus.html).
- [Microsoft: Windows 7 Menus, orientação clássica](https://learn.microsoft.com/en-us/windows/win32/uxguide/cmd-menus)
  — usar os princípios de organização com a ressalva de que os exemplos e
  parte das convenções são históricos.

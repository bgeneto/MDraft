# Corrigir referências Markdown antigas com barras Windows

**Status:** done (approved 2026-11-05; completed 2026-11-06)

**Date:** 2026-11-05

**ADR:** [resolução conservadora de imagens locais legadas](../adr/2026-11-06-legacy-local-image-resolution.md).

## Context and goal

Uma imagem gerada como `![x](C:\Users\reader\.codex\pictures\x.png)` perde o separador antes de `.codex` quando o parser interpreta `\.` como escape Markdown. O mesmo acontece com outros caracteres de pontuação e pode afetar caminhos relativos e UNC. A geração de novas referências pela importação de imagens foi corrigida em `src/image-syntax.ts`, duplicando as barras literais antes de escrever Markdown. Isso não reescreve nem conserta documentos antigos. A conversão de colagem rica também possui um gerador próprio em `src/paste/render-markdown.ts`.

O objetivo é fazer referências antigas afetadas funcionarem quando houver evidência suficiente sobre o caminho pretendido, mantendo a interpretação Markdown existente em casos ambíguos, e impedir que a colagem rica gere novas referências equivalentes incorretas.

## Scope and non-scope

Inclui imagens Markdown inline e por referência, caminhos Windows absolutos e relativos, nomes iniciados por ponto ou outra pontuação válida, colagem rica, prévia e exportações afetadas. Inclui testes de segurança, Unicode, espaços, percent-encoding e arquivos inexistentes.

Não altera automaticamente o texto em disco, não muda outras linguagens, não amplia permissões do asset protocol nem enfraquece o sanitizador. Não faz buscas especulativas pela rede nem tenta automaticamente um candidato UNC que possa iniciar uma nova conexão. Um conserto de todos os links Markdown, uma migração em massa e mudanças no esquema de preferências estão fora de escopo.

## Approach and rejected alternatives

Para colagem rica, reutilizar uma função interna única de serialização de destino que preserve barras literais e os contratos de títulos, espaços, parênteses, URLs e preferência de escape. Testar o Markdown gerado por meio do parser e da prévia, não apenas comparando uma string.

Para documentos existentes, preservar a interpretação padrão do parser como primeira opção. Investigar com tokens reais do `marked` se a referência original permite extrair um candidato Windows literal sem alterar os offsets nem confundir código, URLs, HTML bruto ou escapes intencionais. Quando houver um único candidato local seguro e o destino padrão falhar, tentar no máximo esse candidato, somente no Windows e sem conexão de rede adicional. Se o destino padrão funcionar, ele prevalece. O candidato deve seguir as mesmas restrições de `convertFileSrc`; não tornar dados do documento uma nova permissão. O texto original permanece intacto. A identificação deve cobrir também definições de referência; se a informação necessária não sobreviver ao parser, definir um mecanismo testável e seguro, documentá-lo e parar para revisão antes de adotar uma heurística ampla.

Uma barra seguida de pontuação é sintaticamente ambígua: `\.` pode ser escape Markdown intencional ou separador Windows. Portanto, substituir globalmente barras antes do parser, preferir sempre o caminho literal, ou regravar documentos foram rejeitados. Também não se deve confiar apenas na existência do arquivo para justificar uma tentativa em compartilhamento remoto. Se não for possível resolver uma forma sem risco e sem desviar do contrato, manter o comportamento e apresentar uma correção explícita ao usuário em vez de tentar adivinhar.

## Steps

- [x] Reproduzir com arquivos reais a divergência entre parser e sistema de arquivos; criar fixtures em pastas `.codex`, `.images` e com outra pontuação, incluindo a colisão em que os dois destinos existem. Os demais caracteres de pontuação foram exercitados no parser.
- [x] Mapear o caminho dos tokens no worker, no fallback síncrono, na colagem rica e nos exportadores; definir como conservar a fonte sem perder offsets ou enfraquecer a sanitização.
- [x] Corrigir o gerador de colagem rica e testar URLs, títulos, espaços, parênteses, barras já escapadas e imagens locais. A geração compartilha agora o escape de barras com a importação de imagens; oito casos de round-trip foram adicionados.
- [x] Implementar somente o fallback local inequívoco descrito acima; preservar prioridade do destino Markdown padrão, limitar tentativas e não fazer tentativas UNC adicionais.
- [x] Testar preview, links de imagem e exportação com o arquivo presente, ausente, ambos os candidatos presentes e ambos ausentes; verificar que o texto, undo/redo e autosave não mudam.
- [x] Executar os testes relevantes Windows e Linux, medir custo com muitas imagens e registrar compatibilidade, resultados e limitações; concluir o plano apenas com os critérios satisfeitos.

## Files and modules

- `src/paste/render-markdown.ts`, `src/image-syntax.ts`: serialização consistente de imagens e destinos, sem alterar os demais formatos.
- `src/preview-render.ts`, `src/markdown.ts`, `src/export-paths.ts` ou adaptadores diretamente necessários: preservar a referência original, resolver fallback e manter exportação consistente; alterar somente os pontos comprovadamente necessários.
- `src-tauri/src/documents.rs`, `src-tauri/src/lib.rs`, `src/api.ts`: o adaptador conservador `resolve_legacy_local_image(primary, candidate, documentPath) -> Option<String>` precisa distinguir unidade fixa local de unidade mapeada e recusar componentes com reparse point antes de consultar os candidatos. A checagem frontend de prefixo não consegue assegurar a ausência de acesso de rede. Em plataformas que não sejam Windows o comando devolve `None`; o contrato antigo `path_exists` permanece intacto.
- `scripts/image-rules-test.mjs`, `scripts/paste-convert-test.mjs`, `scripts/preview-dom-test.mjs`, testes de exportação e `AGENTS.md`: regressões e documentação.
- Auditoria e eventual ADR: registrar a semântica, limites e rollback.

## Risks and rollback

Um caminho ambíguo pode apontar para dois arquivos reais; o destino Markdown válido sempre tem precedência. Um fallback remoto pode criar atividade de rede; candidatos UNC não serão tentados automaticamente. Um atributo de diagnóstico na árvore pode ser forjado por HTML bruto; validar sua origem e o destino sem ampliar a CSP ou a lista de atributos perigosos. Se a segurança ou a fidelidade não puderem ser demonstradas, desativar o fallback e manter a correção de geração independente. Não modificar arquivos do usuário em nenhuma etapa.

## Tests and validation

Testar barras absolutas/relativas, UNC sem acesso real à rede, componentes `.codex`, `.images`, `!draft` e nomes Unicode, caminhos com espaços/parênteses, URLs `https:`/`data:` e escapes Markdown intencionais. Cobrir `map` ligado/desligado, worker/fallback, referências diretas/definidas, imagens inline, colagem rica, print/export, arquivo ausente e destino padrão existente. Usar uma pasta temporária real no Windows para conferir `naturalWidth`, e Linux para garantir que nomes POSIX com barra invertida literal não sejam reinterpretados. Medir o custo de prévia e número de tentativas com muitas imagens; verificar que a mudança não introduz I/O no startup nem acessos remotos novos.

## Acceptance criteria

- Novas imagens produzidas pela colagem rica preservam o caminho completo após parse; URLs e preferências existentes continuam funcionando.
- Para os casos locais abrangidos, documentos antigos recuperam a imagem apenas quando o destino Markdown padrão falha e o candidato literal seguro é único. Se os dois destinos existem, prevalece o padrão; o arquivo de origem não é modificado.
- Não há segunda tentativa de rede nem expansão de permissões; imagens ausentes degradam sem loop, e exportação/print preservam o destino escolhido.
- Testes de segurança, mapeamento e regressão passam nas plataformas aplicáveis, com custo e limitações documentados.

## Open questions

- Se a compatibilidade de UNC antigo for necessária, qual interação explícita autoriza consultar o compartilhamento? Por padrão, não fazer tentativa adicional.
- Formas antigas ambíguas sem candidato local único devem continuar sendo mostradas como referência ausente; uma ferramenta de reparo explícita pode ser planejada separadamente.

## Execution notes

- Aprovação recebida em 2026-11-05. A colagem rica passou a compartilhar o escape de barras da importação de imagens; oito casos de parser cobrem caminhos Windows, UNC, POSIX, URL, espaços, parênteses e títulos.
- Uma inspeção direta do `marked` mostrou que o token de imagem conserva a forma bruta de uma referência inline, mas uma imagem por referência conserva somente `![x][id]`; o destino bruto aparece no token separado de definição.
- O renderer agora associa definições pelo destino interpretado somente quando o candidato é único e usa identificadores imprevisíveis para relacionar o HTML sanitizado à tabela interna. O backend aceita apenas unidades Windows fixas e componentes sem reparse point; o destino Markdown existente sempre prevalece. O teste real passou em 37/37 verificações, incluindo imagens inline, por referência e relativas, exportação HTML, ausência de arquivo, recusa de UNC e de junction. Colagem, unidade da prévia, worker, DOM e exportação genérica também passaram. A implementação recusa formas que não podem ser reconhecidas sem ambiguidade.
- Um microbenchmark sintético de 10.000 referências, sem DOM nem I/O, mediu três amostras quentes de 57,2–73,1 ms para caminhos comuns e 66,5–70,1 ms para candidatos legados. Não é medição de abertura, sistema de arquivos ou latência de interface. `node docs/audits/legacy-images-benchmark.mjs` reproduz a sonda.
- No aplicativo Windows, 100 imagens legadas repetidas carregaram com uma só chamada ao resolvedor local em 264 ms, após o teste solicitar explicitamente as imagens normalmente adiadas fora da tela. A suíte de regras passou em 39/39; o teste cobre precedência de destino válido ou corrompido, exportação HTML, arquivos ausentes e recusa de UNC/junction.
- A suíte final de imagens passou em 43/43 e também verificou a gravação automática, undo, redo e nova gravação do texto original no documento com caminhos legados. No Linux, o teste Rust cria um nome POSIX com barras invertidas literais e comprova que o fallback não o reinterpreta; não houve teste nativo de UI para essa forma específica. Referências UNC antigas e formas não reconhecidas continuam sem tentativa adicional.

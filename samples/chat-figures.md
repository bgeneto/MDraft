# Chat assistant figures

Synthetic fixtures for the figure renderer (`src/widgets/`). Each fenced block
below is written the way chat assistants emit figures. The unit suite
(`npm run widgets:unit`) and the GUI checks read the fences by position, so
add new cases at the end.

## 1. Template SVG

```svelte
<card gap={2}>
  <svg viewBox="0 0 340 445" width="100%">
    <rect x="5" y="4" width="330" height="173" rx="10" fill="#64748b" fillOpacity=".06" stroke="#94a3b8" strokeDasharray="4 3"/>
    <text x="16" y="20" fontSize="9" fontWeight="bold" fill="currentColor">INGESTION AND INDEXING</text>
    {#each ["Local files · Connectors","Parsers · OCR · Text extraction","Passage segmentation"] as s,i}
      <rect x="45" y={29+i*47} width="250" height="30" rx="5" fill="#64748b" fillOpacity=".13" stroke="#94a3b8"/>
      <text x="170" y={48+i*47} textAnchor="middle" fontSize="11" fill="currentColor">{s}</text>
      <path d={`M170 ${59+i*47} v13 m-4 -4 l4 4 4 -4`} fill="none" stroke="#94a3b8"/>
    {/each}
    <path d="M170 166 V181 H86 V192 M170 181 H254 V192" stroke="#94a3b8" fill="none"/>
    <rect x="12" y="192" width="149" height="55" rx="6" fill="#3b82f6" fillOpacity=".12" stroke="#3b82f6"/>
    <text x="86" y="212" fontSize="11" textAnchor="middle" fill="currentColor" fontWeight="bold">Lexical index</text>
    <text x="86" y="228" fontSize="9" textAnchor="middle" fill="currentColor">Full text + metadata</text>
    <rect x="179" y="192" width="149" height="55" rx="6" fill="#0d9488" fillOpacity=".12" stroke="#0d9488"/>
    <text x="254" y="210" fontSize="11" textAnchor="middle" fill="currentColor" fontWeight="bold">Semantic index</text>
    <text x="254" y="224" fontSize="9" textAnchor="middle" fill="currentColor">Sentence embeddings</text>
    <text x="254" y="237" fontSize="9" textAnchor="middle" fill="currentColor">384-dimensional vectors</text>
    <path d="M86 247 V262 H170 V273 M254 247 V262 H170" stroke="#94a3b8" fill="none"/>
    <rect x="50" y="273" width="240" height="35" rx="6" stroke="#94a3b8" fill="#64748b" fillOpacity=".1"/>
    <text x="170" y="287" fontSize="11" textAnchor="middle" fill="currentColor" fontWeight="bold">Hybrid retrieval and ranking</text>
    <text x="170" y="300" fontSize="9" textAnchor="middle" fill="currentColor">Score fusion</text>
    <path d="M170 308 V324 m-4 -4 l4 4 4 -4" stroke="#94a3b8" fill="none"/>
    <rect x="50" y="324" width="240" height="35" rx="6" stroke="#94a3b8" fill="#64748b" fillOpacity=".1"/>
    <text x="170" y="338" fontSize="11" textAnchor="middle" fill="currentColor" fontWeight="bold">Relevant passage selection</text>
    <text x="170" y="351" fontSize="9" textAnchor="middle" fill="currentColor">Sharing and permission controls</text>
    <path d="M170 359 V375 H85 V386 M170 375 H255 V386" stroke="#94a3b8" fill="none"/>
    <rect x="8" y="386" width="154" height="42" rx="6" stroke="#94a3b8" fill="#64748b" fillOpacity=".09"/>
    <text x="85" y="404" fontSize="11" textAnchor="middle" fill="currentColor" fontWeight="bold">Desktop search</text>
    <text x="85" y="418" fontSize="9" textAnchor="middle" fill="currentColor">Human user</text>
    <rect x="178" y="386" width="154" height="42" rx="6" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity=".12"/>
    <text x="255" y="404" fontSize="11" textAnchor="middle" fill="currentColor" fontWeight="bold">MCP / API / CLI</text>
    <text x="255" y="418" fontSize="9" textAnchor="middle" fill="currentColor">External agents</text>
  </svg>
</card>
```

## 2. Layout components

```
<box border radius="lg" padding={3} gap={1}>
  <box background="surface-secondary" radius="md" padding={2}>
    <text textAlign="center" weight="medium">User query</text>
  </box>
  <row justify="center"><icon name="arrow-down" color="secondary"/></row>
  <grid columns={2} gap={2}>
    <grid-item>
      <box border radius="md" padding={2} align="center">
        **Dense retrieval**
        <caption>Small embedding model</caption>
      </box>
    </grid-item>
    <grid-item>
      <box border radius="md" padding={2} align="center">
        **Lexical retrieval**
        <caption>BM25 full-text index</caption>
      </box>
    </grid-item>
  </grid>
  <row justify="center"><icon name="arrow-down" color="secondary"/></row>
  <box background="surface" border radius="md" padding={2} align="center">
    **Reciprocal Rank Fusion**
  </box>
  <row justify="center"><icon name="arrow-down" color="secondary"/></row>
  <box background="surface" border radius="md" padding={2} align="center">
    **Cross-encoder reranker**
    <caption>Multilingual reranking model</caption>
  </box>
  <row justify="center"><icon name="arrow-down" color="secondary"/></row>
  <box background="surface" border radius="md" padding={2} align="center">
    Per-file deduplication
  </box>
  <row justify="center"><icon name="arrow-down" color="secondary"/></row>
  <box background="surface-secondary" radius="md" padding={2} align="center">
    Ranked results
  </box>
</box>
```

## 3. Template SVG with a caption

```svelte
<card gap={2}>
  <svg viewBox="0 0 340 440" width="100%">
    <rect x="70" y="5" width="200" height="32" rx="5" stroke="#94a3b8" fill="#64748b" fillOpacity=".1"/>
    <text x="170" y="25" fontSize="11" textAnchor="middle" fill="currentColor" fontWeight="bold">Query + metadata filters</text>
    <path d="M170 37 V49 H58 V62 M170 49 V62 M170 49 H282 V62" fill="none" stroke="#94a3b8"/>
    {#each [{x:4,t:"BM25",d:"Exact terms"},{x:116,t:"Dense vectors",d:"Semantic matches"},{x:228,t:"Sparse vectors",d:"Learned lexical"}] as b}
      <rect x={b.x} y="62" width="108" height="44" rx="5" stroke="#3b82f6" fill="#3b82f6" fillOpacity=".09"/>
      <text x={b.x+54} y="80" fontSize="10" textAnchor="middle" fill="currentColor" fontWeight="bold">{b.t}</text>
      <text x={b.x+54} y="94" fontSize="8.5" textAnchor="middle" fill="currentColor">{b.d}</text>
      <path d={`M${b.x+54} 106 V120 H170 V132`} fill="none" stroke="#94a3b8"/>
    {/each}
    {#each [{t:"Weighted RRF",d:"100–200 candidate passages",c:"#3b82f6"},{t:"Cross-encoder reranker",d:"Top 20–40 passages",c:"#0d9488"},{t:"Deduplication + diversity",d:"MMR / document grouping",c:"#0d9488"},{t:"Context pruning",d:"Extract relevant sentences or tokens",c:"#d97706"},{t:"Context assembly",d:"Token budget + source references",c:"#64748b"},{t:"MCP / API response",d:"Ready for external agents",c:"#8b5cf6"}] as b,i}
      <rect x="42" y={132+i*51} width="256" height="39" rx="6" stroke={b.c} fill={b.c} fillOpacity=".09"/>
      <text x="170" y={147+i*51} fontSize="11" textAnchor="middle" fill="currentColor" fontWeight="bold">{b.t}</text>
      <text x="170" y={161+i*51} fontSize="9" textAnchor="middle" fill="currentColor">{b.d}</text>
      {#if i<5}<path d={`M170 ${171+i*51} v12 m-4 -4 l4 4 4 -4`} fill="none" stroke="#94a3b8"/>{/if}
    {/each}
  </svg>
  <caption>Proposed multistage retrieval pipeline. Candidate counts are illustrative tuning parameters.</caption>
</card>
```

## 4. Interactive block, drawn at its initial state

```
{@body const [chunks,setChunks]=DIL.useState(20)}
{@body const [chunkSize,setChunkSize]=DIL.useState("512")}
{@body const [retention,setRetention]=DIL.useState(50)}
{@body const total=chunks*Number(chunkSize)}
{@body const retained=Math.round(total*retention/100)}
<card gap={3}>
  <title>Context pruning simulator</title>
  <row>
    <label>Retrieved chunks</label>
    <spacer/>
    **{chunks}**
  </row>
  <slider min={5} max={100} step={5} value={chunks} onChange={setChunks}/>
  <label>Tokens per chunk</label>
  <segmented-control options={[{"label":"256","value":"256"},{"label":"512","value":"512"},{"label":"1024","value":"1024"}]} value={chunkSize} onChange={setChunkSize}/>
  <row>
    <label>Context retained after pruning</label>
    <spacer/>
    **{retention}%**
  </row>
  <slider min={10} max={100} step={5} value={retention} onChange={setRetention}/>
  <divider/>
  <caption>Original context</caption>
  <row align="center">
    <box flex={1} background="surface-tertiary" height={22} radius="sm"/>
    <text weight="medium" tabularNums={true}>{total.toLocaleString("en-US")}</text>
  </row>
  <caption>Pruned context</caption>
  <row align="center">
    <box flex={1}>
      <box background="#0d9488" width={`${retention}%`} height={22} radius="sm"/>
    </box>
    <text weight="medium" tabularNums={true}>{retained.toLocaleString("en-US")}</text>
  </row>
  <grid columns={2}>
    <grid-item>
      <caption>Tokens saved</caption>
      <title size="xl" color="success" tabularNums={true}>{(total-retained).toLocaleString("en-US")}</title>
    </grid-item>
    <grid-item>
      <caption>Context compression</caption>
      <title size="xl" tabularNums={true}>{(100/retention).toFixed(1)}×</title>
    </grid-item>
  </grid>
  <caption>Theoretical token savings, not a guarantee that answer accuracy will be preserved.</caption>
</card>
```

## 5. Plain SVG

```svg
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60" width="200" height="60">
  <defs>
    <linearGradient id="fade" x1="0" x2="1">
      <stop offset="0" stop-color="#3b82f6"/>
      <stop offset="1" stop-color="#8b5cf6"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="196" height="56" rx="8" fill="url(#fade)" fill-opacity="0.2" stroke="currentColor"/>
  <text x="100" y="36" text-anchor="middle" font-size="16" fill="currentColor">Plain SVG {braces stay}</text>
</svg>
```

## 6. Unsupported component (falls back with a reason)

```
<card>
  <tabs><tab>One</tab></tabs>
</card>
```

## 7. Svelte source code (stays code)

```svelte
<script>
  let count = 0;
</script>

<button on:click={() => count++}>Clicked {count} times</button>
```

## 8. JSX source code (stays code)

```jsx
export default function Card({ title }) {
  return <div className="card">{title}</div>;
}
```

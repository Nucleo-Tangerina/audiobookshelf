# CLAUDE.md — Fork Nucleo-Tangerina/audiobookshelf: "ABS Voice"

Fork de https://github.com/advplyr/audiobookshelf (upstream) mantido em
https://github.com/Nucleo-Tangerina/audiobookshelf.

Objetivo: dentro do próprio Audiobookshelf (ABS), transformar um PDF (ebook) em
audiobook usando TTS, na voz clonada do usuário, com trilha de fundo opcional
(modo "podcast") e leitura guiada (texto acompanhando o áudio).

Fluxo em uma frase:
`PDF no item -> extrai texto -> divide em capítulos/frases -> TTS externo (Voicebox) -> mixa trilha (opcional) -> audioFiles no MESMO library item + alignment.json -> leitor destaca o texto enquanto toca`.

---

## 0. Idioma: pt-BR primeiro

- Público-alvo é brasileiro. Idioma padrão de TTS e clonagem: português (pt-BR).
- Modelo da engine tem que suportar português E clonagem (Voicebox: Qwen3-TTS ou Chatterbox Multilingual). Validar sotaque brasileiro vs europeu no teste manual.
- Amostra de clonagem gravada em pt-BR (o modelo copia timbre e prosódia da amostra).
- Segmentação de frases respeita abreviações pt-BR (Sr., Sra., Dr., Prof., pág., nº, Av., Ltda., S.A.) e decimais com vírgula.
- Toda string nova da UI vai em `client/strings/en-us.json` E `pt-br.json`.

## 1. Regras do fork

- `master` espelha o upstream. Não commitar feature em `master`.
  - Sincronizar: `git fetch upstream && git checkout master && git merge --ff-only upstream/master && git push origin master`
  - Feature: `git checkout feat/tts-studio && git rebase master`
- Trabalho em branches `feat/*`. Commits pequenos, um por fase (ver seção 6).
- Antes do PR upstream: abrir Issue/Discussion em advplyr/audiobookshelf
  propondo a feature. Expectativa realista: pode ser recusado por escopo. O PR
  upstream deve ter só a Fase 1 (TTS básico, engine plugável). Clonagem de voz,
  trilha e leitura guiada podem ficar só no fork.
- Este CLAUDE.md não vai no PR upstream.
- Não quebrar nada existente: toda a feature fica desligada até o admin
  configurar `TTS_ENGINE_URL`.

## 2. Comandos

- Node 24 (Dockerfile `node:24-alpine`, `.devcontainer` VARIANT=24).
- Dev container: `.devcontainer/` (abrir no VS Code: "Reopen in Container").
- `npm run dev` — servidor (tsc `tsconfig.server.json` -> `dist-server/index.js --dev`).
- `npm run client` — build do client Nuxt (`client/`).
- `npm test` — build + mocha em `dist-server/test` (testes em `test/server/**`, mocha + chai + sinon).
- `npm run lint` — eslint.
- API docs: `docs/openapi.json` (adicionar as rotas novas aqui).

## 3. Engine TTS externa (fora do ABS)

Padrão: **Voicebox** (https://github.com/jamiepine/voicebox).
- MIT, FastAPI local, `docker compose up`, CPU funciona (mais lento), CUDA/ROCm/DirectML/MLX.
- Base URL `http://127.0.0.1:17493`, Swagger em `/docs`.
- Endpoints documentados no README: `POST /generate` (`{"text","profile_id","language"}`),
  `GET /profiles`, `POST /transcribe`, `POST /speak`.
- Clonagem zero-shot: 10–30 s de fala limpa (não usar < 5 s). Vários samples por perfil.
- Português: Qwen3-TTS e Chatterbox Multilingual (pt; pt-BR não citado explicitamente — testar sotaque).
- NÃO VERIFICADO: endpoint de criar perfil a partir de sample e formato da resposta
  de `/generate` (bytes WAV vs JSON com path). Conferir no Swagger `/docs` antes de codar o client HTTP.

Alternativa: **VoiceStudio/OmniVoice** (https://github.com/debpalash/VoiceStudio).
- AGPL-3.0 (cuidado ao acoplar), Docker `ghcr.io/debpalash/voicestudio:stable`, porta 3900,
  `OMNIVOICE_API_KEY` como bearer. Endpoints de TTS/clonagem não documentados — investigar antes.

GPU: depende do modelo, não da ferramenta. Sem GPU -> modelos pequenos
(Kokoro/LuxTTS/Piper) ou Qwen3 0.6B em CPU com lotes pequenos.

Contrato interno: o ABS fala com a engine por um adapter único
`server/utils/ttsEngine.js` com `listVoices()`, `createVoice(name, samplePaths)`,
`synthesize({ text, voiceId, language }) -> Buffer(wav)`. Trocar de engine = trocar o adapter.

Config (env, lida em `server/` junto das outras):
- `TTS_ENGINE_URL` (vazio = feature desligada, UI esconde os botões)
- `TTS_ENGINE_API_KEY` (opcional)
- `TTS_DEFAULT_LANGUAGE` (padrão `pt`)
- `TTS_ENGINE_MODEL_SIZE` (opcional, ex.: `0.6B`; Voicebox usa Qwen 1.7B por padrão, ~7 GB de RAM em CPU)
- Voicebox via `docker compose` publica na porta **17600** do host (não 17493)

## 4. Mapa do código ABS (pontos de encaixe)

Modelo a copiar: o fluxo do **encode-m4b**.

| Arquivo | Uso |
|---|---|
| `server/managers/AbMergeManager.js` | Padrão de task longa: `startAudiobookMerge` (:57) cria `Task`, `task.setData(action,...)`, `TaskManager.addTask`, roda sem await; progresso via `SocketAuthority.adminEmitter('task_progress', {libraryItemId, progress})`; `task.setFinished()` / `setFailed({text,key,subs})`; `cancelEncode` (:42); `getPendingTaskByLibraryItemId` (:32). |
| `server/managers/TaskManager.js` | `addTask` (:22), `taskFinished` (:32). Emite `task_started` / `task_finished`. |
| `server/objects/Task.js` | `setData` (:85), `setFailed` (:104), `setFinished` (:119). Action nova: `'tts-generate'`. |
| `server/routers/ApiRouter.js` | Rotas de tools em :303-306. Adicionar as novas ao lado. Managers instanciados em `server/Server.js:133`, expostos no router (:47). |
| `server/controllers/ToolsController.js` | `encodeM4b` (:29) valida isBook / sem task pendente; `middleware` (:159). Copiar para `generateTts` / `cancelTts`. |
| `server/models/Book.js` | `audioFiles` e `ebookFile` são colunas JSON. Ebook: `media.ebookFile.metadata.path`, `.ebookFormat`. |
| `server/scanner/LibraryItemScanner.js:29` | `scanLibraryItem(id)` — chamar no fim para registrar os novos audioFiles. |
| `server/managers/PodcastManager.js` | Exemplo de adicionar áudio sem rescan completo (`scanAddPodcastEpisodeAudioFile` :192, `Watcher.addIgnoreDir` :115). |
| `server/models/Podcast.js`, `PodcastEpisode.js` | Modelo podcast: 1 audioFile por episódio. |
| `server/utils/ffmpegHelpers.js` | `writeConcatFile` (:17), `mergeAudioFiles` (:447), `writeFFMetadataFile` (:276), `addCoverAndMetadataToFile` (:302). Usa `server/libs/fluentFfmpeg`. |
| `server/utils/globals.js:4` | `SupportedEbookTypes` (pdf já incluso). Servidor NÃO tem lib de PDF. |
| `client/pages/audiobook/_id/manage.vue` | UI de tools (botão Encode M4B :90, `encodeM4bClick` :352). Colocar a seção "Gerar audiobook (TTS)" aqui. |
| `client/store/tasks.js` + `client/layouts/default.vue:460-466` | Estado das tasks e listeners de socket. Reaproveitar `task_progress` — não criar evento novo. |
| `client/components/readers/PdfReader.vue` (`@teckel/vue-pdf`) e leitor EPUB | Onde entra a leitura guiada. |

## 5. Design das funcionalidades

### 5.1 PDF -> audiobook (Fase 1, candidata a PR upstream)
- Rota: `POST /api/tools/item/:id/tts` (body: `{ voiceId, language, chapterMode }`), `DELETE /api/tools/item/:id/tts` cancela. Admin/upload only, como encode-m4b.
- `server/managers/TtsManager.js`, mesma forma do AbMergeManager.
- Extração: `pdfjs-dist` (texto por página + outline/bookmarks). Única dependência nova do servidor.
  - Capítulos: outline do PDF se existir; senão blocos de N páginas (`chapterMode`).
  - Limpeza: remover cabeçalho/rodapé repetido, número de página, hifenização de quebra de linha.
  - PDF escaneado (sem texto) -> falhar com mensagem clara (OCR fora de escopo).
- Segmentação em frases (regex simples + limite de caracteres por chamada à engine).
- Para cada frase: `synthesize` -> WAV temporário em `MetadataPath/cache/tts/<itemId>/`. Concatenar por capítulo -> 1 arquivo `.m4b` ou `.mp3` por capítulo no diretório do item, nome `NN - Título.mp3`.
- Retomável: guardar no cache quais frases já foram geradas (hash do texto + voz). Reiniciar não regera.
- Progresso: frases concluídas / total -> `task_progress`.
- Fim: `LibraryItemScanner.scanLibraryItem(id)`. O item fica com ebook + audioFiles (ABS já suporta os dois).
- Concorrência: 1 task TTS por vez (fila), engine local costuma usar a GPU inteira.

### 5.2 Clonagem da minha voz (Fase 2)
- Página em Settings > "Vozes": upload/gravação (MediaRecorder no browser) de 10–30 s, nome da voz, `createVoice` no adapter. Lista via `listVoices()`.
- Guardar só o `voiceId` da engine + nome no ABS (tabela/setting simples). Os samples ficam na engine.
- Consentimento obrigatório: checkbox "esta é a minha voz e autorizo a clonagem". Bloquear sem ele. Só admin cria vozes.
- Seletor de voz no formulário da 5.1.

### 5.3 Trilha de fundo / modo podcast (Fase 3)
- "Biblioteca de trilhas": diretório `MetadataPath/tts-beds/` com upload no Settings (mp3/m4a/wav). Sem tabela nova; listar o diretório.
- Mix com ffmpeg por capítulo: trilha em loop (`-stream_loop -1`), volume baixo, ducking com `sidechaincompress` sob a voz, fade in/out, `-shortest` pela voz.
  Exemplo: `[1:a]volume=0.25[bed];[bed][0:a]sidechaincompress=threshold=0.05:ratio=8[duck];[0:a][duck]amix=inputs=2:duration=first`
- Saída "Podcast": em vez de audioFiles no livro, criar/usar item podcast numa library do tipo podcast, 1 episódio por capítulo (ver `PodcastManager.scanAddPodcastEpisodeAudioFile`). Com isso o feed RSS do ABS já funciona.
- Opção no formulário: `output: 'audiobook' | 'podcast'`, `bed: <arquivo> | null`, `bedVolume`.

### 5.4 Leitura guiada (Fase 4)
- Interpretação: texto acompanhando o áudio (read-along), a frase atual destacada e com rolagem automática. Clicar numa frase pula o áudio para ela.
- Custo baixo: o TTS é gerado frase a frase, então a duração de cada WAV já dá o timestamp. Sem STT.
- Gravar `tts/alignment.json` no item: `[{ chapter, audioIno, start, end, page, text }]`.
- Client: componente `ReadAlong.vue` que lê o alignment e escuta o `currentTime` do player global. Primeira versão mostra o texto extraído (não o PDF renderizado), porque destacar no PDF exige mapear coordenadas — fica para depois.
- Endpoint: `GET /api/items/:id/tts/alignment`.

## 6. Fases / ordem de entrega

0. Teste manual (antes de codar): `docker-compose` com ABS + Voicebox, PDF de 10 páginas -> MP3 via script. Medir tempo CPU vs GPU, anotar no README do fork.
1. Adapter `ttsEngine.js` + `TtsManager` + rotas + botão/progresso em `manage.vue`. Testes mocha: extração/segmentação e manager com engine mockada (sinon).
2. Vozes + clonagem.
3. Trilhas + mix + saída podcast.
4. Leitura guiada.

Cada fase: testes em `test/server/...`, rotas em `docs/openapi.json`, strings em `client/strings/en-us.json` (+ `pt-br.json`).

## 7. docker-compose de dev (esboço)

```yaml
services:
  audiobookshelf:
    build: .
    ports: ["13378:80"]
    environment:
      TTS_ENGINE_URL: http://voicebox:17493
    volumes: [./data/audiobooks:/audiobooks, ./data/config:/config, ./data/metadata:/metadata]
  voicebox:
    # conferir imagem/porta/GPU no docker-compose.yml do repo jamiepine/voicebox
    build: https://github.com/jamiepine/voicebox.git
    ports: ["17493:17493"]
    # GPU NVIDIA: deploy.resources.reservations.devices [{driver: nvidia, count: all, capabilities: [gpu]}]
```

## 8. Limites e cuidados

- Voz clonada: só a voz de quem consentiu. Nunca expor criação de voz a usuário não-admin.
- Direitos autorais: gerar áudio de PDF é para uso pessoal na própria biblioteca. Não publicar feed podcast público de obra protegida.
- Não bloquear o event loop: extração de PDF grande e ffmpeg rodam assíncronos/streams.
- Falha no meio da task -> limpar temporários (igual `removeTask` do AbMergeManager), manter o cache de frases para retomar.

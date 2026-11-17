# Stronger local models as judges of term sense

Date: 2026-11-15. Verdict: **rejected**. No local model comes close to Haiku. The best, Qwen3-8B
with thinking, reaches AUC 0.82 at 24 s per item. Haiku scores 0.99.

## Question

[Clustering triage](cluster-triage.md) found that embeddinggemma cannot tell a term's senses
apart. Can a stronger local model do it, either as a judge or as an embedding for triage? Three
kinds of model were candidates:

- models that compare a word in context with a definition, as our entry's `meaning` is one;
- models trained to tell word senses apart;
- larger general embedding models.

## Method

The same 205 reference items as before, with 32 real uses, 16 pairs, and 5 mixed pairs. Each
item's word is the first whole-word match on its line that is outside backticks, plural included.
It is marked `[[…]]` inside its paragraph; when the paragraph does not hold the line, the line is
appended. Everything runs on an Apple M5 with 24 GB, through node-llama-cpp (qmd's copy) or
PyTorch on the CPU.

| Kind                    | Model                                                                      | Score                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Reranker                | Qwen3-Reranker 0.6B (Q8, qmd's), 4B (Q8), 8B (Q6_K)                        | P(yes) for the passage against `Concept "<label>": <meaning>`, under two custom instructions (`a`, `b`)         |
| Local LLM judge         | Qwen3-4B-Instruct-2507 (Q8), Qwen3-8B (Q8), Qwen3-14B (Q4_K_M)             | P(yes) as the first answer token, using the reference labellers' instructions for one item                      |
| Local LLM judge, thinks | Qwen3-8B (Q8)                                                              | The same, after up to 384 greedy reasoning tokens                                                               |
| Gloss cross-encoder     | GlossBERT (`kanishka/GlossBERT`, BERT-base, trained on SemCor)             | P(match) for the context with the word in quotes against `<word> : <label>: <meaning>`                          |
| Gloss bi-encoder        | UCREL BEM, English and multilingual base (`ucrelnlp/PyMUSAS-Neural-*-BEM`) | Similarity of the word's token embedding to the definition's embedding                                          |
| Word-in-context encoder | XL-LEXEME (`pierluigic/xl-lexeme`, XLM-R large)                            | Cosine between the word in context and the label in `<label>: <meaning>`; also its target embeddings for triage |
| General embedding       | Qwen3-Embedding 4B (Q8) and 8B (Q6_K), plain and with a sense instruction  | Cosine to the meaning; also its embeddings for triage                                                           |

The original BEM checkpoint of Blevins and Zettlemoyer (2020) could not be tested: its Google
Drive link returns 404, and no copy is on Hugging Face.

## Results

As judges ([sense-models/results.md](sense-models/results.md); baselines from the earlier
experiments):

| Judge                       | AUC  | AUC within mixed pairs | Best accuracy | Hidden at recall 1.0 | ms/item |
| --------------------------- | ---- | ---------------------- | ------------- | -------------------- | ------- |
| Never flag                  | —    | —                      | 0.84          | —                    | —       |
| Haiku                       | 0.99 | 0.97                   | 0.99          | 0.99                 | —       |
| Qwen3-8B, thinking          | 0.82 | 0.76                   | 0.85          | 0.48                 | 24,475  |
| Jev 1.14, prompt 2          | 0.78 | 0.54                   | 0.85          | 0.00                 | ~160    |
| GlossBERT                   | 0.76 | 0.84                   | 0.88          | 0.13                 | 133     |
| Qwen3-8B, no thinking       | 0.68 | 0.74                   | 0.88          | 0.17                 | 768     |
| Qwen3-Reranker-8B           | 0.68 | 0.74                   | 0.84          | 0.17                 | 681     |
| Qwen3-Reranker-4B           | 0.66 | 0.72                   | 0.84          | 0.11                 | 360     |
| Qwen3-4B-Instruct-2507      | 0.65 | 0.63                   | 0.86          | 0.04                 | 421     |
| Qwen3-Reranker-0.6B         | 0.64 | 0.76                   | 0.84          | 0.13                 | 78      |
| Qwen3-14B, no thinking      | 0.61 | 0.78                   | 0.89          | 0.10                 | 1,456   |
| Qwen3-Embedding-8B, meaning | 0.56 | 0.69                   | 0.86          | 0.02                 | —       |
| XL-LEXEME, meaning          | 0.51 | 0.76                   | 0.84          | 0.09                 | 268     |
| embeddinggemma, meaning     | 0.49 | 0.61                   | 0.86          | 0.00                 | —       |
| UCREL BEM, multilingual     | 0.49 | 0.54                   | 0.84          | 0.21                 | 66      |
| UCREL BEM, English          | 0.37 | 0.38                   | 0.84          | 0.00                 | 64      |

"Hidden at recall 1.0" is the share of false alarms below the lowest-scored real use. That is
what a filter could drop without losing a real finding. Rerankers show their better instruction.

For triage, k-means within each pair, Haiku's verdict on each cluster's representative, and
items below a similarity cut-off sent to Haiku as well. The cut-off was swept in steps of 0.02
([sense-models/sweeps/](sense-models/sweeps)):

| Embedding                          | Recall at 15% of calls | Calls for recall 0.97 | Calls for recall 1.00 |
| ---------------------------------- | ---------------------- | --------------------- | --------------------- |
| embeddinggemma (qmd)               | 0.87                   | 31%                   | 58%                   |
| XL-LEXEME, target word             | 0.91                   | 62%                   | 90%                   |
| Qwen3-Embedding-4B                 | 0.85                   | 41%                   | 68%                   |
| Qwen3-Embedding-4B, sense instruct | 0.94                   | 24%                   | 65%                   |
| Qwen3-Embedding-8B                 | 0.88                   | 41%                   | 68%                   |
| Qwen3-Embedding-8B, sense instruct | 0.88                   | 84%                   | 84%                   |

Recall counts 32 real uses, so one item moves it by 0.03. The sweep is noisy, because k-means
reseeds as the cut-off changes.

**Where they fail.** The local LLM judges fail in the same two places:

- **Tool entries** (`Fleet`, `Agent`, `Script`, `Session`, `Task`, `Schedule`, `Search`): these
  give most false alarms. Without thinking, Qwen3-8B scores the everyday uses there at 0.47 to
  0.88 on average, so it reads "the fleet" or "a script" as naming a tool whose meaning says
  "The tool that …". Thinking brings Session, Schedule, Task, and Script to 0.15 or below, but
  Fleet stays at 0.72 and Agent at 0.50.
- **Limit window**: these give most missed real uses. Its 13 real uses, "limits" and "quotas"
  such as the heading "Limits", average 0.24 or less for both runs of Qwen3-8B.

GlossBERT errs differently. It flags "thesaurus" for the terms file (0.74) and "heading" for
section (0.79).

## Conclusion

- **No local judge.** The best local judge, Qwen3-8B with thinking, ranks at AUC 0.82 and hides
  only 48% of false alarms at full recall, at about 24 s per item. Without thinking, models from
  0.6B to 14B score 0.61 to 0.68. Size does not help: 14B scores below 8B.
- **Definition-aware models are no better.** Gloss models (GlossBERT, BEM) and the
  word-in-context encoder XL-LEXEME were trained on dictionary senses. They do not transfer to
  project concepts. GlossBERT is the best of them, at 0.76.
- **Embeddings still don't separate senses.** Similarity to the meaning stays between 0.49 and
  0.58 for every embedding model. In triage, Qwen3-Embedding-4B with a sense instruction reaches
  recall 0.97 with 24% of the calls. It still needs 65% of the calls for recall 1.00, so no model
  meets the bar of recall 0.99 below 30% of calls.
- The design stands: the check stays deterministic, and the calling agent judges sense on the
  occurrences a change check lists ([README.md](README.md)).

## Limits

- Haiku's labels came from one batch that saw all 207 items. The local judges see one item at a
  time, which is the setting a tool would use. Some of the gap may come from that difference
  rather than from model size.
- Each model was tried with one or two prompts. Instructions written for tool entries would
  likely help, but would be tuned to this dataset.
- Local models were quantised: 8B and 14B at Q8 and Q4_K_M, the rerankers at Q8 and Q6_K.

## Reproduce

Models go in `~/.cache/sense-models` (GGUF, from Hugging Face: `mradermacher/Qwen3-Reranker-*-GGUF`,
`Qwen/Qwen3-Embedding-*-GGUF`, `Qwen/Qwen3-8B-GGUF`, `Qwen/Qwen3-14B-GGUF`,
`unsloth/Qwen3-4B-Instruct-2507-GGUF`). Python runs need Python 3.12 virtual environments outside
the repository. XL-LEXEME needs `transformers<4.46`, `huggingface_hub<0.26`, `numpy<2`,
`scipy<1.14`, `sentence-transformers<3`, and `WordTransformer`, with `ignore_files=` patched to
`ignore_patterns=` in its `WordTransformer.py`. GlossBERT and BEM need `wsd-torch-models`.

```sh
cd docs/research/sense-models
node export-contexts.mjs           # contexts.json for the Python runs
./run-all.sh                       # rerankers, local judges, Qwen3 embeddings
THINK=384 node judge.mjs ~/.cache/sense-models/Qwen3-8B-Q8_0.gguf llm-qwen3-8b-think
python glossbert.py; python bem-ucrel.py [model]; python xl-lexeme.py
node emb-scores.mjs; node baselines.mjs; node evaluate.mjs > results.md
EMB=$PWD/emb-xl-lexeme.json RADII=0.40,0.42,… node ../cluster-triage/analyse.mjs
```

| File             | Holds                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| `common.mjs`     | Item loading, the word's span and its marking                            |
| `rerank.mjs`     | Qwen3-Reranker with a custom instruction                                 |
| `judge.mjs`      | A local instruct LLM as a yes/no judge, optionally thinking              |
| `glossbert.py`   | GlossBERT                                                                |
| `bem-ucrel.py`   | UCREL BEM                                                                |
| `xl-lexeme.py`   | XL-LEXEME scores and target embeddings                                   |
| `emb-scores.mjs` | Similarity to the meaning for each embedding file                        |
| `baselines.mjs`  | Haiku, Jev, and embeddinggemma as score files                            |
| `evaluate.mjs`   | The judge table                                                          |
| `scores/`        | One score per item and judge                                             |
| `sweeps/`        | `cluster-triage/analyse.mjs` output per embedding, cut-offs 0.40 to 0.98 |
| `results.md`     | `evaluate.mjs` output                                                    |

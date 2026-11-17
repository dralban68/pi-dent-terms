# Research

Experiments that inform the design of the `Terms` tool. They are non-normative: a finding enters
the tool only through a change to `specs/`.

| Experiment                               | Date       | Question                                                        | Verdict  |
| ---------------------------------------- | ---------- | --------------------------------------------------------------- | -------- |
| [Jev as a judge](jev-term-sense.md)      | 2026-11-14 | Can a cheap probabilistic model judge a term's sense?           | Rejected |
| [Clustering triage](cluster-triage.md)   | 2026-11-14 | Can clustering cut the LLM calls needed to judge sense?         | Rejected |
| [Stronger local models](sense-models.md) | 2026-11-15 | Can a stronger local model judge sense, or embed it for triage? | Rejected |

## Findings

All three experiments judge one question: does a matched word in prose name the concept its entry
defines, or is it the everyday word? They use the same 205 reference items, with 32 real uses,
taken from the terms files of five repositories.

1. **Judging sense needs an LLM.** Haiku was right on 0.99 of items. Jev's best accuracy at any
   threshold, 0.86, barely beats never flagging (0.84). Text matching alone cannot make this
   call, and neither can a local model: the best, Qwen3-8B with thinking, reaches AUC 0.82 at
   24 s per item. Rerankers, gloss models, and 4B to 14B judges without thinking score 0.61 to
   0.76.
2. **Embeddings do not tell senses apart.** With qmd's embedding model (embeddinggemma-300M),
   the similarity between an item and its entry's meaning ranks real uses at chance (AUC 0.49).
   Clusters within a pair of a word and an entry follow the topic, not the sense. Qwen3-Embedding
   4B and 8B and the word-in-context encoder XL-LEXEME score 0.51 to 0.58.
3. **Clustering is a weak triage.** Judging one representative per cluster is about as accurate
   as judging random items on the same budget, with 3 to 8 points more recall. Matching Haiku's
   recall still takes about 45% of the calls for 0.97 and 70% for 1.00. The best embedding,
   Qwen3-Embedding-4B with a sense instruction, reaches 0.97 at 24% but needs 65% for 1.00.
4. **Most occurrences are easy.** In 12 of 16 pairs every occurrence has the same answer. One
   call per pair, on the item nearest the pair's embedding centre, scores 0.927 with 8% of the
   calls. The cost is in pairs whose occurrences mix both senses.
5. **Cost tracks change, not corpus.** A check against a change set
   ([terms.md](../../specs/terms.md), Section 5.4) lists only the label occurrences in changed
   lines. Judging those, and caching each verdict by entry and normalised line text, keeps LLM
   cost in proportion to the size of an edit. That beats any triage of the whole corpus.

## Consequences for the design

- The check stays deterministic and offline. Judging sense is the calling agent's job: the
  change check hands it the label occurrences with each entry's meaning, and that hand-off is
  the integration point.
- No embedding model or probabilistic judge goes into the library.
- A fast k-means such as [e-means](https://e-means.github.io/) is not needed at any scale tested.
  It becomes relevant only for discovering concepts, that is, clustering 10⁶ or more phrases
  that have no entry, which is untested.

## Open questions

- Does Haiku keep its 0.99 when it judges one item at a time, as a tool would? Its labels came
  from one batch of all items.
- How common are mixed-sense pairs in a larger corpus? This needs a dataset with at least 50
  items per mixed pair.
- Can clustering propose useful new entries or merges across repositories? This is the
  concept-discovery pilot.

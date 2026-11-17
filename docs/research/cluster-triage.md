# Clustering as a triage for term-sense judgement

Date: 2026-11-14. Status: pilot; clustering rejected as a sense triage with qmd's embedding model.

## Question

[Jev as a judge of term sense](jev-term-sense.md) found that telling a real use of a registered
term from an everyday use of the same word needs an LLM: Haiku was right on 0.99 of items. At
the size of an organisation, with millions of occurrences, one LLM call per occurrence gets
expensive. Does clustering cut the cost? The idea is to embed each occurrence in context,
cluster the occurrences of each pair of a phrase and an entry, judge one representative per
cluster with the LLM, and give its verdict to the rest of the cluster. A fast k-means such as
[e-means](https://e-means.github.io/) matters only if this works.

## Method

1. **Items.** These are the 205 items of the Jev experiment on which the two reference labellers
   agree. They hold 32 real uses and 16 pairs of a phrase and an entry, with at most 14 items per
   pair. Twelve pairs are uniform: all their items have one answer. Five pairs are mixed,
   67 items in all, and they are the hard case.
2. **Embeddings.** The items are embedded exactly as qmd embeds a document. That means qmd's
   configured embed model (embeddinggemma-300M Q8, from `~/.config/qmd/index.yml`), qmd's
   `LlamaCpp`, and qmd's document format `title: <file> | text: <text>`. One embedding is of
   the item's paragraph, with the word marked `[[…]]`, and one is of the matched line. Each
   entry's meaning is embedded with its label as the title. The 205 items took 5.6 s on a
   laptop.
3. **Triage.** Within each pair:
   - k-means (cosine, k-means++, 25 Lloyd iterations) with `k = ⌈f·n⌉` clusters;
   - the item nearest each centroid is judged by Haiku's stored label, standing in for one LLM
     call;
   - every member of a cluster takes its representative's verdict.

   A radius variant judges directly any member whose cosine similarity to its representative is
   below a threshold.

4. **Baselines.**
   - Haiku on every item.
   - The same number of representatives chosen at random, each item taking the verdict of the
     nearest one.
   - One call per pair.
   - No LLM at all: the cosine similarity between the passage and the entry's meaning, scored as
     AUC.
5. All runs are averaged over 30 seeds. Accuracy and recall are measured against the reference
   labels; recall is the share of the 32 real uses that are flagged.

## Results

All 205 items:

| Judge                               | LLM calls | Accuracy | Recall |
| ----------------------------------- | --------- | -------- | ------ |
| Haiku on every item                 | 205       | 0.990    | 1.00   |
| One call per pair (nearest centre)  | 16 (8%)   | 0.927    | 0.91   |
| Clusters, k = 0.2n                  | 46 (22%)  | 0.934    | 0.84   |
| Random representatives, same budget | 46 (22%)  | 0.933    | 0.81   |
| Clusters, k = 0.5n                  | 104 (51%) | 0.967    | 0.94   |
| Random representatives, same budget | 104 (51%) | 0.957    | 0.86   |
| Clusters, k = 0.1n, radius 0.5      | 51 (25%)  | 0.939    | 0.92   |
| Clusters, k = 0.1n, radius 0.6      | 94 (46%)  | 0.963    | 0.97   |
| Clusters, k = 0.1n, radius 0.7      | 148 (72%) | 0.987    | 1.00   |

The 67 items of the mixed pairs:

| Judge                               | LLM calls | Accuracy | Recall |
| ----------------------------------- | --------- | -------- | ------ |
| One call per pair (nearest centre)  | 5 (7%)    | 0.776    | 0.91   |
| One random item per pair            | 5 (7%)    | 0.649    | 0.61   |
| Clusters, k = 0.2n                  | 15 (22%)  | 0.803    | 0.86   |
| Random representatives, same budget | 15 (22%)  | 0.784    | 0.78   |
| Clusters, k = 0.5n                  | 34 (51%)  | 0.904    | 0.94   |
| Clusters, k = 0.2n, radius 0.6      | 30 (45%)  | 0.897    | 0.97   |
| Clusters, k = 0.2n, radius 0.7      | 47 (71%)  | 0.952    | 1.00   |

Without an LLM, the similarity between the passage and the meaning has an AUC of 0.49 over all
items, which is chance. Within the mixed pairs, it varies from 0.00 ("search" against the
`Search` tool) to 0.93 ("root" against workspace root).

The paragraph and the matched line embed about equally well.

An earlier run embedded the same model through node-llama-cpp directly, with the
`task: clustering | query:` prefix. Its numbers differed by a few points, and its conclusion was
the same.

## Conclusion

- **Clustering is a weak prior on sense, not a judge.** Its accuracy is within 1 point of random
  representatives at the same budget, and its recall is 3 to 8 points higher, because real uses
  cluster a little apart from everyday ones. But recall reaches 0.97 only at about 45% of calls
  and 1.00 only at about 70%. A 300M embedding does not separate a term's two senses reliably,
  so a cluster verdict hides real findings.
- **Most of the saving needs no clustering.** Twelve of 16 pairs are uniform, so one call per
  pair, on the item nearest the pair's centre, already scores 0.927 at 8% of the cost. The hard part is the mixed pairs, where
  clustering at 22% of calls scores 0.80.
- **A fast k-means is irrelevant here.** Groups hold at most 14 items, and Lloyd finishes
  instantly. e-means would matter only for the discovery task below, at 10⁶ vectors or more.

At scale, two levers cost less than clustering:

1. **Incremental judgement.** A check against a change set ([terms.md](../../specs/terms.md),
   Section 5.4) already lists only the label occurrences in changed lines. Judging those alone
   makes the LLM cost grow with the size of a change, not the size of the corpus.
2. **A verdict cache.** Keep each verdict, keyed by the entry and the normalised line text, so
   that an unchanged line is never judged twice.

## Limits

- The data is small: 205 items, 67 of them mixed, and at most 14 per pair. The effect sizes are
  rough.
- One small embedding model was tried. A larger model, or one trained for sense (contextual
  word embeddings rather than passage embeddings), may separate senses better.
- Haiku's stored labels stand in for the representative calls. Real calls on representatives
  alone would see the same prompt, so this should hold.
- Only triage of known terms was tested. Discovering concepts, that is clustering candidate
  phrases across repositories to propose entries or merges, is the untested task where the
  scale argument for e-means applies.

## Next

1. Repeat with a stronger embedding model and with contextual embeddings of the matched word.
   Adopt clustering as a triage only if it reaches recall 0.99 below 30% of calls on the mixed
   pairs.
2. Build a larger mixed-sense dataset, harvested from every repository's terms file, with at
   least 50 items per mixed pair.
3. Run a discovery pilot. Cluster the noun phrases across all repositories with no entry, then
   measure the precision of the proposed entries and merges under LLM review. Use Faiss k-means,
   which ships e-means in `faiss.contrib`, once the corpus passes 10⁶ phrases.

## Data

`cluster-triage/`:

- `embed.mjs` writes `emb.json`, the embeddings. They are left out of the repository and take
  about 6 s to regenerate.
- `analyse.mjs` prints `results.txt`.

Both scripts read the items and labels in `jev-term-sense/`. `embed.mjs` needs qmd installed
globally; it loads qmd's own `LlamaCpp`.

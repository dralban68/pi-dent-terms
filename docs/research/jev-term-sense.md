# Jev as a judge of term sense

Date: 2026-11-14. Status: rejected for now.

## Question

Can TypeSafe AI's Jev, a "System One" model that answers typed questions with calibrated
probabilities and never writes text, tell when a matched phrase in prose really names a
registered concept? A model that could would let the `Terms` tool rate P001 and P002 findings
and hide the ones that are false alarms, such as an everyday word that is spelled like a
deprecated tool name.

Jev is a poor fit for the other decisions in adding a term. It cannot write a label, a meaning,
or an owner. The key is defined by where a term is used, so it needs no model. Choosing among
existing entries fits Jev's `Choice`, but terms are added a few at a time by an agent that is
already a strong model. This experiment tests the one high-volume, closed-answer question.

## Method

1. **Items.** 16 pairs of a candidate wrong name and a registered entry, from the terms files of
   five repositories. Examples are "session" → the deprecated `Session` tool (pi-dent), "page" →
   application page (pi-dent-app), "limit" → limit window (purse), and "heading" → section
   (pi-dent-markdown). For each pair, the lines of Markdown that hold the word outside code blocks
   and code spans, plural included, case ignored. At most 14 per pair were sampled, 207 items in
   all, each with its paragraph as context.
2. **Reference labels.** For each item: does the word on that line name exactly the concept the
   entry's meaning defines? claude-opus-5-5 and gpt-6-astra labelled every item independently
   and agreed on 205 of 207. Those 205 are the reference: 32 real findings, 173 false alarms.
3. **Jev.** One request per item, with a `Noul` question and a two-option `Choice` (`concept`
   or `other`). The runs:
   - jev-1.14 and jev-1.13 with the first prompt: a JSON state holding the phrase, label,
     meaning, line, and passage.
   - jev-1.14 with the second prompt: the passage as state with the word marked `[[…]]`, and the
     meaning written into the question.
4. **Baseline.** claude-haiku-5-5 labelled the same items with the same instructions as the
   reference labellers.

## Results

| Judge              | AUC  | Accuracy at 0.5 | Precision / recall at 0.5 | Best accuracy, any threshold |
| ------------------ | ---- | --------------- | ------------------------- | ---------------------------- |
| Flag every match   | —    | 0.16            | 0.16 / 1.00               | —                            |
| Never flag         | —    | 0.84            | — / 0.00                  | —                            |
| Jev 1.14, prompt 1 | 0.66 | 0.28            | 0.18 / 1.00               | 0.84                         |
| Jev 1.13, prompt 1 | 0.68 | 0.30            | 0.18 / 1.00               | 0.85                         |
| Jev 1.14, prompt 2 | 0.78 | 0.67            | 0.28 / 0.69               | 0.86                         |
| Haiku              | 0.99 | 0.99            | 0.94 / 1.00               | 0.99                         |

AUC uses the `Noul` probability, except in the prompt 2 row, which uses the `Choice` probability
of `concept`; that row's `Noul` AUC is 0.76. AUC measures how well the scores rank real findings
above false alarms: 1.0 is perfect, 0.5 is chance.

**As a filter.** Using Jev 1.14 with prompt 2:

- To keep every real finding, the `Noul` threshold must be 0.24, which hides 24 of the 173 false
  alarms.
- To keep 90% of real findings, it hides 71 of them.

**Where Jev fails.** Jev is confidently wrong about plain uses of tool names. It gave 0.82 to
"the local fleet" and to "a search need not read every file", both of which name no tool. At
the 0.5 threshold, its accuracy per word was 0.00–0.21 for pi-dent's "session", "schedule",
"agent", "task", "search", "script", and "fleet". This is the class of false finding that pi-dent
hit in practice.

**Cost.** About 120k input tokens per run of 207 items, roughly US$0.005, with a median of about
160 ms per request.

## Conclusion

Jev is not worth adding to the `Terms` tool:

- Its best accuracy at any threshold barely beats never flagging.
- As a filter it either hides few false alarms or drops real findings.
- Its speed and price advantage matters at a volume the tool never reaches: a few findings per
  edit.
- A proprietary network model in the check would also make check results depend on a model
  version and the network. Today the check is deterministic and offline.

If false alarms on everyday words become a problem, the better option is an LLM-class judge,
which reached 0.99 accuracy here. It should run on request or in the agent, kept out of the
deterministic check.

## Limits

- The reference labels come from two models, not people. The labellers agreed on 99% of items
  and a spot check found no errors, but the labels are not human judgments.
- The sample is small: 205 items, 32 of them real findings.
- The items cover 16 pairs and five repositories. They may not represent other vocabularies.
- Only two prompt forms were tried. A third could do better, but the gap to the LLM baseline is
  large.

## Data

[jev-term-sense/](jev-term-sense/) holds:

| File                    | Contents                                                      |
| ----------------------- | ------------------------------------------------------------- |
| `items.json`            | The 207 items: repository, phrase, entry, file, line, passage |
| `labels-opus.json`      | Reference labels from claude-opus-5-5                         |
| `labels-astra.json`     | Reference labels from gpt-6-astra                             |
| `labels-haiku.json`     | Baseline labels from claude-haiku-5-5                         |
| `jev-1.14-prompt1.json` | Jev 1.14 with prompt 1: `noul`, `pConcept`, latency, tokens   |
| `jev-1.13-prompt1.json` | Jev 1.13 with prompt 1                                        |
| `jev-1.14-prompt2.json` | Jev 1.14 with prompt 2                                        |

Requests went to `POST https://api.typesafe.ai/v1/systemone`.

// Embeds the items exactly as qmd embeds documents: qmd's configured embed model
// (~/.config/qmd/index.yml models.embed, else QMD_EMBED_MODEL, else qmd's default),
// qmd's LlamaCpp, and qmd's document format.
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const print = (...a) => process.stdout.write(a.join(" ") + "\n");
const { stdout: root } = await promisify(execFile)("npm", ["root", "-g"]);
const llmModule = `${root.trim()}/@tobilu/qmd/dist/llm.js`;
const { LlamaCpp, formatDocForEmbedding, resolveEmbedModel } = await import(llmModule);
const yml = `${process.env.HOME}/.config/qmd/index.yml`;
const configured = fs.existsSync(yml)
  ? /^models:\n(?:[ \t].*\n)*?[ \t]+embed:[ \t]*(\S+)/m.exec(fs.readFileSync(yml, "utf8"))?.[1]
  : undefined;
// EMBED_MODEL overrides, for runs with other models; OUT names the output file; INSTRUCT, for a
// Qwen3-Embedding model, embeds passages and lines as instructed queries.
const model =
  process.env.EMBED_MODEL ??
  resolveEmbedModel(configured === undefined ? {} : { embed: configured });
const llm = new LlamaCpp({ embedModel: model });
const items = JSON.parse(
  fs.readFileSync(new URL("../jev-term-sense/items.json", import.meta.url), "utf8"),
);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const instruct = process.env.INSTRUCT;
const embed = async (text, title, query = false) => {
  const input =
    query && instruct !== undefined
      ? `Instruct: ${instruct}\nQuery: ${text}`
      : formatDocForEmbedding(text, title, model);
  const r = await llm.embed(input);
  if (r === null) throw new Error("embedding failed");
  return r.embedding;
};
const out = { model, passage: [], line: [], meaning: {} };
const t0 = Date.now();
for (const it of items) {
  const marked = it.passage.replace(new RegExp(escape(it.phrase), "i"), (m) => `[[${m}]]`);
  out.passage.push(await embed(marked, it.file, true));
  out.line.push(await embed(it.matchLine, it.file, true));
  out.meaning[it.entryId] ??= await embed(it.meaning, it.label);
}
out.ms = Date.now() - t0;
fs.writeFileSync(process.env.OUT ?? new URL("emb.json", import.meta.url), JSON.stringify(out));
print("done", model, out.ms, "ms", out.passage[0].length, "dims");
await llm.dispose?.();
process.exit(0);

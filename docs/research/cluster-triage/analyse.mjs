import fs from "node:fs";
const print = (...a) => process.stdout.write(a.join(" ") + "\n");
const D = new URL("../jev-term-sense/", import.meta.url).pathname;
const items = JSON.parse(fs.readFileSync(D + "items.json"));
const L = (n) =>
  Object.fromEntries(
    JSON.parse(fs.readFileSync(D + `labels-${n}.json`)).map((x) => [x.id, x.refers]),
  );
const opus = L("opus"),
  astra = L("astra"),
  haiku = L("haiku");
const E = JSON.parse(fs.readFileSync(process.env.EMB ?? new URL("emb.json", import.meta.url)));
// RADII: comma-separated cosine similarities to the cluster representative below which an item
// also goes to the LLM; the defaults suit embeddinggemma.
const RADII = (process.env.RADII ?? "0.4,0.5,0.6,0.7").split(",").map(Number);
const norm = (v) => {
  const s = Math.hypot(...v);
  return v.map((x) => x / s);
};
const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const ref = items.filter((it) => opus[it.id] === astra[it.id]);
const truth = (id) => opus[id];
let seed = 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const groups = {};
for (const it of ref) (groups[it.entryId + "|" + it.phrase] ??= []).push(it);
function kmeans(V, k) {
  // cosine k-means++ , Lloyd 25 iters
  const n = V.length;
  const C = [V[Math.floor(rnd() * n)]];
  while (C.length < k) {
    const d = V.map((v) => Math.min(...C.map((c) => 1 - dot(v, c))));
    const s = d.reduce((a, b) => a + b, 0);
    let r = rnd() * s,
      i = 0;
    for (; i < n - 1; i++) {
      r -= d[i];
      if (r <= 0) break;
    }
    C.push(V[i]);
  }
  let a = [];
  for (let t = 0; t < 25; t++) {
    a = V.map((v) => {
      let b = 0,
        bv = -2;
      C.forEach((c, j) => {
        const x = dot(v, c);
        if (x > bv) {
          bv = x;
          b = j;
        }
      });
      return b;
    });
    for (let j = 0; j < k; j++) {
      const m = V.filter((_, i) => a[i] === j);
      if (!m.length) continue;
      C[j] = norm(m[0].map((_, d) => m.reduce((s, v) => s + v[d], 0)));
    }
  }
  return { a, C };
}
function run(kind, frac, which, radius) {
  // returns [calls, correct, total, recallReal, realTotal]
  let calls = 0,
    ok = 0,
    tot = 0,
    tp = 0,
    P = 0;
  for (const g of Object.values(groups)) {
    const V = g.map((it) => norm(E[which][it.id]));
    const n = g.length;
    const k = Math.max(1, Math.min(n, Math.ceil(frac * n)));
    let rep = Array.from({ length: n });
    if (kind === "cluster") {
      const { a, C } = kmeans(V, k);
      for (let j = 0; j < k; j++) {
        const m = [...Array(n).keys()].filter((i) => a[i] === j);
        if (!m.length) continue;
        const med = m.reduce((b, i) => (dot(V[i], C[j]) > dot(V[b], C[j]) ? i : b), m[0]);
        calls++;
        for (const i of m) {
          if (radius !== undefined && i !== med && dot(V[i], V[med]) < radius) {
            calls++;
            rep[i] = i;
          } else rep[i] = med;
        }
      }
    } else {
      const idx = [...Array(n).keys()];
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      idx.length = k;
      calls += k;
      for (let i = 0; i < n; i++)
        rep[i] = idx.reduce((b, j) => (dot(V[i], V[j]) > dot(V[i], V[b]) ? j : b), idx[0]);
    }
    for (let i = 0; i < n; i++) {
      const pred = haiku[g[rep[i]].id],
        t = truth(g[i].id);
      tot++;
      if (pred === t) ok++;
      if (t) {
        P++;
        if (pred) tp++;
      }
    }
  }
  return [calls, ok, tot, tp, P];
}
const avg = (f, R = 30) => {
  let s = [0, 0, 0, 0, 0];
  for (let r = 0; r < R; r++) {
    seed = r + 1;
    const x = f();
    s = s.map((v, i) => v + x[i]);
  }
  return s.map((v) => v / R);
};
const fmt = (name, [c, o, t, tp, P]) =>
  print(
    name.padEnd(34),
    "calls",
    c.toFixed(1).padStart(6),
    `(${((100 * c) / t).toFixed(0)}%)`.padStart(6),
    "acc",
    (o / t).toFixed(3),
    "recall",
    (tp / P).toFixed(2),
  );
print(
  "items",
  ref.length,
  "groups",
  Object.keys(groups).length,
  "real",
  ref.filter((i) => truth(i.id)).length,
);
for (const which of ["passage", "line"])
  for (const f of [0.1, 0.2, 0.3, 0.5]) {
    fmt(
      `cluster ${which} k=${f}n`,
      avg(() => run("cluster", f, which)),
    );
    fmt(
      `random  ${which} k=${f}n`,
      avg(() => run("random", f, which)),
    );
  }
for (const r of RADII)
  fmt(
    `cluster passage k=0.1n radius ${r}`,
    avg(() => run("cluster", 0.1, "passage", r)),
  );
// zero-LLM: similarity to meaning
const sc = ref.map((it) => ({
  s: dot(norm(E.passage[it.id]), norm(E.meaning[it.entryId])),
  t: truth(it.id),
  g: it.entryId + "|" + it.phrase,
}));
const auc = (a) => {
  const p = a.filter((x) => x.t),
    q = a.filter((x) => !x.t);
  let w = 0;
  for (const x of p) for (const y of q) w += x.s > y.s ? 1 : x.s === y.s ? 0.5 : 0;
  return w / (p.length * q.length);
};
print("meaning-similarity AUC global", auc(sc).toFixed(2));
const mixed = Object.keys(groups).filter((g) => {
  const t = groups[g].map((i) => truth(i.id));
  return t.includes(true) && t.includes(false);
});
for (const g of mixed) {
  const a = sc.filter((x) => x.g === g);
  print(
    " within",
    g.padEnd(40),
    "n",
    a.length,
    "real",
    a.filter((x) => x.t).length,
    "AUC",
    auc(a).toFixed(2),
  );
}
{
  let ok = 0;
  for (const it of ref) if (haiku[it.id] === truth(it.id)) ok++;
  print("haiku per item (direct)", ref.length, "calls acc", (ok / ref.length).toFixed(3));
}
fmt(
  "cluster k=1 (one call per pair)",
  avg(() => run("cluster", 0.0001, "passage")),
);
// mixed groups only
for (const g of Object.keys(groups)) if (!mixed.includes(g)) delete groups[g];
print(
  "--- mixed pairs only:",
  Object.values(groups).reduce((s, g) => s + g.length, 0),
  "items",
);
for (const f of [0.0001, 0.2, 0.3, 0.5]) {
  fmt(
    `cluster passage k=${f}n`,
    avg(() => run("cluster", f, "passage")),
  );
  fmt(
    `random  passage k=${f}n`,
    avg(() => run("random", f, "passage")),
  );
}
for (const r of RADII)
  fmt(
    `cluster k=0.2n radius ${r}`,
    avg(() => run("cluster", 0.2, "passage", r)),
  );

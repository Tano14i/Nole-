// Test automatici di Match Point Coach.
// Ogni test apre l'app con dati di prova e un orologio fissato, così i risultati non dipendono dal giorno in cui girano.
const { test, expect } = require("@playwright/test");

const BASE = {
  profile: { name: "", wake: "06:30", slot: "mattina", level: 0, why: "", start: "2026-10-19" },
  log: {}, setup: true, instDismiss: true, rem: { dismiss: true, ids: {}, on: false }
};

// apre l'app con uno stato iniziale e un'ora fissa; restituisce gli errori della pagina
async function open(page, { state = {}, time = "2026-10-21T08:00:00", colorScheme } = {}) {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|fonts\.g/.test(m.text())) errors.push(m.text()); });
  if (colorScheme) await page.emulateMedia({ colorScheme });
  await page.clock.install({ time: new Date(time) });
  const st = JSON.stringify({ ...BASE, ...state, profile: { ...BASE.profile, ...(state.profile || {}) } });
  // lo stato si scrive solo alla prima apertura: dopo un ricaricamento restano i dati salvati dall'app
  await page.addInitScript(s => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("nolecoach.v1", s); sessionStorage.setItem("seeded", "1"); } }, st);
  await page.goto("/index.html?test");
  return errors;
}
const timeline = page => page.$$eval(".task", x => x.map(t => t.querySelector(".time").textContent + " " + t.querySelector("h3").textContent.split(":")[0].trim()));

for (const colorScheme of ["light", "dark"]) {
  test(`si apre senza errori e senza scorrere di lato (tema ${colorScheme === "light" ? "chiaro" : "scuro"})`, async ({ page }) => {
    const errors = await open(page, { colorScheme });
    for (const tab of ["#t-oggi", "#t-sett", "#t-medita", "#t-tu"]) {
      await page.click(tab);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400);
    }
    await page.click("#t-sett");
    for (const pane of ["rec", "shop"]) await page.click(`[data-pane="${pane}"]`);
    expect(errors).toEqual([]);
  });
}

test("la giornata è in ordine e «Prossima azione» propone il pranzo (allenamento la sera)", async ({ page }) => {
  await open(page, { state: { profile: { slot: "sera" } }, time: "2026-10-21T13:05:00" });
  const t = await timeline(page);
  const mins = t.map(r => +r.slice(0, 2) * 60 + +r.slice(3, 5));
  expect([...mins].sort((a, b) => a - b)).toEqual(mins);
  await expect(page.locator("#nextTitle")).toContainText("Pranzo");
});

test("orari equilibrati in 96 combinazioni di sveglia, allenamento, digiuno e livello", async ({ page }) => {
  await open(page);
  const issues = await page.evaluate(() => {
    const M = window.__mpc, sat = M.parseKey("2026-10-24"), out = [];
    for (const wake of ["05:30", "06:30", "07:30", "08:30"]) for (const slot of ["mattina", "pranzo", "sera"])
      for (const fast of [false, true]) for (const level of [0, 2]) {
        const S = M.S; S.profile = { ...S.profile, wake, slot, fast, level, fastStart: "11:00", fastAnchor: "first" }; S.times = {};
        const p = M.buildDay(sat), T = p.tasks, label = `${wake} ${slot}${fast ? " 16:8" : ""} livello ${level}`;
        for (let i = 1; i < T.length; i++) if (T[i].t < T[i - 1].t) out.push(label + ": giornata fuori ordine");
        M.timeWarnings(p).forEach(w => out.push(label + ": " + w));
      }
    return out;
  });
  expect(issues).toEqual([]);
});

test("un pranzo salvato a 00:00 (12:00 AM) diventa 12:00 e resta prima di cena", async ({ page }) => {
  await open(page, { state: { profile: { wake: "07:00", fast: true, fastStart: "08:00" }, times: { pranzo: "00:00", snack: "13:00", train: "14:00" } }, time: "2026-10-21T06:49:00" });
  expect(await page.evaluate(() => window.__mpc.S.times.pranzo)).toBe("12:00");
  const t = await timeline(page);
  expect(t.indexOf("12:00 Pranzo")).toBeGreaterThan(-1);
  expect(t.indexOf("12:00 Pranzo")).toBeLessThan(t.findIndex(r => r.includes("Luci spente")));
});

test("digiuno 16:8: con l'ultimo pasto alle 18:00 il primo è alle 10:30, anche il giorno dopo", async ({ page }) => {
  await open(page, { state: { profile: { wake: "07:00", fast: true, fastAnchor: "last", fastEnd: "18:00" } } });
  const r = await page.evaluate(() => { const M = window.__mpc, FT = M.fastTimes(), p = M.buildDay(M.today());
    return { first: M.fmt(FT.first), last: M.fmt(FT.last), end: M.fmt(FT.end), next: M.fmt(FT.next),
      colaz: M.fmt(p.tasks.find(x => x.id === "colaz").t), cena: M.fmt(p.tasks.find(x => x.id === "cena").t) }; });
  expect(r).toEqual({ first: "10:30", last: "18:00", end: "18:30", next: "10:30", colaz: "10:30", cena: "18:00" });
  await expect(page.locator('[data-open="cena"] .sum')).toContainText("digiuno fino alle 10:30 di domani");
});

test("menù a rotazione: 56 piatti in 28 giorni, nessuna ripetizione prima di 10 giorni, ricette complete", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const M = window.__mpc, start = M.parseKey("2026-10-19"), seen = {}, distinct = new Set(), broken = [];
    let minGap = 99;
    for (let i = 0; i < 28; i++) {
      const d = M.addDays(start, i);
      ["colazione", "pranzo", "spuntino", "cena"].forEach(m => {
        const rec = M.rawRecipe(m, d), id = m + ": " + rec.t;
        distinct.add(id);
        if (seen[id] !== undefined) minGap = Math.min(minGap, i - seen[id]);
        seen[id] = i;
      });
    }
    for (const m in M.RECIPES) M.RECIPES[m].forEach(rec => {
      if (!(rec.n && rec.n.k > 0) || !rec.ing.length || !rec.steps.length) broken.push(rec.t + ": dati mancanti");
      Object.keys(rec.g || {}).forEach(k => { if (!M.ING[k]) broken.push(rec.t + ": ingrediente senza scheda " + k); });
    });
    return { distinct: distinct.size, minGap, broken };
  });
  expect(r.distinct).toBe(56);
  expect(r.minGap).toBeGreaterThanOrEqual(10);
  expect(r.broken).toEqual([]);
});

test("dosi scalate: pezzi interi, plurali corretti, noci del Brasile sempre 2–3", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => { const s = window.__mpc.scaleText;
    return [s("2 gallette di riso", 1.21), s("2 gallette di riso", 0.7), s("1 banana", 1.81), s("2–3 noci del Brasile", 1.81),
      s("1 spicchio d'aglio", 1.81), s("100 ml di latte di cocco", 1.21)]; });
  expect(r).toEqual(["2 gallette di riso", "1 galletta di riso", "2 banane", "2–3 noci del Brasile", "2 spicchi d'aglio", "120 ml di latte di cocco"]);
});

test("spesa: segue il menù della settimana, il vegetariano toglie il pesce, più proteine aggiunge lo yogurt di soia", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const M = window.__mpc, names = () => M.shopGroups().flatMap(g => g[1].map(i => i[1] + " = " + i[2]));
    M.setWeek(M.parseKey("2026-10-19")); const a = names();
    M.setWeek(M.parseKey("2026-10-26")); const b = names();
    M.S.profile.veg = true; M.S.profile.protein = true; const v = names();
    return { a, b, v };
  });
  expect(r.a.some(x => x.startsWith("Salmone"))).toBe(true);
  expect(r.b.some(x => x.startsWith("Merluzzo"))).toBe(true);
  expect(r.v.some(x => /^(Salmone|Branzino|Merluzzo|Gamberi)/.test(x))).toBe(false);
  expect(r.v.find(x => x.startsWith("Yogurt di soia"))).toContain("7 vasetti");
});

test("rituale del mattino: passi temporizzati e meditazione che parte da sola", async ({ page }) => {
  await open(page, { time: "2026-10-21T06:31:00" });
  await page.click('[data-open="wake"]');
  await page.click('[data-start="wake"]');
  await expect(page.locator("#ovMsg")).toContainText("acqua tiepida");
  await page.clock.runFor(46000);
  await expect(page.locator("#ovMsg")).toContainText("5 respiri");
  await page.clock.runFor(140000);
  await expect(page.locator("#ovDone")).toHaveText("Avvia la meditazione");
  await page.click("#ovDone");
  await expect(page.locator("#ovEyebrow")).toContainText("Inspira");
  expect(await page.evaluate(() => !!window.__mpc.S.log["2026-10-21"].wake)).toBe(true);
});

test("allenamento guidato: serie, recupero automatico e fine con spunta", async ({ page }) => {
  await open(page, { time: "2026-10-20T08:30:00" });
  await page.click('[data-open="train"]');
  await page.click('[data-start="train"]');
  await expect(page.locator("#ovEyebrow")).toHaveText("Esercizio 1 di 6 · serie 1 di 3");
  await page.click("#ovDone");
  await expect(page.locator("#ovTitle")).toHaveText("Recupero");
  await page.clock.runFor(61000);
  await expect(page.locator("#ovEyebrow")).toHaveText("Esercizio 1 di 6 · serie 2 di 3");
  for (let i = 0; i < 40 && (await page.textContent("#ovDone")) !== "Segna come fatto"; i++) await page.click("#ovDone");
  await page.click("#ovDone");
  await expect(page.locator('[data-check="train"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#rpeBanner")).toBeVisible();
});

test("«Ho mangiato altro»: il pasto conta come fatto e le calorie del giorno si aggiornano", async ({ page }) => {
  await open(page, { time: "2026-10-21T14:00:00" });
  await page.click('[data-open="pranzo"]');
  await page.click('[data-altopen="pranzo"]');
  await page.fill("#alt-text", "Pizza margherita");
  await page.click('[data-altsize="2"]');
  await page.click('[data-altsave="pranzo"]');
  await expect(page.locator('[data-check="pranzo"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-open="pranzo"] h3')).toContainText("Pizza margherita");
  await expect(page.locator("#kcalLine")).toContainText("1 pasto cambiato");
});

test("backup e ripristino riportano i dati dopo averli cancellati", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page, { state: { weights: { "2026-10-20": 78.4 }, journal: { "2026-10-20": { good: "Allenamento fatto" } } } });
  await page.click("#t-tu");
  await page.click("#bkCopy");
  let txt = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  if (!txt) txt = await page.inputValue("#bkOut");
  expect(JSON.parse(txt).app).toBe("match-point-coach");
  await page.evaluate(() => localStorage.removeItem("nolecoach.v1"));
  await page.reload();
  await page.click("#t-tu");
  await expect(page.locator("#wList li")).toHaveCount(0);
  await page.click("#bkOpen");
  await page.fill("#bkIn", txt);
  await page.click("#bkRestore");
  await page.click("#bkYes");
  await expect(page.locator("#wList li")).toHaveCount(1);
  await expect(page.locator("#jList")).toContainText("Allenamento fatto");
});

test("serie con jolly: un giorno storto a settimana non la azzera", async ({ page }) => {
  const all = { wake: 1, medam: 1, colaz: 1, train: 1, pranzo: 1, snack: 1, cena: 1, medpm: 1, sleep: 1 }, log = {};
  for (let d = 19; d <= 28; d++) log[`2026-10-${d}`] = d === 23 ? { wake: 1 } : { ...all };
  await open(page, { state: { log }, time: "2026-10-29T08:00:00" });
  await expect(page.locator("#hdr-streak")).toHaveText("9");
});

test("weekend: sveglia propria, e luci spente calcolate sulla sveglia del giorno dopo", async ({ page }) => {
  await open(page, { state: { profile: { wake: "06:30", wakeWE: "08:30" } } });
  const r = await page.evaluate(() => {
    const M = window.__mpc, at = (d, id) => { const p = M.buildDay(M.parseKey(d)); return M.fmt(p.tasks.find(x => x.id === id).t); };
    const warn = ["2026-10-23", "2026-10-24", "2026-10-25"].flatMap(d => M.timeWarnings(M.buildDay(M.parseKey(d))).map(w => d + ": " + w));
    return { venSveglia: at("2026-10-23", "wake"), venLuci: at("2026-10-23", "sleep"), sabSveglia: at("2026-10-24", "wake"),
      sabLuci: at("2026-10-24", "sleep"), domLuci: at("2026-10-25", "sleep"), warn };
  });
  expect(r).toEqual({ venSveglia: "06:30", venLuci: "00:30", sabSveglia: "08:30", sabLuci: "00:30", domLuci: "22:30", warn: [] });
});

test("allenamenti variati a settimane alterne, e ogni variante ha la spiegazione", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const M = window.__mpc, names = d => M.buildDay(M.parseKey(d)).tasks.find(x => x.id === "train").ex.map(e => e.n);
    return { a: names("2026-10-20"), b: names("2026-10-27") };
  });
  expect(r.a).toContain("Squat a corpo libero");
  expect(r.b).toContain("Squat sumo");
  expect(r.a).not.toEqual(r.b);
  // martedì 27: ogni esercizio si apre con passaggi, errore da evitare e versione più facile
  for (let i = 0; i < 6; i++) await page.click("#nextDay");
  await page.click('[data-open="train"]');
  await expect(page.locator(".details details.exd")).toHaveCount(6);
  await expect(page.locator(".details details.exd").first()).toContainText("Squat sumo");
  expect(await page.$$eval(".details .ex", x => x.filter(e => !e.closest("details")).length)).toBe(0);
});

test("il coach usa i tuoi dati: sonno corto e serie in corso", async ({ page }) => {
  const all = { wake: 1, medam: 1, colaz: 1, train: 1, pranzo: 1, snack: 1, cena: 1, medpm: 1, sleep: 1 }, log = {};
  for (let d = 19; d <= 20; d++) log[`2026-10-${d}`] = { ...all };
  await open(page, { state: { log, sleep: { "2026-10-21": 5 } }, time: "2026-10-21T12:00:00" });
  const lines = new Set();
  for (const h of ["12:00", "16:00", "20:00", "23:00"]) { await page.clock.setFixedTime(new Date(`2026-10-21T${h}:00`)); await page.evaluate(() => window.__mpc.render()); lines.add(await page.textContent("#coachLine")); }
  expect([...lines].some(l => l.includes("dormito 5 ore") || l.includes("giorni di fila") || l.includes("Ieri giornata vinta"))).toBe(true);
});

test("modalità minima: allenamento di 10 minuti, meditazione di 3, diario di una riga, e contano come fatti", async ({ page }) => {
  await open(page, { time: "2026-10-20T08:00:00" });
  await page.click("#t-tu");
  await page.check("#mn-on");
  const r = await page.evaluate(() => {
    const M = window.__mpc, p = M.buildDay(M.today()), tr = p.tasks.find(x => x.id === "train");
    return { dur: tr.dur, ex: tr.ex.length, maxSets: Math.max(...tr.ex.map(e => e.s[0])), med: p.tasks.find(x => x.id === "medam").dur };
  });
  expect(r).toEqual({ dur: 10, ex: 3, maxSets: 2, med: 3 });
  // nei giorni con esercizi a minuti il totale resta sui 10 minuti (giovedì: recupero attivo; sabato: resistenza)
  const minutes = await page.evaluate(() => ["2026-10-22", "2026-10-24", "2026-10-25"].map(d => {
    const tr = window.__mpc.buildDay(window.__mpc.parseKey(d)).tasks.find(x => x.id === "train");
    return tr.ex.filter(e => e.u === "min").reduce((a, e) => a + e.r[0], 0);
  }));
  minutes.forEach(m => expect(m).toBeLessThanOrEqual(10));
  // solo l'allenamento in versione minima: la meditazione torna completa
  await page.uncheck("#mn-med");
  expect(await page.evaluate(() => window.__mpc.buildDay(window.__mpc.today()).tasks.find(x => x.id === "medam").dur)).toBeGreaterThan(3);
  await page.click("#t-oggi");
  await page.click('[data-open="medpm"]');
  await expect(page.locator(".details .journal textarea")).toHaveCount(1);
  await page.fill("#j-good", "Ho fatto 10 minuti di allenamento");
  await page.click("[data-jsave]");
  await expect(page.locator('[data-check="medpm"]')).toHaveAttribute("aria-pressed", "true");
});

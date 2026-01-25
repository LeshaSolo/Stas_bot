// Telegram Sales Bot — Deno Deploy + Deno KV (no Google Sheets)
// Env var required: BOT_TOKEN
// Webhook endpoint: POST /webhook
//
// Commands:
// /start or /help
// /new          - start new shift (clear current session)
// /total        - show totals (incl. выдача/набор)
// /undo         - remove last line
// /setprice <name> <price>   - set price for item
// /setrates <issue> <pick>   - set issue/pick rates per chat

const BOT_TOKEN = Deno.env.get("BOT_TOKEN");
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN env var");

const kv = await Deno.openKv();

type Line = {
  name: string;
  qty: number;
  price: number;
  sum: number;
  ts: number;
};

const DEFAULT_PRICES: Record<string, number> = {
  // товары (стартовые)
  "кабель": 10,
  "кабель для мобильных устройств": 10,
  "видеоигры": 22.54,
  "микроволновая печь": 51.46,
  "конвектор": 33.25,
  "крепления для видеотехники": 14.94,
  "лампочки": 10,
  "карта памяти (flash)": 16.23,
  "монитор": 115,
  "мышь игровая": 22.69,
  "электрическая плитка": 22.09,
  "вентиляторы охлаждения": 13.69,
  "видеорегистратор": 50.22,
  "портативный аккумулятор": 14.99,
  "электрочайник": 17.18,
  "маршрутизатор": 51.32,
  "батарейки": 10,
  "набор инструментов для точных работ": 10,
  "термопаста и термоинтерфейс": 10,
  "электрощипцы": 15.17,
  "мультиварка": 43.65,
  "кофемолка": 18.43,
  "геймпад": 30.31,
  "мфу струйное": 115,

  // операции (не считаем как товары для выдачи/набора)
  "оплата наличными": 5,
  "проверка на битые пиксели": 300,
};

const ALIASES: Record<string, string> = {
  "видеоигра": "видеоигры",
  "микроволновка": "микроволновая печь",
  "роутер": "маршрутизатор",
  "мышка": "мышь игровая",
  "мфу": "мфу струйное",
  "аккум": "портативный аккумулятор",
  "чайник": "электрочайник",
};

const OPS = new Set<string>(["оплата наличными", "проверка на битые пиксели"]);

function norm(s: string) {
  return s.trim().toLowerCase();
}
function resolveName(raw: string) {
  const k = norm(raw);
  return ALIASES[k] ?? k;
}
function parseLine(text: string): { name: string; qty: number } | null {
  // поддержка: "кабель 5" / "кабель - 5" / "кабель: 5"
  const m = text.trim().match(/^(.+?)[\s:-]+(\d+)\s*$/);
  if (!m) return null;
  return { name: resolveName(m[1]), qty: Number(m[2]) };
}

async function tg(method: string, payload: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  // не падаем, но можно логировать
  await res.text().catch(() => "");
}

function keySession(chatId: number) {
  return ["session", chatId] as const;
}
function keyPrice(name: string) {
  return ["price", name] as const;
}
function keyRates(chatId: number) {
  return ["rates", chatId] as const;
}

async function getRates(chatId: number) {
  const r = await kv.get<{ issue: number; pick: number }>(keyRates(chatId));
  return r.value ?? { issue: 4.89, pick: 4.89 };
}
async function setRates(chatId: number, issue: number, pick: number) {
  await kv.set(keyRates(chatId), { issue, pick });
}

async function getPrice(name: string): Promise<number | null> {
  const fromKv = await kv.get<number>(keyPrice(name));
  if (typeof fromKv.value === "number") return fromKv.value;

  const p = DEFAULT_PRICES[name];
  return typeof p === "number" ? p : null;
}
async function setPrice(name: string, price: number) {
  await kv.set(keyPrice(name), price);
}

async function getSession(chatId: number): Promise<Line[]> {
  const cur = await kv.get<Line[]>(keySession(chatId));
  return cur.value ?? [];
}
async function setSession(chatId: number, arr: Line[]) {
  await kv.set(keySession(chatId), arr);
}
async function clear(chatId: number) {
  await setSession(chatId, []);
}
async function add(chatId: number, name: string, qty: number, price: number) {
  const sum = price * qty;
  const line: Line = { name, qty, price, sum, ts: Date.now() };
  const arr = await getSession(chatId);
  arr.push(line);
  await setSession(chatId, arr);
  return line;
}
async function undo(chatId: number) {
  const arr = await getSession(chatId);
  arr.pop();
  await setSession(chatId, arr);
}

async function calcTotal(chatId: number) {
  const rates = await getRates(chatId);
  const arr = await getSession(chatId);

  let sum = 0;
  let goodsQty = 0;

  for (const x of arr) {
    sum += x.sum;
    if (!OPS.has(x.name)) goodsQty += x.qty;
  }

  const issue = goodsQty * rates.issue;
  const pick = goodsQty * rates.pick;
  const grand = sum + issue + pick;

  return { sum, goodsQty, issue, pick, grand, tail: arr.slice(-20) };
}

function formatTotal(t: Awaited<ReturnType<typeof calcTotal>>) {
  const lines = t.tail
    .map((x) => `${x.name} × ${x.qty} = ${x.sum.toFixed(2)}`)
    .join("\n");

  return [
    `Товаров (шт): ${t.goodsQty}`,
    `Выдача: ${t.issue.toFixed(2)}`,
    `Набор: ${t.pick.toFixed(2)}`,
    `----------------`,
    `ИТОГО: ${t.grand.toFixed(2)}`,
    lines ? `\nПоследние:\n${lines}` : "",
  ].join("\n");
}

function helpText() {
  return [
    "Пиши: название количество",
    "Пример: кабель 5",
    "",
    "Команды:",
    "/new — новая смена",
    "/undo — отмена последней строки",
    "/total — итог",
    "/setprice <товар> <цена> — задать цену",
    "/setrates <выдача> <набор> — задать ставки",
  ].join("\n");
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // healthcheck
  if (req.method === "GET" && url.pathname === "/") {
    return new Response("ok");
  }

  if (req.method === "POST" && url.pathname === "/webhook") {
    const update = await req.json().catch(() => null);
    const msg = update?.message;
    const chatId: number | undefined = msg?.chat?.id;
    const text: string | undefined = msg?.text;

    if (!chatId || !text) return new Response("ok");

    const t = String(text).trim();

    try {
      if (t === "/start" || t === "/help") {
        await tg("sendMessage", { chat_id: chatId, text: helpText() });
        return new Response("ok");
      }

      if (t === "/new") {
        await clear(chatId);
        await tg("sendMessage", { chat_id: chatId, text: "Новая смена ✅" });
        return new Response("ok");
      }

      if (t === "/undo") {
        await undo(chatId);
        await tg("sendMessage", { chat_id: chatId, text: "Откатил последнюю строку ✅" });
        return new Response("ok");
      }

      if (t === "/total") {
        const tot = await calcTotal(chatId);
        await tg("sendMessage", { chat_id: chatId, text: formatTotal(tot) });
        return new Response("ok");
      }

      if (t.startsWith("/setrates")) {
        const m = t.match(/^\/setrates\s+([\d.,]+)\s+([\d.,]+)\s*$/);
        if (!m) {
          await tg("sendMessage", { chat_id: chatId, text: "Пример: /setrates 4.89 4.89" });
          return new Response("ok");
        }
        const issue = Number(m[1].replace(",", "."));
        const pick = Number(m[2].replace(",", "."));
        await setRates(chatId, issue, pick);
        await tg("sendMessage", { chat_id: chatId, text: `Ок. Выдача=${issue}, Набор=${pick}` });
        return new Response("ok");
      }

      if (t.startsWith("/setprice")) {
        const m = t.match(/^\/setprice\s+(.+?)\s+([\d.,]+)\s*$/);
        if (!m) {
          await tg("sendMessage", { chat_id: chatId, text: "Пример: /setprice кабель 10" });
          return new Response("ok");
        }
        const name = resolveName(m[1]);
        const price = Number(m[2].replace(",", "."));
        await setPrice(name, price);
        await tg("sendMessage", { chat_id: chatId, text: `Цена сохранена: ${name} = ${price}` });
        return new Response("ok");
      }

      // обычная строка: товар qty
      const parsed = parseLine(t);
      if (!parsed) {
        await tg("sendMessage", { chat_id: chatId, text: "Не понял. Пример: кабель 5" });
        return new Response("ok");
      }

      const price = await getPrice(parsed.name);
      if (price == null) {
        await tg("sendMessage", {
          chat_id: chatId,
          text: `Нет цены для: "${parsed.name}".\nДобавь: /setprice ${parsed.name} <цена>`,
        });
        return new Response("ok");
      }

      const line = await add(chatId, parsed.name, parsed.qty, price);
      await tg("sendMessage", {
        chat_id: chatId,
        text: `Ок: ${line.name} × ${line.qty} = ${line.sum.toFixed(2)}\n(/total)`,
      });
      return new Response("ok");
    } catch {
      return new Response("ok");
    }
  }

  return new Response("Not found", { status: 404 });
});

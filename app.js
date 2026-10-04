"use strict";
/* SPD Alarm Analyzer – application logic. Data: data.js (from the PDF), guidance: knowledge.js */
const D = window.SPD_DATA;
const KB = window.SPD_KB;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fill = (str, ctx) => str.replace(/\{(\w+)\}/g, (_, k) => ctx[k] ?? "—");
const locShort = (l) => l.replace(/^=PA01/, "") || "=PA01";

/* ───────────────────────── data preparation ───────────────────────── */
const cabLabel = (l) => {
  const parts = (D.locs[l] || "").split(" / ").slice(1);
  const code = locShort(l).split("+").pop();
  return parts.length >= 2 ? `${parts[0]} · ${code}` : (parts[0] || locShort(l)) + (code && parts.length ? ` · ${code}` : "");
};
// "EHA02+LVC03" → "E-House 02 · Low Voltage Cabinet 03" using the drawing's own legend
const locName = (code) =>
  code.split("+").filter(Boolean).map((p) => {
    const m = /^([A-Z]{2,3})(\d{0,2})$/.exec(p);
    return m ? (D.areas[m[1]] || m[1]) + (m[2] ? " " + m[2] : "") : p;
  }).join(" · ");

const norm = (s) => s.toLowerCase().replace(/o\.k\.?/g, "o.k").replace(/[^\p{L}\p{N}.:+\-\/]+/gu, " ");
const toks = (s) => norm(s).split(/\s+/).map((t) => t.replace(/^\.+|\.+$/g, "")).filter(Boolean);

const P = D.pages.map(([n, l, func, sub, sheet, total]) => {
  const txt = D.text[n - 1];
  return { n, l, func, sub, sheet, total, txt, low: (func + " " + sub + " " + locShort(l) + "\n" + txt).toLowerCase() };
});
// optional: the user manual index (manual.js); the tool works without it
const MAN = window.SPD_MANUAL || null;
const M = MAN ? MAN.pages.map(([n, sec, txt]) => ({ n, sec, txt, low: (sec + "\n" + txt).toLowerCase() })) : [];
const S = D.signals;
const df = new Map();
S.forEach((s, i) => {
  s.id = i;
  s.spare = !s.d || /^spare\b/i.test(s.d);
  s.low = norm([s.a, s.t, s.m, s.d, s.f || "", locShort(s.l), cabLabel(s.l), s.s != null ? "st" + s.s : "", s.k].join(" "));
  s.words = new Set(toks(s.d + " " + (s.f || "")));
  s.words.forEach((w) => df.set(w, (df.get(w) || 0) + 1));
});
const idf = (t) => Math.log(1 + S.length / (1 + (df.get(t) || 0)));

/* ───────────────────────── I/O signal search ───────────────────────── */
function scoreSignal(s, qt) {
  let num = 0, den = 0;
  for (const t of qt) {
    const w = idf(t);
    den += w;
    let m = 0;
    if (/^st\d+$/.test(t)) m = s.s === +t.slice(2) ? 1.4 : 0; // "st81" = Profibus station 81
    else if (s.a.toLowerCase() === t) m = 1.4;
    else if (s.a.toLowerCase().startsWith(t) && /\d/.test(t)) m = 0.8;
    else if (t.length >= 3 && s.t && s.t.toLowerCase().includes(t) && /[-+\d]/.test(t)) m = 1.1;
    else if (s.words.has(t)) m = 1;
    else if (t.length >= 3 && [...s.words].some((x) => x.startsWith(t))) m = 0.7;
    else if (t.length >= 3 && s.low.includes(t)) m = 0.5; // short tokens ("1", "2") must match a whole word, never a substring of a tag
    num += Math.min(m, 1) * w + Math.max(0, m - 1) * w * 0.5;
  }
  return den ? num / den : 0;
}
function searchSignals(q, { kind = "", cab = "", hideSpare = true, limit = 80 } = {}) {
  const qt = toks(q);
  const pool = S.filter((s) => (!kind || s.k === kind) && (!cab || s.l === cab));
  if (!qt.length) return { rows: pool.filter((s) => !(hideSpare && s.spare)).slice(0, limit).map((s) => ({ s, cov: 1 })), strict: true, total: pool.length };
  const qset = new Set(qt);
  let rows = pool.map((s) => {
    const cov = scoreSignal(s, qt);
    const dt = toks(s.d);
    const prec = dt.length ? dt.filter((t) => qset.has(t)).length / dt.length : 0;
    return { s, cov, score: cov + 0.3 * prec };
  }).filter((r) => r.cov >= 0.5);
  if (hideSpare && !/spare/i.test(q)) rows = rows.filter((r) => !r.s.spare);
  rows.sort((a, b) => b.score - a.score || a.s.id - b.s.id);
  const strict = rows.length > 0 && rows[0].cov >= 0.99;
  if (strict) rows = rows.filter((r) => r.cov >= 0.99);
  return { rows: rows.slice(0, limit), strict, total: rows.length };
}

/* ───────────────────────── signal interpretation ───────────────────────── */
function parseTag(s) {
  const t = s.t || "";
  const i = t.lastIndexOf("-");
  const locPart = i > 0 ? t.slice(0, i) : "", rest = i >= 0 ? t.slice(i) : t;
  const [device, pin] = rest.split(/:(.*)/s);
  let loc = s.l;
  if (locPart.startsWith("++")) loc = "=PA01" + locPart;
  else if (locPart.startsWith("+")) loc = (s.l.match(/^(=PA01(?:\+\+[A-Z0-9]+)?)/) || [, "=PA01"])[1] + locPart;
  return { device: device || "", pin: pin || "", loc, ext: !!locPart };
}
function pinMeaning(pin) {
  const m = /^(\d)(\d)$/.exec(pin);
  if (m) return +m[2] <= 2 ? `ขั้ว ${pin} → หน้าสัมผัสแบบ NC (ปกติปิด)` : `ขั้ว ${pin} → หน้าสัมผัสแบบ NO (ปกติเปิด)`;
  if (/^A[12]$/.test(pin)) return `ขั้ว ${pin} → ขดลวดรีเลย์/คอนแทคเตอร์ (PLC จ่าย 24V สั่งดึง)`;
  return pin ? `ขั้ว/สาย ${pin}` : "";
}
function interpret(s) {
  const d = s.d.toLowerCase();
  const pm = parseTag(s);
  const pinM = /^(\d)(\d)$/.exec(pm.pin);
  const nc = pinM && +pinM[2] <= 2;
  if (s.k === "DO") return { cls: "info", text: "เอาต์พุตคำสั่งจาก PLC (24 VDC) ไปขับขดลวดรีเลย์/อุปกรณ์ — ค่า 1 = PLC สั่งทำงาน" };
  if (s.k === "AI") return { cls: "info", text: "อินพุตอนาล็อก (ส่วนใหญ่ 4–20 mA หรือ PT100) — ค่าต่ำกว่าช่วง/Wire break ให้ดูค่าดิบของ PLC และกระแสจริงที่ลูป" };
  if (s.k === "AO") return { cls: "info", text: "เอาต์พุตอนาล็อกจาก PLC (4–20 mA / 0–10 V) ไปยังอุปกรณ์ปลายทาง" };
  if (/o\.?k\.?\b|released/.test(d))
    return { cls: "ok", text: "สัญญาณแบบ “สถานะปกติ”: ปกติ = 1 (มี 24 V) · ค่า 0 = ผิดปกติ/Alarm (เบรกเกอร์ทริป, สายขาด, ไฟเลี้ยงหาย หรืออุปกรณ์ไม่พร้อม)" + (nc ? " — หมายเหตุ: ขั้วนี้เป็นหน้าสัมผัส NC จึงควรยืนยันโลจิกจริงจากหน้าวงจร" : "") };
  if (/emergency|e-?stop/.test(d)) return { cls: "ok", text: "วงจรความปลอดภัยแบบ fail-safe: ปกติ = 1 · ค่า 0 = มีจุดตัดวงจรหรือปุ่มถูกกด" };
  if (/actuated|tripped|fault|blocked|alarm|too |exceed|overload|lifted/.test(d))
    return { cls: "warn", text: `สัญญาณแบบ “เตือน/ตรวจจับ”: โดยทั่วไป 1 = เงื่อนไขนี้เกิดขึ้น${nc ? " — แต่หน้าสัมผัสนี้เป็น NC จึงอาจกลับกัน (fail-safe)" : ""} · ยืนยันโลจิกจริงจากหน้าวงจร` };
  return { cls: "info", text: "ไม่สามารถสรุปโลจิก (NO/NC) จากชื่อสัญญาณ — ตรวจจากหน้าวงจรที่อ้างอิง" };
}

/* ─── generic troubleshooting for the I/O-signal tab (inferred from signal name & device type) ─── */
const SIG_KB = [
  { id: "mcb", label: "เบรกเกอร์ / MCB / CB", test: (s) => /\b(mcb|cb|breaker|fuse|vvf|fsd)\b/i.test(s.d) && /o\.?k/i.test(s.d),
    why: "สัญญาณมาจากหน้าสัมผัสช่วยของเบรกเกอร์/ฟิวส์ ปกติ = 1 เมื่อเบรกเกอร์ ON · เป็น 0 เมื่อทริป ถูกปิด หรือสายหน้าสัมผัสช่วยขาด",
    steps: ["ที่ตู้ ดูตำแหน่งคันโยกของ {dev} — ถ้าทริป อย่ารีเซ็ตทันที หาสาเหตุก่อน (โอเวอร์โหลด, ลัดวงจร, ฉนวนเสื่อม)",
            "ถ้าเบรกเกอร์ ON แต่ PLC ยังเห็น 0 → วัดที่ขั้วหน้าสัมผัสช่วย ({pin}) และที่ขั้วอินพุตโมดูล {mod} ว่ามี 24 VDC หรือไม่",
            "รีเซ็ตแล้วทริปซ้ำ → แยกโหลดทีละกิ่ง วัดฉนวน และเทียบกระแสกับพิกัดเบรกเกอร์ในหน้า Parts list"] },
  { id: "earth", label: "Earth fault 24 VDC", test: (s) => /earth fault/i.test(s.d),
    why: "ตัวตรวจ earth fault ของระบบควบคุม 24 VDC — ปกติ = 1 · เป็น 0 เมื่อฉนวนรั่วลงดิน หรือตัวตรวจไม่มีไฟเลี้ยง",
    steps: ["ดูไฟ/ค่าที่ตัวตรวจ {dev} ว่ารั่วขั้ว + หรือ − และระดับการรั่ว",
            "ถอดวงจรย่อย 24 VDC ออกทีละกิ่ง (ทีละ MCB FCxx) จนสัญญาณกลับปกติ เพื่อหาสายที่รั่ว",
            "ตรวจ JB / เซนเซอร์ที่เปียกหรือเต็มฝุ่น และสายเคลื่อนที่ (H07RN-F) ที่ถูกบดหรือขูด"] },
  { id: "estop", label: "วงจรหยุดฉุกเฉิน", test: (s) => /emergency|e-?stop/i.test(s.d),
    why: "วงจร E-Stop เป็น fail-safe: ปกติ = 1 · เป็น 0 เมื่อมีปุ่มถูกกด สายขาด หรือรีเลย์ความปลอดภัยไม่ปล่อย",
    steps: ["ตรวจปุ่ม E-Stop ที่ LCS / ห้องควบคุม / จุดอื่นในฟังก์ชันเดียวกัน — ดึงคืนตัวแล้วรีเซ็ต",
            "ถ้าไม่มีปุ่มถูกกด ให้ไล่วงจรอนุกรมตามหน้าวงจรที่อ้างอิง หาจุดเปิด (หน้าสัมผัส NC, กล่อง JB, สายขาด)",
            "ตรวจรีเลย์ควบคุม/ไฟเลี้ยง 24 VDC ของวงจรนั้น และ LED ช่องสัญญาณ {mod}"] },
  { id: "contactor", label: "คอนแทคเตอร์ / สถานะการทำงาน", test: (s) => /contactor|\bon\b/i.test(s.d) && s.k === "DI",
    why: "สัญญาณป้อนกลับจากหน้าสัมผัสช่วยของคอนแทคเตอร์ — 1 = ดึงเข้าแล้ว",
    steps: ["ตรวจว่า PLC สั่งออกแล้วหรือไม่ (ดูเอาต์พุต DO ในฟังก์ชันเดียวกัน) และอินเตอร์ล็อกครบ",
            "ถ้าสั่งแล้วแต่ไม่ดึง → วัดแรงดันขดลวด A1/A2 และตรวจเบรกเกอร์/โอเวอร์โหลดต้นทาง",
            "ถ้าดึงแล้วแต่ PLC ไม่เห็น → ตรวจหน้าสัมผัสช่วยและสายกลับมายังโมดูล {mod}"] },
  { id: "brake", label: "เบรก / การปลดเบรก", test: (s) => /brake/i.test(s.d),
    why: "วงจรเบรกมักมีทั้งคำสั่ง (DO) · เบรกเกอร์ · คอนแทคเตอร์ · สวิตช์ตรวจจับการปลดเบรก (lifted switch)",
    steps: ["ตรวจลำดับ: PLC สั่ง → คอนแทคเตอร์ดึง → ขดลวดเบรกได้ไฟ → เบรกปลด → lifted switch ตรวจจับ",
            "ตรวจระยะช่องว่าง (air gap) และการตั้งตำแหน่งเซนเซอร์/สวิตช์ตรวจจับการปลดเบรก",
            "ตรวจ rectifier/ขดลวดเบรก และเทียบกับสัญญาณอื่นในฟังก์ชันเดียวกัน (ดูรายการ “สัญญาณที่เกี่ยวข้อง”)"] },
  { id: "limit", label: "ลิมิต / พร็อกซิมิตี้ / เซนเซอร์ตำแหน่ง", test: (s) => s.k === "DI" && /limit|actuated|detection|sensor|switch|position|storm|clamp|calmps|lock/i.test(s.d),
    why: "เซนเซอร์ตำแหน่งหรือสวิตช์หน้างาน — โลจิก NO/NC ต้องดูจากหน้าวงจร",
    steps: ["ดู LED ของเซนเซอร์ที่หน้างาน/ลองทดสอบด้วยโลหะ (พร็อกซิมิตี้) และตรวจระยะตรวจจับกับการยึดแน่น",
            "วัดที่ขั้วอินพุตโมดูล {mod} เทียบกับ LED ช่องสัญญาณ แล้วเทียบกับค่าที่ PLC เห็น",
            "ตรวจกล่อง JB และสายเคเบิลเคลื่อนที่ (ถูกบด/น้ำเข้า) ตามเส้นทางในหน้า Cable overview / Terminal diagram"] },
  { id: "temp", label: "อุณหภูมิ / ฮีตเตอร์ / ระบบระบายความร้อน", test: (s) => /temperature|thermistor|heater|oilcooling|oil cooling|pt100|rtd|fan/i.test(s.d),
    why: "การตรวจจับความร้อนของมอเตอร์/เกียร์บ็อกซ์/น้ำมัน หรือสถานะฮีตเตอร์/พัดลม",
    steps: ["ตรวจอุณหภูมิจริงของอุปกรณ์ (เทอร์โมมิเตอร์อินฟราเรด) เทียบกับค่าที่ PLC อ่าน",
            "ถ้าเป็น thermistor/PT100 → วัดความต้านทานที่ขั้ว สายขาดจะอ่านค่าสูงสุดหรือ out-of-range",
            "ตรวจพัดลม/ระบบระบายความร้อน การระบายอากาศ และเบรกเกอร์ของฮีตเตอร์ในฟังก์ชันเดียวกัน"] },
  { id: "hyd", label: "ไฮดรอลิก / ความดัน / ระดับ / วาล์ว", test: (s) => /pressure|preassure|filter|valve|hydraul|\boil\b|level|pump/i.test(s.d),
    why: "สวิตช์ความดัน ระดับน้ำมัน ฟิลเตอร์อุดตัน วาล์ว หรือปั๊ม",
    steps: ["ตรวจระดับและความดันจริงด้วยเกจ เทียบกับค่าที่สวิตช์ตั้งไว้",
            "ตรวจฟิลเตอร์ (back flow filter), วาล์ว (ขดลวด/ไฟ 24 V) และปั๊ม/มอเตอร์ในฟังก์ชันเดียวกัน",
            "ตรวจหน้าสัมผัสสวิตช์/สายสัญญาณไปยังโมดูล {mod}"] },
  { id: "lube", label: "ระบบหล่อลื่น", test: (s) => /lubrication/i.test(s.d),
    why: "ปั๊มจาระบี/น้ำมันหล่อลื่น พร้อมสวิตช์ระดับ ความดัน และวาล์วสายจ่าย",
    steps: ["ตรวจระดับจาระบี (min/max) และสภาพปั๊ม", "ตรวจสวิตช์ความดันสายจ่ายและวาล์วแบ่งสาย", "ตรวจเบรกเกอร์/คอนแทคเตอร์ของปั๊มตามหน้า Main Supply และ Control"] },
  { id: "net", label: "เครือข่าย / Profibus / Scalance", test: (s) => /scalance|profibus|repeater|infra|ethernet|network|plc/i.test(s.d),
    why: "สัญญาณเกี่ยวกับโครงสร้างพื้นฐานการสื่อสารและอุปกรณ์เครือข่าย",
    steps: ["ตรวจไฟเลี้ยงและ LED ของอุปกรณ์ (Scalance / Repeater / IM151-1)", "ตรวจสายและขั้วต่อ Profibus DP (terminating on/off ตามหน้าวงจร)", "ดูสถานะ diagnostic ของสถานีใน PLC (SF/BF LED, OB86 / OB122)"] },
  { id: "belt", label: "สายพานลำเลียง", test: (s) => /conveyor|belt|beltdrift|slip|tripper|speed|pull/i.test(s.d),
    why: "การตรวจจับสายพาน (เบี่ยง, สลิป, ความเร็ว, pull cord) หรืออุปกรณ์ขับสายพาน",
    steps: ["ตรวจสภาพสายพานและเซนเซอร์ที่ถูกกระตุ้น (beltdrift, slip, speed) พร้อมระยะตรวจจับ", "ตรวจสถานะชุดขับ (VFD/สตาร์ทเตอร์) และเบรกเกอร์ในฟังก์ชันเดียวกัน", "เทียบสัญญาณกับของสายพาน/ไดรฟ์อื่นที่คล้ายกันเพื่อแยกว่าเป็นเฉพาะจุดหรือทั้งระบบ"] },
  { id: "power", label: "ไฟเลี้ยง / ตู้ไฟฟ้า / UPS", test: (s) => /400vac|6kv|incoming|feeder|transformer|\bups\b|voltage|protection|24vdc/i.test(s.d),
    why: "สัญญาณเกี่ยวกับไฟเลี้ยงระบบหรือตู้ไฟ ซึ่งมักกระทบหลายสัญญาณพร้อมกัน",
    steps: ["วัดแรงดันขาเข้า/ขาออกของแหล่งจ่าย และตรวจเบรกเกอร์ต้นทาง", "ตรวจสถานะ UPS/แหล่งจ่าย 24 VDC และ LED ของอุปกรณ์", "ถ้าเกี่ยวกับ 400 VAC / 6 kV ต้องตัดไฟและทำ LOTO ก่อนตรวจที่ตัวอุปกรณ์"] },
  { id: "lcs", label: "Local control / ห้องควบคุม / จอยสติ๊ก", test: (s) => /local control|lcs|operator|chair|joystick|local\/remote|remote|selected/i.test(s.d),
    why: "สัญญาณจากสถานีควบคุมหน้างานหรือคอนโซลผู้ปฏิบัติงาน",
    steps: ["ตรวจตำแหน่งสวิตช์ Local/Remote/Lock ที่หน้างาน", "ตรวจปุ่ม/จอยสติ๊กและสายเคเบิลไปยัง ET200S ของตู้ควบคุม", "ตรวจเบรกเกอร์ 24 VDC ของฟังก์ชันนี้"] },
  { id: "cmd", label: "คำสั่งเอาต์พุต (DO)", test: (s) => s.k === "DO",
    why: "เอาต์พุตของ PLC ไปขับรีเลย์ตัวกลาง (-KFxx:A1) แล้วจึงต่อไปยังอุปกรณ์",
    steps: ["ดู LED ช่องสัญญาณของโมดูล DO {mod} และค่า {addr} ใน PLC (online) ว่าตรงกับที่ควรสั่งหรือไม่",
            "วัด 24 VDC ที่ขั้ว A1/A2 ของรีเลย์ {dev} · ถ้ามีไฟแต่รีเลย์ไม่ดึง → เปลี่ยนรีเลย์",
            "ตรวจหน้าสัมผัสรีเลย์และอุปกรณ์ปลายทาง (คอนแทคเตอร์/วาล์ว/ปั๊ม) ตามหน้าวงจร"] },
  { id: "analog", label: "สัญญาณอนาล็อก", test: (s) => s.k === "AI" || s.k === "AO",
    why: "ลูป 4–20 mA แบบ 2 สาย หรือ PT100/RTD",
    steps: ["วัดกระแสลูปด้วยมัลติมิเตอร์แบบอนุกรม: ต่ำกว่า 4 mA (เช่น < 3.6 mA) = สายขาด/เซนเซอร์ไม่มีไฟ, สูงกว่า 20 mA = ลัดวงจร/เซนเซอร์ผิดปกติ",
            "ถ้าเป็น 2 สาย ตรวจไฟเลี้ยงลูปจากโมดูล {mod} และขั้ว M+/M−",
            "ตรวจการตั้งค่า scaling ใน PLC เมื่อค่ากระแสปกติแต่ค่าที่แสดงผิด"] },
];
const LADDER = [
  "ยืนยันสถานะจริงของ {addr} ใน PLC (online/ตาราง watch) — ค่าที่ HMI แสดงอาจถูกหน่วงหรือมี latch",
  "ดู LED ของโมดูล {mod} (ช่อง {chan}) และ LED SF/BF ของ IM151-1 สถานี Profibus {st} ({cab})",
  "วัดแรงดันที่ขั้วโมดูล เทียบกับสิ่งที่ PLC เห็น เพื่อแยกว่าปัญหาอยู่ฝั่งอุปกรณ์หน้างานหรือฝั่งโมดูล/PLC",
  "ตามเส้นทางสัญญาณถอยไปหาอุปกรณ์ต้นทาง ({dev}) ตามหน้าวงจรที่ลิงก์ไว้ด้านล่าง",
];

/* ───────────────────────── PDF viewer ───────────────────────── */
// Pages are drawn with pdf.js into a canvas (an <iframe> PDF does not work on Android / iOS browsers).
// Only the pages that are shown are downloaded (HTTP range requests), so the 33 MB drawing set opens quickly.
const APP_BASE = document.currentScript?.src || location.href;
const PV = { lib: null, docs: {}, cur: null, job: 0, task: null };
// static web-site build (GitHub Pages): site-config.js describes pre-cut PDF files; there is no server API
const SITE = window.SPD_SITE || null;
const chunkOf = (n) => Math.floor((n - 1) / SITE.chunk);
const chunkUrl = (c) => new URL(SITE.drawing.replace("{n}", String(c).padStart(3, "0")), APP_BASE).href;
const fileLink = (doc, n) => (SITE && doc === "drawing" ? `${chunkUrl(chunkOf(n))}#page=${n - chunkOf(n) * SITE.chunk}` : `${pdfFileUrl(doc, n)}#page=${n}`);
const pdfFileUrl = (doc, n = 1) =>
  SITE
    ? doc === "manual" ? new URL(SITE.manual, APP_BASE).href : chunkUrl(chunkOf(n))
    : new URL(`../${encodeURI(doc === "manual" && MAN ? MAN.pdf : D.pdf)}`, APP_BASE).href;
async function pdfLib() {
  if (!PV.lib) {
    PV.lib = await import(new URL("vendor/pdf.min.mjs", APP_BASE).href);
    PV.lib.GlobalWorkerOptions.workerSrc = new URL("vendor/pdf.worker.min.mjs", APP_BASE).href;
  }
  return PV.lib;
}
async function pdfDoc(doc) {
  const lib = await pdfLib();
  return (PV.docs[doc] ||= lib.getDocument({ url: pdfFileUrl(doc), rangeChunkSize: 131072, disableAutoFetch: true, disableStream: true }).promise);
}
PV.singles = new Map();
// The drawing set is 33 MB with a flat page list; the server cuts out just the sheet that is needed (~90 KB). If that is not
// available (no server / pdf-lib missing) fall back to reading the whole file with pdf.js.
async function pdfPage(doc, n) {
  if (SITE && doc === "drawing") {
    // pre-cut files of SITE.chunk sheets each (~1 MB): load the one that holds sheet n
    const lib = await pdfLib(), c = chunkOf(Math.min(Math.max(1, n), P.length));
    if (!PV.docs["c" + c]) PV.docs["c" + c] = lib.getDocument({ url: chunkUrl(c) }).promise;
    const pdf = await PV.docs["c" + c];
    const nn = Math.min(Math.max(1, n), P.length);
    return { page: await pdf.getPage(nn - c * SITE.chunk), total: P.length, n: nn };
  }
  if (doc === "drawing" && !PV.noSingle) {
    try {
      const lib = await pdfLib();
      if (!PV.singles.has(n)) PV.singles.set(n, lib.getDocument({ url: new URL(`/api/page/${encodeURIComponent(D.pdf)}/${n}`, APP_BASE).href }).promise);
      for (const k of [...PV.singles.keys()].slice(0, -8)) PV.singles.delete(k); // keep the last few sheets only
      const pdf = await PV.singles.get(n);
      return { page: await pdf.getPage(1), total: P.length, n };
    } catch (e) {
      PV.singles.delete(n);
      PV.noSingle = true;
      console.warn("single-page endpoint not available, using the whole file:", e?.message);
    }
  }
  const pdf = await pdfDoc(doc);
  const nn = Math.min(Math.max(1, n), pdf.numPages);
  return { page: await pdf.getPage(nn), total: pdf.numPages, n: nn };
}
const isPhone = () => matchMedia("(max-width: 980px)").matches;
function pvTitle(n, doc) {
  if (doc === "manual" && MAN) return `คู่มือผู้ใช้ หน้า ${n} · ${M[n - 1]?.sec || ""}`;
  const pg = P[n - 1];
  return `แบบ หน้า ${n} · ${pg.func}${pg.sub ? " | " + pg.sub : ""}`;
}
async function renderPdf() {
  const c = PV.cur, job = ++PV.job;
  const wrap = $("#pv-scroll"), canvas = $("#pv-canvas"), hint = $("#pdf-empty");
  // the first sheet after the server started may need ~20 s while it prepares the drawing set: say so instead of showing nothing
  const slow = setTimeout(() => { if (job === PV.job) { hint.hidden = false; hint.classList.add("loading"); hint.textContent = "กำลังโหลดหน้า… (ครั้งแรกหลังเปิดโปรแกรมอาจใช้เวลาถึง 30 วินาที)"; } }, 700);
  try {
    const { page, total, n } = await pdfPage(c.doc, c.n);
    clearTimeout(slow);
    hint.hidden = true; hint.classList.remove("loading");
    if (job !== PV.job) return;
    c.n = n;
    const w1 = page.getViewport({ scale: 1 }).width;
    const narrow = wrap.clientWidth < 700;
    // a drawing sheet is tiny on a phone: start wider than the screen (scroll sideways) so the text is legible
    if (c.fit) c.scale = ((wrap.clientWidth - 12) / w1) * (narrow ? (c.doc === "drawing" ? 2.4 : 1.35) : 1);
    c.scale = Math.min(Math.max(c.scale, 0.25), 8);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const vp = page.getViewport({ scale: c.scale * dpr });
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = Math.floor(vp.width / dpr) + "px";
    canvas.style.height = Math.floor(vp.height / dpr) + "px";
    PV.task?.cancel?.();
    PV.task = page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
    await PV.task.promise;
    if (job !== PV.job) return;
    $("#pv-n").value = c.n;
    $("#pv-total").textContent = total;
    const url = fileLink(c.doc, c.n);
    $("#pdf-open").href = url;
    $("#pdf-title").textContent = c.label || pvTitle(c.n, c.doc);
    wrap.scrollTop = 0;
    if (c.fit) wrap.scrollLeft = 0;
  } catch (e) {
    clearTimeout(slow);
    if (job !== PV.job || e?.name === "RenderingCancelledException") return;
    console.error("PDF viewer:", e);
    wrap.hidden = true;
    hint.hidden = false; hint.classList.remove("loading");
    hint.innerHTML = `แสดงหน้า PDF ในหน้านี้ไม่ได้<br><a href="${fileLink(c.doc, c.n)}" target="_blank" rel="noopener">เปิด PDF หน้า ${c.n} ในแท็บใหม่ ↗</a>`;
  }
}
function openPdf(n, label, doc = "drawing") {
  if (doc === "manual" && !MAN) doc = "drawing";
  PV.cur = { doc, n, label, fit: true, scale: 1 };
  if (SITE && SITE.pdf === false) {
    $("#pv-scroll").hidden = true; $("#pv-tools").hidden = true; $("#pdf-open").hidden = true;
    $("#pdf-empty").hidden = false;
    $("#pdf-title").textContent = label || pvTitle(n, doc);
    $("#pdf-empty").innerHTML = `ไฟล์ PDF ไม่ได้เผยแพร่บนเว็บนี้<br><b>${doc === "manual" ? "คู่มือผู้ใช้" : "แบบไฟฟ้า"} หน้า ${n}</b><br>เปิดจากไฟล์ต้นฉบับที่หน้านี้`;
    if (isPhone()) document.body.classList.add("pv-open");
    return;
  }
  $("#pdf-empty").hidden = true;
  $("#pv-scroll").hidden = false; // (a failed render hides it again and shows a link to the file)
  $("#pv-tools").hidden = false;
  $("#pdf-title").textContent = label || pvTitle(n, doc);
  const a = $("#pdf-open");
  a.href = fileLink(doc, n); a.hidden = false;
  if (isPhone()) document.body.classList.add("pv-open");
  renderPdf();
}
const pvGo = (d) => { if (PV.cur) { PV.cur.n += d; PV.cur.label = ""; renderPdf(); } };
const pvZoom = (f) => { if (PV.cur) { PV.cur.fit = false; PV.cur.scale *= f; renderPdf(); } };
$("#pv-prev").addEventListener("click", () => pvGo(-1));
$("#pv-next").addEventListener("click", () => pvGo(1));
$("#pv-zin").addEventListener("click", () => pvZoom(1.3));
$("#pv-zout").addEventListener("click", () => pvZoom(1 / 1.3));
$("#pv-fit").addEventListener("click", () => { if (PV.cur) { PV.cur.fit = true; renderPdf(); } });
$("#pv-n").addEventListener("change", (e) => { if (PV.cur) { PV.cur.n = +e.target.value || 1; PV.cur.label = ""; renderPdf(); } });
$("#pv-close").addEventListener("click", () => document.body.classList.remove("pv-open"));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.body.classList.remove("pv-open"); });
// pinch-to-zoom on the sheet re-renders it sharply once the gesture ends
{
  const w = $("#pv-scroll"); let d0 = 0, s0 = 1;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  w.addEventListener("touchstart", (e) => { if (e.touches.length === 2 && PV.cur) { d0 = dist(e.touches); s0 = PV.cur.scale; } }, { passive: true });
  w.addEventListener("touchmove", (e) => { if (e.touches.length === 2 && d0 && PV.cur) { const k = dist(e.touches) / d0; $("#pv-canvas").style.transform = `scale(${k})`; $("#pv-canvas").style.transformOrigin = "top left"; PV.cur._k = k; } }, { passive: true });
  w.addEventListener("touchend", () => { if (d0 && PV.cur?._k) { const k = PV.cur._k; $("#pv-canvas").style.transform = ""; PV.cur.fit = false; PV.cur.scale = s0 * k; PV.cur._k = 0; d0 = 0; renderPdf(); } d0 = 0; });
}
const pageChip = (n, text) => {
  const p = P[n - 1];
  return `<button class="chip page" data-page="${n}" title="${esc(p.func + (p.sub ? " | " + p.sub : ""))} · ${esc(cabLabel(p.l))}">${esc(text || "หน้า " + n)}</button>`;
};
const manChip = (n, label) => `<button class="chip man" data-page="${n}" data-doc="manual" title="${esc(M[n - 1]?.sec || "")}">📖 ${esc(label || M[n - 1]?.sec || "")} · หน้า ${n}</button>`;
const manChips = (refs) => (MAN && refs?.length ? refs.map(([n, label]) => manChip(n, label)).join("") : "");
const pageLabel = (p) => `${p.func}${p.sub ? " | " + p.sub : ""} · ${p.n}`;
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-page]");
  if (b) openPdf(+b.dataset.page, undefined, b.dataset.doc || "drawing");
});

/* ---- "open on a phone": the address on the local network + a QR code ---- */
if (SITE) $("#btn-phone").hidden = true; // the site is already on the web
$("#btn-phone").addEventListener("click", async () => {
  const dlg = $("#dlg-phone"), body = $("#dlg-body");
  body.innerHTML = "กำลังตรวจสอบ…";
  dlg.showModal();
  let info = null;
  try { info = await (await fetch("/api/info")).json(); } catch { /* opened without the server */ }
  if (!info) { body.innerHTML = "เครื่องมือนี้ถูกเปิดโดยไม่ผ่านเซิร์ฟเวอร์ — ปิดแล้วดับเบิลคลิก <b>run-analyzer.bat</b> จากนั้นกดปุ่มนี้อีกครั้ง"; return; }
  if (!info.urls.length) { body.innerHTML = info.lan ? "ไม่พบที่อยู่เครือข่ายของเครื่องนี้ — ตรวจว่าต่อ Wi-Fi/LAN อยู่" : "เซิร์ฟเวอร์ถูกเปิดแบบ “เฉพาะเครื่องนี้” — ปิดแล้วเปิดใหม่ด้วย <b>run-analyzer.bat</b> (ไม่ใส่ --local)"; return; }
  body.innerHTML =
    `<p style="margin:0">ให้มือถือ/แท็บเล็ตต่อ <b>Wi-Fi เดียวกับเครื่องนี้</b> แล้วสแกน QR หรือพิมพ์ที่อยู่ในเบราว์เซอร์ (เครื่องคอมต้องเปิดโปรแกรมค้างไว้)</p>` +
    info.urls.map((u) => {
      const qr = qrcode(0, "M"); qr.addData(u); qr.make();
      return `<div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}<div class="u">${esc(u)}</div></div>`;
    }).join("") +
    `<p class="muted" style="margin:0">เปิดไม่ขึ้นบนมือถือ? ตอนเปิดครั้งแรก Windows จะถามสิทธิ์ให้ Node.js — เลือก “อนุญาต” เฉพาะเครือข่ายส่วนตัว · ถ้าพลาด ให้ไปที่ Windows Defender Firewall → Allow an app → Node.js</p>`;
});
$("#dlg-close").addEventListener("click", () => $("#dlg-phone").close());

/* ═════════════════════════ ALARM ANALYSIS (HMI alarm lines) ═════════════════════════ */

/* ---- parsing one HMI alarm-list line:  date time PA01 <loc> <tag> <object name> <SEVERITY>, <event> ---- */
function normLoc(code) {
  return code.replace(/^\+*/, "").replace(/^EH(\d{2})\b/, "EHA$1").replace(/^EH(\d)\b/, "EHA0$1");
}
function tagVariants(tag) {
  // "QA22/24/26" → QA22, QA24, QA26 ; "MA01,06,09" → MA01, MA06, MA09 ; "QL01-22" / "MA01-03/B" → QL01 / MA01 (range start)
  const m = /^([A-Z]{1,3})(\d{1,3})((?:[\/,]\d{1,3})*)/.exec(tag);
  if (!m) return [];
  const out = [{ letters: m[1], num: +m[2], label: m[1] + m[2].padStart(2, "0") }];
  for (const x of (m[3] || "").split(/[\/,]/).filter(Boolean)) out.push({ letters: m[1], num: +x, label: m[1] + x.padStart(2, "0") });
  return out;
}
function parseAlarm(raw) {
  let t = raw.replace(/[\t ]+/g, " ").replace(/\s+/g, " ").trim();
  const a = { raw: raw.trim(), ts: null, loc: "", tag: "", obj: "", sev: "", eventText: "" };
  if (/\s?\/\/\?\s*$/.test(t)) { a.lowConf = true; t = t.replace(/\s?\/\/\?\s*$/, ""); } // line the photo reader was unsure about
  const dm = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/.exec(t);
  if (dm) {
    const yy = +dm[3] < 100 ? 2000 + +dm[3] : +dm[3];
    a.ts = Date.UTC(yy, +dm[2] - 1, +dm[1], +dm[4], +dm[5], +dm[6], dm[7] ? +dm[7].padEnd(3, "0") : 0);
    a.date = `${dm[1].padStart(2, "0")}/${dm[2].padStart(2, "0")}/${dm[3]}`;
    a.time = `${dm[4].padStart(2, "0")}:${dm[5]}:${dm[6]}${dm[7] ? "." + dm[7] : ""}`;
    t = (t.slice(0, dm.index) + " " + t.slice(dm.index + dm[0].length)).trim();
  }
  t = t.replace(/(^|\s)=?PA0[0-9x]\b/i, " ").trim();
  // location (e.g. EHA02+LVC03, CVA+DCV, TCA+LCS03) followed by the device tag
  const lm = /(^|\s)(?:=PA01)?\+*((?:[A-Z]{2,3}\d{0,2})\+[A-Z]{2,3}\d{0,2})(?=[\s-]|$)\s*-?\s*/.exec(t);
  if (lm) {
    a.loc = normLoc(lm[2]);
    const after = t.slice(lm.index + lm[0].length);
    const tm = /^-?([A-Z]{1,3}\d{1,3}[A-Z0-9\/,.\-]*)/.exec(after);
    if (tm) {
      a.tag = tm[1].replace(/[\/,\-.]+$/, "");
      t = (t.slice(0, lm.index) + " " + after.slice(tm[0].length)).trim();
    } else t = (t.slice(0, lm.index) + " " + after).trim();
  } else {
    // no location typed: accept a leading bare tag such as "TB05 FAULT, ..." or "-FC08 ..."
    const tm = /^-?([A-Z]{1,3}\d{1,3}[A-Z0-9\/,.\-]*)(?=\s|$)/.exec(t);
    if (tm) {
      a.tag = tm[1].replace(/[\/,\-.]+$/, "");
      t = t.slice(tm[0].length).trim();
    }
  }
  const sm = /\b(FAULT|ALARM|WARNING)\b\s*,\s*/i.exec(t);
  if (sm) {
    a.obj = t.slice(0, sm.index).replace(/[,\s]+$/, "").trim();
    a.sev = sm[1].toUpperCase();
    a.eventText = t.slice(sm.index + sm[0].length).trim();
  } else {
    a.eventText = t.trim();
  }
  return finishAlarm(a);
}
// derived fields shared by the pasted-line parser and the form
function finishAlarm(a) {
  a.event = KB.events.find((ev) => ev.rx.test(a.eventText)) || null;
  if (!a.event && a.obj) a.event = KB.events.find((ev) => ev.rx.test(a.obj)) || null;
  const sv = /PB-SLV\s*(\d+)/i.exec(`${a.raw} ${a.obj} ${a.eventText}`);
  if (sv) a.slave = +sv[1];
  a.fullLoc = a.loc ? "=PA01++" + a.loc : "";
  a.variants = a.tag ? tagVariants(a.tag) : [];
  a.sevClass = a.sev === "WARNING" ? "warn" : a.sev ? "bad" : "info";
  return a;
}

/* ---- locating the device in the drawing set ---- */
const PAGE_GROUPS = [
  ["circuit", "วงจร / สัญญาณ", (p) => !/(Parts list|cabinet labeling|cabinet assembly|Terminal diagram|Cable overview|Blockdiagrams|Singleline|Table of contents|Symbol legend|Identifier set)/i.test(p.func)],
  ["overview", "ภาพรวม / Block diagram", (p) => /Blockdiagrams|Singleline|Cable overview/i.test(p.func)],
  ["terminal", "ขั้วต่อสาย", (p) => /Terminal diagram/i.test(p.func)],
  ["parts", "รายการอุปกรณ์ / การติดตั้งในตู้", (p) => /Parts list|cabinet labeling|cabinet assembly/i.test(p.func)],
];
function locateDevice(a) {
  const res = { pages: [], signals: [], known: !!D.locs[a.fullLoc] };
  if (!a.fullLoc || !a.variants.length) return res;
  const [area, cabinet] = a.loc.split("+");
  const found = new Map();
  for (const v of a.variants) {
    const dev = `${v.letters}0*${v.num}(?![A-Za-z0-9])`;
    const local = new RegExp("(^|\\n)-" + dev);
    const rel = cabinet ? new RegExp("\\+" + escRe(cabinet) + "-" + dev) : null;
    const abs = new RegExp("\\+\\+" + escRe(a.loc) + "-" + dev);
    for (const p of P) {
      if (found.has(p.n)) continue;
      const sameLoc = p.l === a.fullLoc;
      const sameArea = p.l.startsWith("=PA01++" + area + "+") || p.l === "=PA01++" + area;
      if ((sameLoc && local.test("\n" + p.txt)) || abs.test(p.txt) || (rel && sameArea && !sameLoc && rel.test(p.txt))) found.set(p.n, p);
    }
    for (const s of S) {
      const t = parseTag(s);
      if (t.loc === a.fullLoc && new RegExp("^-" + dev.replace("(?![A-Za-z0-9])", "$")).test(t.device)) a._sig = (a._sig || new Map()).set(s.id, s);
    }
  }
  res.pages = [...found.values()].sort((x, y) => x.n - y.n);
  res.signals = a._sig ? [...a._sig.values()] : [];
  return res;
}
const stationsByAdr = (adr) => Object.entries(D.stations).flatMap(([loc, arr]) => arr.filter((s) => s.adr === adr).map((s) => ({ loc, ...s })));

// when the electrician typed a tag without a location (e.g. just "TB05"): list the places where that tag exists in the drawings
function tagCandidates(a) {
  const byLoc = new Map();
  for (const v of a.variants) {
    const re = new RegExp("(^|\\n)-" + v.letters + "0*" + v.num + "(?![A-Za-z0-9])");
    for (const p of P) if (PAGE_GROUPS[0][2](p) && re.test("\n" + p.txt)) (byLoc.get(p.l) || byLoc.set(p.l, []).get(p.l)).push(p);
  }
  const ot = new Set(toks(a.obj));
  return [...byLoc.entries()].map(([l, ps]) => {
    const overlap = ps.reduce((m, p) => Math.max(m, toks(p.func).filter((t) => ot.has(t)).length), 0);
    return { loc: l, pages: ps, score: overlap * 10 + Math.min(ps.length, 9) };
  }).sort((x, y) => y.score - x.score).slice(0, 6);
}

/* ---- rendering one alarm analysis ---- */
const sevChip = (a) => `<span class="sev ${a.sevClass}">${esc(a.sev || "?")}</span>`;
function deviceInfo(a) {
  const letters = a.variants[0]?.letters;
  const code = letters ? (D.codes[letters.slice(0, 2)] ? letters.slice(0, 2) : letters[0] in D.codes ? letters[0] : "") : "";
  const hintKey = letters && KB.deviceHints[letters.slice(0, 2)] ? letters.slice(0, 2) : letters && KB.deviceHints[letters] ? letters : "";
  return { code: letters ? letters.slice(0, 2) : "", legend: letters ? D.codes[letters.slice(0, 2)] || "" : "", hint: hintKey ? KB.deviceHints[hintKey] : "" };
}
function renderAlarm(a, { open = true, auto = false } = {}) {
  const loc = locateDevice(a);
  const ev = a.event;
  const info = deviceInfo(a);
  const slaveSt = a.slave != null ? stationsByAdr(a.slave) : [];
  const ctx = { tag: a.tag || "—", dev: a.tag ? "-" + a.tag : "—", loc: a.loc || "—", cab: a.loc ? locName(a.loc) : "ตู้ที่เกี่ยวข้อง", obj: a.obj || "—", slave: a.slave != null ? "PB-SLV" + a.slave : "—" };
  const evText = a.eventText || a.raw;
  const variants = ev?.variants?.filter((v) => v.rx.test(evText)).slice(0, 1) || []; // variants are ordered most specific first → show only the best match
  // extra context from the object name (e.g. "VALUE HIGH" on a TENSION MONITORING object) and the user-manual pages for everything shown
  const ctxEvents = Object.entries(KB.objectContext || {}).filter(([id, rx]) => rx.test(a.obj) && ev?.id !== id).map(([id]) => KB.events.find((e) => e.id === id)).filter(Boolean);
  const variantManual = variants.flatMap((v) => v.manual || []);
  const manualRefs = [...(variantManual.length ? variantManual : ev?.manual || []), ...ctxEvents.flatMap((e) => e.manual || [])]; // a variant's own pages replace the event's generic ones
  const uniqManual = [...new Map(manualRefs.map((r) => [r[0], r])).values()];
  const basisBadge = ev ? { manual: "อ้างอิงคู่มือ", mixed: "คู่มือ + หลักปฏิบัติทั่วไป", practice: "หลักปฏิบัติทั่วไป" }[ev.basis] || "" : "";

  const byGroup = PAGE_GROUPS.map(([id, label, test]) => [label, loc.pages.filter(test)]).filter(([, ps]) => ps.length);
  const pageHtml = byGroup.map(([label, ps]) => `<div class="small muted" style="margin-top:6px">${esc(label)}</div><div>${ps.slice(0, 10).map((p) => pageChip(p.n, pageLabel(p))).join("")}${ps.length > 10 ? `<span class="muted small"> +${ps.length - 10} หน้า</span>` : ""}</div>`).join("");
  const sigHtml = loc.signals.length
    ? `<div class="small muted" style="margin-top:6px">สัญญาณ I/O ของ PLC ที่เกี่ยวกับอุปกรณ์นี้ (กดเพื่อดูรายละเอียด)</div><div class="list">${loc.signals.slice(0, 8).map((s) => `<button class="item" data-sig="${s.id}"><div class="l1"><span class="addr">${esc(s.a)}</span><span class="badge ${s.k}">${s.k}</span><span class="desc">${esc(s.d)}</span></div><div class="small muted">${esc(s.t)} · ${esc(s.m)}${s.s != null ? " · สถานี " + s.s : ""} · ${esc(cabLabel(s.l))}</div></button>`).join("")}</div>`
    : "";
  let slaveHtml = "";
  if (a.slave != null) {
    if (slaveSt.length) {
      slaveHtml = slaveSt.map((st) => {
        const sg = S.filter((s) => s.l === st.loc && s.s === st.adr);
        return `<div class="note info">Profibus สถานี <b>${st.adr}</b> อยู่ที่ <b>${esc(cabLabel(st.loc))}</b> · มี I/O ในแบบ ${sg.length} ช่อง (${sg.filter((s) => s.k === "DI").length} DI, ${sg.filter((s) => s.k === "DO").length} DO, ${sg.filter((s) => s.k === "AI" || s.k === "AO").length} อนาล็อก) — เมื่อสถานีนี้หลุด ทุกช่องจะอ่าน/สั่งไม่ได้ ${pageChip(st.page, `ผัง rack สถานี ${st.adr} · หน้า ${st.page}`)} <button class="chip" data-st="${st.adr}">ดูสัญญาณทั้งหมดของสถานีนี้</button></div>`;
      }).join("");
    } else slaveHtml = `<div class="note warn">ไม่พบสถานี Profibus หมายเลข ${a.slave} ในแบบที่ดึงข้อมูลได้ (อาจเป็นอุปกรณ์ที่ไม่ใช่ ET200S)</div>`;
  }
  // device not found by tag → still point to the circuit sheets of that cabinet/area so the electrician has somewhere to start
  const areaPages = !loc.pages.length && a.fullLoc ? P.filter((p) => p.l === a.fullLoc && PAGE_GROUPS[0][2](p)).slice(0, 12) : [];
  const notInDrawing = a.tag && !loc.pages.length
    ? `<div class="note warn">ไม่พบอุปกรณ์ <b>${esc(a.loc)}-${esc(a.tag)}</b> ในแบบชุดนี้${a.loc && !loc.known ? " (ตำแหน่งนี้ไม่มีในแบบ — อาจเป็นอุปกรณ์ของผู้ผลิตรายอื่น เช่น ชุดไฮดรอลิก/ระบบดับเพลิง)" : " (แบบอาจใช้เลขแท็กต่างจาก HMI)"} · ลองค้นชื่อวัตถุในแท็บ “สำรวจแบบ”${areaPages.length ? `<div class="small" style="margin-top:6px">หน้าวงจรของ ${esc(locName(a.loc))} (เริ่มดูจากตรงนี้):</div><div>${areaPages.map((p) => pageChip(p.n, pageLabel(p))).join("")}</div>` : ""}</div>` : "";

  let fallback = "";
  if (a.tag && !a.fullLoc) {
    const c = tagCandidates(a);
    fallback = `<div class="note warn">ไม่ได้ระบุตำแหน่ง (ส่วน “++/+” บนหน้าจอ HMI เช่น EHA02+LVC03) — แท็ก <b>-${esc(a.tag)}</b> พบในแบบหลายที่ ใส่ตำแหน่งเพื่อให้แม่นยำขึ้น หรือเลือกดูตามนี้:${c.map((x) => `<div class="small" style="margin-top:4px"><b class="mono">${esc(locShort(x.loc))}</b> <span class="muted">${esc(locName(locShort(x.loc).replace(/^\+\+/, "")))}</span><div>${x.pages.slice(0, 3).map((p) => pageChip(p.n, pageLabel(p))).join("")}</div></div>`).join("") || " (ไม่พบแท็กนี้ในแบบ)"}</div>`;
  } else if (!a.tag && !a.fullLoc) {
    const r = searchSignals(a.raw, { limit: 5 }).rows;
    fallback = `<div class="note warn">อ่านตำแหน่ง/แท็กจากบรรทัดนี้ไม่ได้ — แสดงสัญญาณ I/O ที่ข้อความใกล้เคียงที่สุดแทน${r.length ? `<div class="list">${r.map(({ s }) => `<button class="item" data-sig="${s.id}"><div class="l1"><span class="addr">${esc(s.a)}</span><span class="badge ${s.k}">${s.k}</span><span class="desc">${esc(s.d)}</span></div><div class="small muted">${esc(s.t)} · ${esc(cabLabel(s.l))}</div></button>`).join("")}</div>` : " (ไม่พบ)"}</div>`;
  }

  const body = `
    ${ev ? `<div class="kb"><div class="t">${esc(ev.title)} <span class="badge">${esc(ev.level)}</span> ${basisBadge ? `<span class="badge ${ev.basis === "practice" ? "lowc" : "src"}">${esc(basisBadge)}</span>` : ""}</div><div class="small">${esc(fill(ev.meaning, ctx))}</div>${a.sev && KB.severity[a.sev] ? `<div class="small muted" style="margin-top:4px">${esc(KB.severity[a.sev])}</div>` : ""}</div>` : `<div class="note warn">ยังไม่มีข้อความ Event นี้ในฐานความรู้ (${esc(evText)}) — ใช้ข้อมูลอุปกรณ์และหน้าแบบด้านล่างประกอบการตรวจ (เพิ่มความรู้ได้ใน knowledge.js)</div>`}
    ${ctxEvents.map((e) => `<div class="note info"><b>${esc(e.title)}</b> (จากชื่ออุปกรณ์) — ${esc(fill(e.meaning, ctx))}</div>`).join("")}
    <div class="grid2">
      <div>
        <h3>อุปกรณ์</h3>
        <table class="kv"><tr><th>ตำแหน่ง</th><td>${a.loc ? `<span class="mono">${esc(a.loc)}</span><br><span class="muted small">${esc(locName(a.loc))}</span>` : "—"}</td></tr>
        <tr><th>แท็ก</th><td>${a.tag ? `<span class="mono">-${esc(a.tag)}</span>${info.code ? `<br><span class="muted small">${esc(info.code)}: ${esc(info.legend || "—")}</span>` : ""}` : "—"}</td></tr>
        <tr><th>ชื่อวัตถุ</th><td>${esc(a.obj || "—")}</td></tr>
        <tr><th>Event</th><td>${sevChip(a)} ${esc(a.eventText || "—")}</td></tr></table>
        ${info.hint ? `<div class="small muted" style="margin-top:6px">${esc(info.hint)}</div>` : ""}
      </div>
      ${ev ? `<div><h3>สาเหตุที่เป็นไปได้ (เรียงตามความน่าจะเป็น)</h3><ol class="steps">${ev.causes.map((c) => `<li>${esc(fill(c, ctx))}</li>`).join("")}</ol>${variants.map((v) => `<div class="small muted" style="margin-top:4px">• ${esc(v.note)}</div>`).join("")}</div>` : ""}
    </div>
    ${slaveHtml}${notInDrawing}${fallback}
    ${ev ? `<h3>วิธีตรวจเช็ค (ทำตามลำดับ)</h3><ol class="steps">${ev.checks.map((c) => `<li>${esc(fill(c, ctx))}</li>`).join("")}</ol>
    <h3>แนวทางแก้ไข</h3><ul class="steps">${ev.fix.map((c) => `<li>${esc(fill(c, ctx))}</li>`).join("")}</ul>` : ""}
    ${loc.pages.length || loc.signals.length ? `<h3>หน้าแบบที่เกี่ยวข้อง (กดเพื่อดู PDF)</h3>${pageHtml}${sigHtml}` : ""}
    ${MAN ? `<h3>คู่มือผู้ใช้ที่เกี่ยวข้อง (กดเพื่อดู)</h3><div>${manChips(uniqManual)}${manChip(28, "ขั้นตอนหาข้อบกพร่อง")}${manChip(49, "ชนิดข้อความ Alarm/Warning/Fault")}</div>` : ""}
    <details class="proc"><summary>ขั้นตอนหาข้อบกพร่องมาตรฐานของคู่มือ (§2.8)</summary><ol class="steps">${KB.procedure.map((t) => `<li>${esc(t)}</li>`).join("")}</ol></details>
    <div class="small muted" style="margin-top:10px">${esc(KB.safety)}</div>`;

  const head = `<span class="mono">${esc(a.loc || "—")}${a.tag ? "-" + esc(a.tag) : ""}</span> <span class="desc">${esc(a.obj || a.eventText)}</span>`;
  const when = a.time ? `<span class="muted small">${esc(a.date)} ${esc(a.time)}</span>` : "";
  if (auto) {
    const first = loc.pages.find((p) => /Signaling|Control/i.test(p.sub) && PAGE_GROUPS[0][2](p)) || loc.pages.find(PAGE_GROUPS[0][2]) || loc.pages[0];
    if (first) setTimeout(() => openPdf(first.n), 0);
  }
  const lowc = a.lowConf ? '<span class="badge lowc">AI อ่านรูปไม่มั่นใจ — ตรวจกับรูปจริง</span>' : "";
  return `<details class="alarm ${a.sevClass}" ${open ? "open" : ""} id="al-${a.idx}"><summary>${sevChip(a)} ${head} ${when}${lowc}${ev ? `<span class="badge">${esc(ev.title)}</span>` : ""}</summary><div class="alarm-body">${a.lowConf ? '<div class="note warn">แถวนี้ AI อ่านจากรูปได้ไม่ชัด ตำแหน่ง/แท็กอาจผิด — เทียบกับหน้าจอจริงก่อนใช้ผลวิเคราะห์ แล้วแก้ข้อความในช่องด้านบนและกดวิเคราะห์ใหม่</div>' : ""}${body}</div></details>`;
}

/* ---- timeline / common-cause analysis ---- */
const tokensOf = (a) => {
  // canonical (E-House, cabinet) key from the alarm location, e.g. EHA02+LVC01 → "EH2|LVC01"
  const m = /^EHA0?(\d)\+(LVC\d+|HVC\d+)/.exec(a.loc);
  return m ? `EH${m[1]}|${m[2]}` : "";
};
function analyzeBursts(alarms) {
  const timed = alarms.filter((a) => a.ts != null).sort((x, y) => x.ts - y.ts);
  const bursts = [];
  let cur = null;
  for (const a of timed) {
    if (!cur || a.ts - cur.end > 3000) { cur = { start: a.ts, end: a.ts, items: [a] }; bursts.push(cur); }
    else { cur.items.push(a); cur.end = a.ts; }
  }
  const untimed = alarms.filter((a) => a.ts == null);
  if (untimed.length) bursts.push({ start: null, end: null, items: untimed });
  for (const b of bursts) b.notes = burstNotes(b);
  return bursts;
}
// supply-type breakers (system / control-voltage distribution, IM module) outrank motor-group breakers, which are usually a consequence of lost voltage
const SUPPLY_OBJ = /SYS\.?\s*V\.?\s*DISTR|CTR\.?\s*V\.?\s*DISTR|IM MODULE|CONTROL VOLT|24\s?VDC|UPS/i;
function effRank(a) {
  let r = a.event?.rank ?? 0;
  if (a.event?.id === "cb-tripped") r += SUPPLY_OBJ.test(a.obj) ? 5 : /AT LEAST 1/i.test(a.eventText) ? -4 : 0;
  return r;
}
function burstNotes(b) {
  const it = b.items, notes = [];
  const byId = (id) => it.filter((a) => a.event?.id === id);
  const span = b.start != null ? b.end - b.start : null;
  const cabs = new Set(it.map((a) => a.loc).filter(Boolean));
  if (it.length >= 4 && span != null && span <= 1500 && cabs.size >= 3)
    notes.push({ cls: "bad", text: `${it.length} รายการเกิดภายใน ${span} ms ที่ ${cabs.size} ตำแหน่งต่างกัน — พฤติกรรมแบบนี้มักมาจาก “เหตุร่วม” (ไฟเลี้ยง/ไฟตก/การสื่อสาร/PLC รีสตาร์ท) มากกว่าอุปกรณ์เสียพร้อมกันหลายตัว ให้ตรวจแหล่งจ่ายและสถานะ PLC ก่อน` });
  const slaves = byId("slave"), cbs = byId("cb-tripped");
  const linked = new Set();
  for (const sl of slaves) {
    for (const c of cbs) {
      // strong evidence only: (1) the breaker's own name says it feeds the IM/PLC/control voltage AND it is in the slave's cabinet,
      // or (2) the drawing shows an I/O signal of that very station reading this breaker
      const sameCab = tokensOf(c) && tokensOf(c) === tokensOf(sl);
      const byName = sameCab && SUPPLY_OBJ.test(c.obj);
      const bySignal = locateDevice(c).signals.some((s) => s.s === sl.slave);
      if (!byName && !bySignal) continue;
      linked.add(c);
      notes.push({ cls: "bad", text: `${c.loc}-${c.tag} (“${c.obj}”) ทริปพร้อมกับ PB-SLV${sl.slave} หลุด — ${bySignal ? `แบบแสดงว่าสถานี ${sl.slave} อ่านสถานะเบรกเกอร์นี้เป็นอินพุต` : "ชื่อวัตถุระบุว่าเป็นเบรกเกอร์ไฟเลี้ยงโมดูล และอยู่ตู้เดียวกับสถานีที่หลุด"} → สงสัย ${c.loc}-${c.tag} เป็นต้นเหตุ ตรวจ/แก้เบรกเกอร์ตัวนี้ก่อน แล้วดูว่า alarm อื่นหายตามหรือไม่` });
    }
  }
  if (slaves.length && it.some((a) => a.event?.id === "cb-tripped" || a.event?.id === "iso-mon") && !linked.size)
    notes.push({ cls: "warn", text: "SLAVE NOT PRESENT ขึ้นพร้อมเบรกเกอร์/ISO.MON. ทริป — เมื่อสถานี Profibus หลุด สัญญาณ “o.k.” ของสถานีจะเป็น 0 ทั้งชุด เบรกเกอร์บางตัวอาจรายงานทริปทั้งที่ยัง ON ให้ตรวจไฟเลี้ยงของสถานีก่อน แล้วค่อยตรวจเบรกเกอร์ทีละตัว" });
  if (slaves.length)
    notes.push({ cls: "info", text: "ตามคู่มือ (§4.3.1.1) อุปกรณ์ที่สถานะ “ไม่ทราบ/invalid” ถือว่าไม่ OK: ถ้าสถานีที่หลุดมีวงจร E-Stop/pull rope ไดรฟ์หลักทั้งหมดจะหยุดและ LV circuit breaker (process isolator) ถูกปลด — alarm ประเภทเบรกเกอร์ทริป, D.O. fault และ TIMEOUT ที่ตามมาจึงเป็นผลสืบเนื่องได้ ให้คืนสถานีที่หลุดก่อน แล้วค่อยรีเซ็ต" });
  if (linked.size && cbs.some((c) => /AT LEAST 1/i.test(c.eventText)))
    notes.push({ cls: "info", text: "เบรกเกอร์กลุ่มมอเตอร์ (“AT LEAST 1 C.B. TRIPPED”) ที่ขึ้นพร้อมกันในเสี้ยววินาที น่าจะเป็นผลจากไฟควบคุมหาย ไม่ใช่มอเตอร์ลัดวงจรหลายตัว — ตรวจหลังแก้ต้นเหตุ ถ้ายังทริปจึงค่อยตรวจมอเตอร์" });
  const iso = byId("iso-mon");
  if (iso.length >= 2 && new Set(iso.map((a) => a.loc)).size >= 2)
    notes.push({ cls: "bad", text: `ISO. MON. RELAY ทริป ${iso.length} ตู้พร้อมกัน — ฉนวนรั่วหลายระบบพร้อมกันเป็นไปได้ยาก ให้สงสัยเหตุไฟดับ/ไฟตกของแหล่งจ่ายหลัก หรือไฟเลี้ยงรีเลย์หาย (ตรวจ 6.6 kV/400 V ขาเข้า, UPS) แล้วจึงค่อยเช็ค earth fault รายตู้` });
  const temp = byId("thermistor");
  if (temp.length >= 3 && span != null && span <= 1000)
    notes.push({ cls: "warn", text: `รีเลย์อุณหภูมิมอเตอร์ทริป ${temp.length} รายการภายใน ${span} ms — มอเตอร์หลายตัวไม่น่าร้อนจริงพร้อมกัน ให้ตรวจไฟเลี้ยงรีเลย์เทอร์มิสเตอร์/ไฟตกชั่วขณะก่อน แล้วค่อยวัดมอเตอร์รายตัว` });
  const est = byId("estop-test");
  if (est.length >= 2) notes.push({ cls: "info", text: `E-STOP TEST REQUIRED ${est.length} รายการพร้อมกัน — มักเป็นผลจากการรีสตาร์ทระบบ ไม่ใช่อุปกรณ์เสีย` });
  if (it.some((a) => /PLC STARTUP/i.test(a.eventText)))
    notes.push({ cls: "warn", text: "มี “TRIP BY PLC STARTUP” — เหตุการณ์เกิดตอน PLC เริ่มทำงาน/คืนไฟ ให้ดูเหตุไฟดับก่อนหน้า" });
  return notes;
}
function renderSummary(alarms, bursts) {
  const rootOf = (b) => [...b.items].filter((a) => a.event && effRank(a) >= 60).sort((x, y) => effRank(y) - effRank(x) || x.ts - y.ts);
  const fmt = (ts) => new Date(ts).toISOString().slice(11, 23);
  // recommended order: highest-ranked suspects first; sibling alarms of the same kind in the same cabinet are listed on one line
  const groups = new Map();
  for (const b of bursts) for (const a of rootOf(b)) {
    const k = a.event.id + "|" + a.loc + "|" + (a.event.id === "cb-tripped" && /AT LEAST 1/i.test(a.eventText) ? "grp" : a.tag);
    if (!groups.has(k)) groups.set(k, { rank: effRank(a), first: a, items: [] });
    groups.get(k).items.push(a);
  }
  const steps = [...groups.values()].sort((x, y) => y.rank - x.rank);
  const burstHtml = bursts.map((b, i) => {
    const all = rootOf(b);
    const roots = all.filter((a) => effRank(a) >= effRank(all[0]) - 3).slice(0, 3); // only the genuinely top-ranked suspects
    const span = b.start != null ? b.end - b.start : null;
    const prev = bursts.slice(0, i).reverse().find((p) => p.end != null && b.start != null && b.start - p.end <= 120000 && rootOf(p).length);
    return `<div class="burst"><div><b>${b.start != null ? `ช่วงที่ ${i + 1}: ${fmt(b.start)}${span ? " – " + fmt(b.end) : ""}` : "ไม่มีข้อมูลเวลา"}</b> · ${b.items.length} รายการ${span != null ? ` · กินเวลา ${span} ms` : ""}</div>
      ${roots.length ? `<div class="small">ต้นเหตุที่น่าสงสัย: ${roots.map((a) => `<a href="#al-${a.idx}" data-open="al-${a.idx}">${esc(a.event.title)} — <span class="mono">${esc(a.loc)}${a.tag ? "-" + esc(a.tag) : ""}</span></a>`).join(" · ")}</div>` : `<div class="small muted">ไม่พบ alarm ระดับต้นเหตุ — ดูผลสืบเนื่องรายตัว</div>`}
      ${prev ? `<div class="note info">ช่วงนี้เกิดหลังช่วงที่ ${bursts.indexOf(prev) + 1} ราว ${Math.round((b.start - prev.end) / 1000)} วินาที — อาจเป็นผลต่อเนื่อง (เช่น ไดรฟ์/ระบบที่ฟื้นคืนหลังไฟกลับ)</div>` : ""}
      ${b.notes.map((n) => `<div class="note ${n.cls}">${esc(n.text)}</div>`).join("")}
      <div class="small muted">${b.items.map((a) => `<a href="#al-${a.idx}" data-open="al-${a.idx}" class="mini ${a.sevClass}" title="${esc(a.event?.title || a.eventText)}">${esc(a.tag || a.loc || "?")}</a>`).join(" ")}</div></div>`;
  }).join("");
  return `<div class="card"><h2>สรุปเหตุการณ์ (${alarms.length} Alarm · ${bursts.length} ช่วงเวลา)</h2>
    <p class="hint">Alarm ที่ขึ้นภายใน 3 วินาทีถูกจัดเป็นช่วงเดียวกัน — ในช่วงเดียวกัน Alarm ระดับ “ต้นเหตุ” (ไฟเลี้ยง/เบรกเกอร์/การสื่อสาร) มักมาก่อนและทำให้ Alarm อื่นขึ้นตาม เป็นสมมติฐานจากรูปแบบเหตุการณ์ ต้องยืนยันหน้างาน</p>
    ${burstHtml}
    ${steps.length ? `<h3>ลำดับการตรวจที่แนะนำ</h3><ol class="steps">${steps.slice(0, 8).map((g) => `<li><a href="#al-${g.first.idx}" data-open="al-${g.first.idx}"><b>${esc(g.first.event.title)}</b></a> — <span class="mono">${esc(g.first.loc)}${g.items.length > 1 ? "-" + g.items.map((x) => esc(x.tag)).join(", ") : g.first.tag ? "-" + esc(g.first.tag) : ""}</span> ${esc(g.items.length > 1 ? g.items.map((x) => x.obj.replace(/^.*?,\s*/, "")).join(" / ") : g.first.obj)}</li>`).join("")}</ol><p class="hint">ตรวจและแก้ต้นเหตุก่อน แล้วรีเซ็ตเพื่อดูว่า Alarm ผลสืบเนื่องหายไปเองหรือไม่ — ลดการไล่ทีละอุปกรณ์ที่ไม่จำเป็น</p>` : ""}</div>`;
}

let alarmList = [];
function runAlarms() {
  const lines = $("#al-in").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  showAlarms(lines.map(parseAlarm));
}
function showAlarms(list) {
  alarmList = list;
  alarmList.forEach((a, i) => (a.idx = i));
  const out = $("#al-out");
  if (!alarmList.length) { out.innerHTML = '<div class="hint">ยังไม่ได้ใส่ Alarm</div>'; return; }
  const noParse = alarmList.filter((a) => !a.tag && !a.event && !a.loc);
  const single = alarmList.length === 1;
  let html = "";
  if (!single) html += renderSummary(alarmList, analyzeBursts(alarmList));
  const ordered = single ? alarmList : [...alarmList].sort((x, y) => effRank(y) - effRank(x) || (x.ts ?? 0) - (y.ts ?? 0));
  html += (single ? "" : `<h3 class="muted small" style="margin:14px 0 4px">รายละเอียดรายตัว (เรียงตามความสำคัญ — กดเพื่อเปิด)</h3>`) + ordered.map((a) => renderAlarm(a, { open: single, auto: single })).join("");
  if (noParse.length)
    html += `<div class="note warn" style="margin-top:10px">${noParse.length} บรรทัดอ่านรูปแบบไม่ออก (ไม่พบตำแหน่ง/แท็ก/Event): ${noParse.map((a) => `“${esc(a.raw.slice(0, 50))}”`).join(", ")} — ลองพิมพ์รูปแบบ <span class="mono">EHA02+LVC03 TB05 FAULT, D.O. GENERAL FAULT</span> หรือค้นในแท็บ “ค้นหาสัญญาณ I/O”</div>`;
  out.innerHTML = html;
}

/* ---- structured form: one box per HMI alarm-list column ---- */
// location codes the HMI can show: those in the drawings plus a few seen on the real screens that the drawings don't cover
const EXTRA_LOCS = ["CRA+GEN", "SLA+GEN", "EHA02+FDF", "EHA01+AIC01", "SLA+HYD", "CRU+LTR"];
const KNOWN_LOCS = [...new Set([...Object.keys(D.locs).map((l) => l.replace(/^=PA01\+\+/, "")).filter((l) => /^[A-Z]{2,3}\d{0,2}\+[A-Z]{2,3}\d{0,2}$/.test(l)), ...EXTRA_LOCS])].sort();
const LOC_RE = /^[A-Z]{2,3}\d{0,2}\+[A-Z]{2,3}\d{0,2}$/;
const TAG_RE = /^[A-Z]{1,3}\d{1,3}[A-Z0-9\/,.\-]*$/;
const cleanLoc = (v) => (v || "").toUpperCase().replace(/\s+/g, "").replace(/^=?PA01/, "").replace(/^\+*/, "");
const cleanTag = (v) => (v || "").toUpperCase().replace(/\s+/g, "").replace(/^[-+=]+/, "");
const padTag = (t) => t.replace(/^([A-Z]{1,3})(\d)$/, "$10$2"); // HMI writes T02, the drawings write -T2
let rowSeq = 0;

function suggestLocs(text) {
  const t = cleanLoc(text);
  if (!t || KNOWN_LOCS.includes(t)) return [];
  const hit = KNOWN_LOCS.filter((l) => l.includes(t));
  return hit.sort((x, y) => (y.startsWith(t) - x.startsWith(t)) || x.localeCompare(y)).slice(0, 8);
}
function tagsInLoc(loc) {
  const full = "=PA01++" + loc, seen = new Set();
  for (const p of P) {
    if (p.l !== full) continue;
    for (const m of p.txt.matchAll(/(?:^|\n)-([A-Z]{1,3}\d{1,3})(?![A-Za-z0-9.])/g)) seen.add(padTag(m[1]));
  }
  return [...seen].sort((a, b) => a.replace(/\d+/, "").localeCompare(b.replace(/\d+/, "")) || parseInt(a.replace(/\D+/, "")) - parseInt(b.replace(/\D+/, "")));
}
function formRowHtml(id) {
  const lab = (n, title, hint, req) => `<span class="lab"><span class="n">${n}</span>${title}${hint ? ` <small>${hint}</small>` : ""} <span class="${req ? "req" : "opt"}">${req ? "จำเป็น" : "ไม่บังคับ"}</span></span>`;
  return `<div class="fm-row" data-row="${id}">
    <div class="fm-head"><b>Alarm รายการที่ <span class="fm-no"></span></b><button class="chip fm-del" type="button" title="ลบรายการนี้">ลบ</button></div>
    <div class="fm-grid">
      <label class="f">${lab(1, "ตำแหน่ง", "คอลัมน์ ++/+", true)}<input data-f="loc" list="dl-loc" placeholder="เช่น EHA02+LVC03" autocomplete="off" autocapitalize="characters" spellcheck="false"><div class="sugg" data-sugg></div></label>
      <label class="f">${lab(2, "แท็กอุปกรณ์", "คอลัมน์ “-”", true)}<input data-f="tag" list="dl-tag-${id}" placeholder="เช่น TB05" autocomplete="off" autocapitalize="characters" spellcheck="false"><datalist id="dl-tag-${id}"></datalist></label>
      <label class="f wide">${lab(3, "ชื่อวัตถุ", "คอลัมน์ Object name", false)}<input data-f="obj" placeholder="เช่น TRIPPER CAR, INVERTER 04" autocomplete="off" spellcheck="false"></label>
      <label class="f">${lab(4, "ระดับ", "คำแรกของช่อง Event", false)}<select data-f="sev"><option value="">ไม่ทราบ</option><option>FAULT</option><option>ALARM</option><option>WARNING</option></select></label>
      <label class="f wide">${lab(5, "ข้อความ Event", "ข้อความหลัง FAULT / ALARM / WARNING ,", true)}<input data-f="event" list="dl-event" placeholder="เช่น D.O. GENERAL FAULT" autocomplete="off" spellcheck="false"></label>
      <label class="f">${lab(6, "วันที่", "", false)}<input data-f="date" placeholder="03/10/26" autocomplete="off"></label>
      <label class="f">${lab(6, "เวลา", "", false)}<input data-f="time" placeholder="22:12:37.431" autocomplete="off"></label>
    </div>
    <div class="fm-warn" data-warn></div>
  </div>`;
}
function renumberRows() {
  const rows = [...document.querySelectorAll(".fm-row")];
  rows.forEach((r, i) => { $(".fm-no", r).textContent = i + 1; $(".fm-del", r).hidden = rows.length === 1; });
}
function addRow(v = {}) {
  const id = ++rowSeq;
  $("#fm-rows").insertAdjacentHTML("beforeend", formRowHtml(id));
  const row = $("#fm-rows").lastElementChild;
  for (const [k, val] of Object.entries(v)) { const el = row.querySelector(`[data-f="${k}"]`); if (el && val) el.value = val; }
  if (v.loc) refreshTagList(row);
  renumberRows();
  return row;
}
const rowVals = (row) => Object.fromEntries([...row.querySelectorAll("[data-f]")].map((el) => [el.dataset.f, el.value.trim()]));
function refreshTagList(row) {
  const loc = cleanLoc($('[data-f="loc"]', row).value);
  const dl = $("datalist", row);
  dl.innerHTML = LOC_RE.test(loc) ? tagsInLoc(loc).map((t) => `<option value="${esc(t)}">`).join("") : "";
}
function refreshLocHints(row) {
  const inp = $('[data-f="loc"]', row), loc = cleanLoc(inp.value), box = $("[data-sugg]", row);
  const sug = suggestLocs(inp.value);
  box.innerHTML = sug.length ? `<span class="small muted">ใช่ตำแหน่งไหน?</span> ${sug.map((l) => `<button type="button" class="chip" data-pick="${esc(l)}" title="${esc(locName(l))}">${esc(l)}</button>`).join("")}` : "";
  inp.classList.remove("bad");
  refreshTagList(row);
}
// a whole line pasted into one box (e.g. into the location box) is split across the boxes
function spreadLine(row, text) {
  const a = parseAlarm(text);
  if (!a.loc && !a.tag) return false;
  const set = (k, v) => { if (v) $(`[data-f="${k}"]`, row).value = v; };
  set("loc", a.loc); set("tag", a.tag); set("obj", a.obj); set("sev", a.sev); set("event", a.eventText); set("date", a.date); set("time", a.time);
  refreshLocHints(row);
  return true;
}
function alarmFromFields(f) {
  let ev = f.event, sev = f.sev;
  const m = /^(FAULT|ALARM|WARNING)\s*,\s*(.*)$/i.exec(ev);
  if (m) { sev = sev || m[1].toUpperCase(); ev = m[2]; }
  const a = { raw: "", ts: null, loc: normLoc(cleanLoc(f.loc)), tag: cleanTag(f.tag), obj: f.obj, sev, eventText: ev };
  a.raw = `${a.loc} ${a.tag} ${a.obj} ${sev ? sev + ", " : ""}${ev}`.replace(/\s+/g, " ").trim();
  const tm = /^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(f.time);
  const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(f.date);
  if (tm) {
    const yy = dm ? (+dm[3] < 100 ? 2000 + +dm[3] : +dm[3]) : 2000, mo = dm ? +dm[2] - 1 : 0, dd = dm ? +dm[1] : 1;
    a.ts = Date.UTC(yy, mo, dd, +tm[1], +tm[2], +tm[3], tm[4] ? +tm[4].padEnd(3, "0") : 0);
    a.time = `${tm[1].padStart(2, "0")}:${tm[2]}:${tm[3]}${tm[4] ? "." + tm[4] : ""}`;
    if (dm) a.date = `${dm[1].padStart(2, "0")}/${dm[2].padStart(2, "0")}/${dm[3]}`;
  }
  return finishAlarm(a);
}
function validateRow(row, f) {
  const errs = [], bad = [];
  const loc = cleanLoc(f.loc), tag = cleanTag(f.tag);
  if (!loc) { errs.push("กรอก <b>ตำแหน่ง</b> (ช่อง 1) — ดูคอลัมน์ ++/+ เช่น EHA02+LVC03"); bad.push("loc"); }
  else if (!LOC_RE.test(loc)) { errs.push(`ตำแหน่ง “${esc(f.loc)}” รูปแบบไม่ถูก — ต้องมีเครื่องหมาย + เช่น EHA02+LVC03 (เลือกจากตัวเลือกใต้ช่องได้)`); bad.push("loc"); }
  if (!tag) { errs.push("กรอก <b>แท็กอุปกรณ์</b> (ช่อง 2) — ดูคอลัมน์ “-” เช่น TB05, FC08"); bad.push("tag"); }
  else if (!TAG_RE.test(tag)) { errs.push(`แท็ก “${esc(f.tag)}” รูปแบบไม่ถูก — ควรเป็นตัวอักษร 1–3 ตัวตามด้วยตัวเลข เช่น TB05`); bad.push("tag"); }
  if (!f.event) { errs.push("กรอก <b>ข้อความ Event</b> (ช่อง 5) — ข้อความหลังคำว่า FAULT/ALARM/WARNING ,"); bad.push("event"); }
  if (f.time && !/^\d{1,2}:\d{2}:\d{2}([.,]\d{1,3})?$/.test(f.time)) { errs.push("เวลาต้องเป็นแบบ 22:12:37.431"); bad.push("time"); }
  if (f.date && !/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(f.date)) { errs.push("วันที่ต้องเป็นแบบ 03/10/26"); bad.push("date"); }
  row.querySelectorAll("[data-f]").forEach((el) => el.classList.toggle("bad", bad.includes(el.dataset.f)));
  const warns = [];
  if (loc && LOC_RE.test(loc) && !KNOWN_LOCS.includes(loc)) warns.push(`ไม่พบตำแหน่ง <b>${esc(loc)}</b> ในแบบ — ตรวจตัวสะกดอีกครั้ง (ยังวิเคราะห์ต่อได้)`);
  $("[data-warn]", row).innerHTML = errs.map((e) => `<div class="note bad" style="margin:4px 0">${e}</div>`).join("") + warns.map((w) => `<div class="note warn" style="margin:4px 0">${w}</div>`).join("");
  return errs;
}
function runForm() {
  const alarms = [];
  let ok = true, first = null;
  for (const row of document.querySelectorAll(".fm-row")) {
    const f = rowVals(row);
    if (!Object.values(f).some(Boolean)) continue; // empty row → skip
    if (validateRow(row, f).length) { ok = false; first ||= row; } else alarms.push(alarmFromFields(f));
  }
  if (!ok) { first.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
  if (!alarms.length) { $("#al-out").innerHTML = '<div class="note warn">ยังไม่ได้กรอก — ใส่ ตำแหน่ง · แท็ก · Event อย่างน้อย 1 รายการ</div>'; return; }
  showAlarms(alarms);
  $("#al-out").scrollIntoView({ behavior: "smooth", block: "start" });
}
function fillRows(list) {
  $("#fm-rows").innerHTML = "";
  for (const a of list) addRow({ loc: a.loc, tag: a.tag, obj: a.obj, sev: a.sev, event: a.eventText, date: a.date, time: a.time });
  if (!list.length) addRow();
}
function setMode(m) {
  $("#mode-form").hidden = m !== "form";
  $("#mode-paste").hidden = m !== "paste";
  $("#m-form").setAttribute("aria-pressed", String(m === "form"));
  $("#m-paste").setAttribute("aria-pressed", String(m === "paste"));
}
$("#m-form").addEventListener("click", () => setMode("form"));
$("#m-paste").addEventListener("click", () => setMode("paste"));
$("#fm-add").addEventListener("click", () => addRow().querySelector('[data-f="loc"]').focus());
$("#fm-go").addEventListener("click", runForm);
$("#fm-clear").addEventListener("click", () => { $("#fm-rows").innerHTML = ""; addRow(); $("#al-out").innerHTML = ""; });
$("#fm-rows").addEventListener("input", (e) => {
  const row = e.target.closest(".fm-row");
  if (!row) return;
  if (e.target.dataset.f === "loc") refreshLocHints(row);
  e.target.classList.remove("bad");
});
$("#fm-rows").addEventListener("change", (e) => {
  const row = e.target.closest(".fm-row");
  if (row && e.target.dataset.f === "loc" && /\s/.test(e.target.value.trim()) && spreadLine(row, e.target.value)) return;
  if (row && e.target.dataset.f === "loc") refreshLocHints(row);
});
$("#fm-rows").addEventListener("click", (e) => {
  const row = e.target.closest(".fm-row");
  const pick = e.target.closest("[data-pick]");
  if (pick && row) { $('[data-f="loc"]', row).value = pick.dataset.pick; refreshLocHints(row); $('[data-f="tag"]', row).focus(); return; }
  if (e.target.closest(".fm-del") && row) { row.remove(); renumberRows(); }
});
$("#fm-rows").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runForm(); });
$("#dl-loc").innerHTML = KNOWN_LOCS.map((l) => `<option value="${esc(l)}" label="${esc(locName(l))}">`).join("");
$("#dl-event").innerHTML = [...new Set(KB.samples.flatMap((s) => s.text.split("\n")).map((l) => /\b(?:FAULT|ALARM|WARNING),\s*(.+)$/.exec(l)?.[1]).filter(Boolean))].map((x) => `<option value="${esc(x)}">`).join("");
$("#fm-sample").innerHTML = '<option value="">ตัวอย่างจากหน้างาน (เติมลงช่องให้)…</option>' + KB.samples.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join("");
$("#fm-sample").addEventListener("change", (e) => {
  if (e.target.value === "") return;
  fillRows(KB.samples[+e.target.value].text.split("\n").map(parseAlarm));
  e.target.value = "";
  runForm();
});
addRow();

/* ---- attach a photo of the HMI screen: the local server asks Claude to transcribe it ---- */
let photoEnabled = false;
const photoInfo = (html) => ($("#al-photo-info").innerHTML = html);
async function prepareImage(file) {
  const bmp = await createImageBitmap(file); // honours the phone's EXIF rotation
  const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height)); // keep the text legible but the upload small
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.9);
}
async function readPhoto(file) {
  if (!photoEnabled || !file || !file.type.startsWith("image/")) return;
  const url = URL.createObjectURL(file);
  const thumb = `<span class="photo-box"><a href="${url}" target="_blank" rel="noopener"><img class="thumb" src="${url}" alt="รูปที่แนบ"></a>`;
  $("#al-photo-btn").disabled = true;
  photoInfo(`${thumb}<span>กำลังให้ Claude อ่านรูป… (ราว 10–40 วินาที)</span></span>`);
  try {
    let image;
    try { image = await prepareImage(file); } catch { throw new Error("เปิดไฟล์รูปนี้ไม่ได้ — ใช้รูป JPG หรือ PNG"); }
    const r = await fetch("/api/read-image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "อ่านรูปไม่สำเร็จ");
    if (!j.lines.length) { photoInfo(`${thumb}<span>ไม่พบแถว Alarm ที่อ่านได้ในรูป — ลองถ่ายให้ตรง ใกล้ขึ้น และเห็นตารางชัดๆ${j.notes ? " · " + esc(j.notes) : ""}</span></span>`); return; }
    $("#al-in").value = j.lines.join("\n");
    photoInfo(`${thumb}<span>อ่านได้ <b>${j.lines.length}</b> แถว${j.low ? ` · <span class="badge lowc">${j.low} แถวไม่มั่นใจ (ลงท้าย //?)</span>` : ""} — AI อาจอ่านผิด ตรวจเทียบกับรูป/หน้าจอ แก้ข้อความในช่องด้านบนได้แล้วกดวิเคราะห์ใหม่ หรือ <button type="button" class="chip" id="to-form">✍️ แก้ไขทีละช่อง</button>${j.notes ? `<br><span class="muted">${esc(j.notes)}</span>` : ""}</span></span>`);
    $("#to-form").addEventListener("click", () => { fillRows($("#al-in").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(parseAlarm)); setMode("form"); });
    runAlarms();
  } catch (e) {
    photoInfo(`${thumb}<span class="note bad" style="display:inline-block;margin:0">${esc(e.message)}</span></span>`);
  } finally {
    $("#al-photo-btn").disabled = false;
  }
}
(SITE ? Promise.reject(new Error("static")) : fetch("/api/status")).then((r) => r.json()).then((s) => {
  photoEnabled = !!s.enabled;
  $("#al-photo-btn").disabled = !photoEnabled;
  photoInfo(photoEnabled
    ? 'แนบ/ลาก/วาง (Ctrl+V) รูปหน้าจอ ALARMS ของ HMI ได้ — ถ่ายตรงๆ ให้เห็นตารางทั้งแถว · รูปถูกส่งให้ Claude (Anthropic API) อ่านผ่านเซิร์ฟเวอร์ของเครื่องนี้ และไม่ถูกบันทึกไว้'
    : `<span class="muted">แนบรูปยังใช้ไม่ได้: ${esc(s.message || "")}</span>`);
}).catch((e) => SITE ? (($("#al-photo-btn").hidden = true), photoInfo("")) : photoInfo('<span class="muted">การแนบรูปต้องเปิดเครื่องมือผ่าน run-analyzer.bat (เซิร์ฟเวอร์) — ตอนนี้พิมพ์ Alarm เองได้ตามปกติ</span>'));
$("#al-photo-btn").addEventListener("click", () => $("#al-photo").click());
$("#al-photo").addEventListener("change", (e) => { readPhoto(e.target.files[0]); e.target.value = ""; });
$("#al-in").addEventListener("paste", (e) => { const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith("image/")); if (f) { e.preventDefault(); readPhoto(f); } });
$("#al-in").addEventListener("dragover", (e) => { if (photoEnabled) { e.preventDefault(); e.currentTarget.classList.add("drop"); } });
$("#al-in").addEventListener("dragleave", (e) => e.currentTarget.classList.remove("drop"));
$("#al-in").addEventListener("drop", (e) => { e.currentTarget.classList.remove("drop"); const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith("image/")); if (f && photoEnabled) { e.preventDefault(); readPhoto(f); } });

/* ═════════════════════════ I/O-signal tab ═════════════════════════ */
const kindName = { DI: "อินพุตดิจิทัล", DO: "เอาต์พุตดิจิทัล", AI: "อนาล็อกอินพุต", AO: "อนาล็อกเอาต์พุต" };
let currentId = null;
function renderResults() {
  const q = $("#q").value.trim();
  const { rows, strict, total } = searchSignals(q, { kind: $("#f-kind").value, cab: $("#f-cab").value, hideSpare: $("#f-spare").checked });
  $("#res-info").textContent = !q ? `แสดง ${rows.length} รายการแรก — พิมพ์เพื่อค้นหา` : !rows.length ? "ไม่พบสัญญาณที่ตรงกัน ลองใช้คำสั้นลง หรือค้นในแท็บ “สำรวจแบบ”" : strict ? `พบ ${total} รายการ` : `ไม่มีรายการที่ตรงทุกคำ — แสดง ${rows.length} รายการที่ใกล้เคียงที่สุด`;
  $("#results").innerHTML = rows.map(({ s, cov }) => `
    <button class="item ${s.spare ? "spare" : ""}" data-sig="${s.id}" aria-current="${s.id === currentId}">
      <div class="l1"><span class="addr">${esc(s.a)}</span><span class="badge ${s.k}">${s.k}</span><span class="desc">${esc(s.d || "(ไม่มีคำอธิบาย)")}</span></div>
      <div class="small muted">${esc(s.t || "—")} · ${esc(s.m)}${s.s != null ? " · สถานี " + s.s : ""} · ${esc(cabLabel(s.l))}${q && !strict ? ` · ตรง ${(cov * 100) | 0}%` : ""}</div>
    </button>`).join("");
}
function pagesMentioning(re, loc, exclude, limit = 10) {
  return P.filter((p) => (!loc || p.l === loc) && !exclude.has(p.n) && re.test("\n" + p.txt + "\n")).slice(0, limit);
}
function selectSignal(id) {
  const s = S[id];
  currentId = id;
  renderResults();
  const tag = parseTag(s);
  const itp = interpret(s);
  const st = (D.stations[s.l] || []).find((x) => x.adr === s.s);
  const bit = /\.(\d)$/.exec(s.a);
  const chan = bit ? `${s.k}${bit[1]}` : s.a;
  const ctx = { addr: s.a, mod: s.m || "—", dev: tag.device || s.t || "—", pin: tag.pin || "—", st: s.s ?? "—", cab: cabLabel(s.l), chan };
  const hits = SIG_KB.filter((k) => k.test(s));
  const kb = ["mcb", "earth"].includes(hits[0]?.id) ? hits.slice(0, 1) : hits.slice(0, 2);
  const seen = new Set([s.p]);
  if (s.xp) seen.add(s.xp);
  const funcPages = s.f ? P.filter((p) => p.l === s.l && p.func === s.f) : [];
  funcPages.forEach((p) => seen.add(p.n));
  const devRe = tag.device && !s.spare ? new RegExp("(^|\\n)" + escRe(tag.device) + "(?![A-Za-z0-9.])") : null;
  const devPages = devRe ? pagesMentioning(devRe, tag.loc, seen) : [];
  devPages.forEach((p) => seen.add(p.n));
  const addrPages = pagesMentioning(new RegExp("\\n" + escRe(s.a) + "\\n"), "", seen);
  const related = S.filter((o) => o.id !== s.id && o.l === s.l && s.f && o.f === s.f && !o.spare);
  const relIds = new Set(related.map((o) => o.id));
  const sameModule = S.filter((o) => o.id !== s.id && o.l === s.l && o.m === s.m && o.k === s.k && !relIds.has(o.id));
  const relRow = (o) => `<button class="item" data-sig="${o.id}"><div class="l1"><span class="addr">${esc(o.a)}</span><span class="badge ${o.k}">${o.k}</span><span class="desc">${esc(o.d)}</span></div></button>`;
  $("#detail").innerHTML = `
  <div class="card">
    <div class="sig-head"><span class="addr">${esc(s.a)}</span><span class="badge ${s.k}">${s.k} · ${kindName[s.k]}</span>${s.s != null ? `<span class="badge">Profibus สถานี ${s.s}</span>` : ""}${s.spare ? '<span class="badge">spare</span>' : ""}</div>
    <h2>${esc(s.d || "(ไม่มีคำอธิบาย)")}</h2>
    <div class="path" aria-label="เส้นทางสัญญาณ">
      <div class="node"><b>${esc(s.t || "—")}</b><span>${esc(tag.ext ? "อุปกรณ์ภายนอกตู้" : "อุปกรณ์/ขั้ว")}${tag.pin ? " · " + esc(pinMeaning(tag.pin)) : ""}</span></div>
      <span class="arrow">→</span>
      <div class="node"><b>${esc(s.m || "—")}</b><span>ET200S ${esc(s.mt)}</span></div>
      <span class="arrow">→</span>
      <div class="node"><b>${s.s != null ? "สถานี " + s.s : "สถานี ?"}</b><span>${esc(cabLabel(s.l))}</span></div>
      <span class="arrow">→</span>
      <div class="node"><b>${esc(s.a)}</b><span>CPU S7-400 (Profibus DP)</span></div>
    </div>
    <div class="note ${itp.cls}">${esc(itp.text)}</div>
    <h3>แนวทางตรวจสอบ</h3>
    <ol class="steps">${LADDER.map((t) => `<li>${esc(fill(t, ctx))}</li>`).join("")}</ol>
    ${kb.map((k) => `<div class="kb"><div class="t">${esc(k.label)}</div><div class="small muted">${esc(k.why)}</div><ol class="steps">${k.steps.map((t) => `<li>${esc(fill(t, ctx))}</li>`).join("")}</ol></div>`).join("")}
    <h3>หน้าแบบที่เกี่ยวข้อง (กดเพื่อดู PDF)</h3>
    <div>
      ${pageChip(s.p, `รายการ I/O · หน้า ${s.p}`)}
      ${s.xp ? pageChip(s.xp, `วงจรต้นทาง /${s.x} · หน้า ${s.xp}`) : ""}
      ${st ? pageChip(st.page, `ผัง rack สถานี ${st.adr} · หน้า ${st.page}`) : ""}
    </div>
    ${funcPages.length ? `<div class="small muted" style="margin-top:8px">ทั้งชุดวงจรของ “${esc(s.f)}” ในตู้นี้</div><div>${funcPages.map((p) => pageChip(p.n, `${p.sub || p.func} · ${p.n}`)).join("")}</div>` : ""}
    ${devPages.length ? `<div class="small muted" style="margin-top:8px">หน้าอื่นที่มีอุปกรณ์ ${esc(tag.device)}</div><div>${devPages.map((p) => pageChip(p.n, pageLabel(p))).join("")}</div>` : ""}
    ${addrPages.length ? `<div class="small muted" style="margin-top:8px">หน้าอื่นที่กล่าวถึง ${esc(s.a)}</div><div>${addrPages.map((p) => pageChip(p.n, pageLabel(p))).join("")}</div>` : ""}
    ${related.length ? `<h3>สัญญาณที่เกี่ยวข้อง (ฟังก์ชันเดียวกัน: ${esc(s.f)})</h3><div class="list">${related.slice(0, 14).map(relRow).join("")}</div>` : ""}
    ${sameModule.length ? `<h3>ช่องอื่นของโมดูล ${esc(s.m)}</h3><div class="list">${sameModule.slice(0, 16).map(relRow).join("")}</div>` : ""}
  </div>`;
  $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
  openPdf(s.xp || s.p, `${s.a} · ${s.d || ""}`.slice(0, 90));
}

/* ═════════════════════════ drawing explorer ═════════════════════════ */
function renderDrawings() {
  const q = $("#dq").value.trim().toLowerCase();
  const cab = $("#d-cab").value;
  const qt = q.split(/\s+/).filter(Boolean);
  const hl = (t) => qt.reduce((acc, w) => acc.replace(new RegExp("(" + escRe(esc(w)) + ")", "ig"), "<mark>$1</mark>"), esc(t));
  $("#d-cab").hidden = $("#d-doc").value === "manual";
  if ($("#d-doc").value === "manual") {
    const isToc = (p) => p.sec.startsWith("สารบัญ");
    const rows = M.filter((p) => qt.every((t) => p.low.includes(t))).sort((x, y) => isToc(x) - isToc(y)); // contents pages last
    $("#d-info").textContent = `${rows.length} หน้า${rows.length > 120 ? " (แสดง 120 หน้าแรก)" : ""}`;
    $("#d-results").innerHTML = rows.slice(0, 120).map((p) => {
      const line = qt.length ? p.txt.split("\n").find((l) => qt.some((t) => l.toLowerCase().includes(t))) : "";
      return `<button class="item" data-page="${p.n}" data-doc="manual"><div class="l1"><span class="addr">${p.n}</span><span class="desc">${esc(p.sec || "(ไม่มีหัวข้อ)")}</span></div>${line ? `<div class="small muted">${hl(line.slice(0, 160))}</div>` : ""}</button>`;
    }).join("");
    return;
  }
  const rows = P.filter((p) => (!cab || p.l === cab) && qt.every((t) => p.low.includes(t)));
  $("#d-info").textContent = `${rows.length} หน้า${rows.length > 120 ? " (แสดง 120 หน้าแรก)" : ""}`;
  $("#d-results").innerHTML = rows.slice(0, 120).map((p) => {
    let snip = "";
    if (qt.length) {
      const line = p.txt.split("\n").find((l) => qt.some((t) => l.toLowerCase().includes(t)));
      if (line) snip = `<div class="small muted">${hl(line.slice(0, 140))}</div>`;
    }
    return `<button class="item" data-page="${p.n}"><div class="l1"><span class="addr">${p.n}</span><span class="desc">${esc(p.func)}${p.sub ? " | " + esc(p.sub) : ""}</span></div>
      <div class="small muted">${esc(cabLabel(p.l))} · แผ่น ${esc(p.sheet)}</div>${snip}</button>`;
  }).join("");
}

/* ═════════════════════════ wiring ═════════════════════════ */
function activateTab(name) {
  for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", String(t.dataset.tab === name));
  for (const n of ["alarm", "sig", "dwg"]) $("#pane-" + n).hidden = n !== name;
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => activateTab(t.dataset.tab)));
const debounce = (fn, ms = 120) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };

$("#q").addEventListener("input", debounce(renderResults));
for (const id of ["f-kind", "f-cab", "f-spare"]) $("#" + id).addEventListener("change", renderResults);
$("#dq").addEventListener("input", debounce(renderDrawings));
$("#d-cab").addEventListener("change", renderDrawings);
$("#d-doc").addEventListener("change", renderDrawings);
if (!MAN) $("#d-doc").querySelector('[value="manual"]').disabled = true; // manual.js not present
$("#results").addEventListener("click", (e) => { const b = e.target.closest("[data-sig]"); if (b) selectSignal(+b.dataset.sig); });
$("#detail").addEventListener("click", (e) => { const b = e.target.closest("[data-sig]"); if (b) selectSignal(+b.dataset.sig); });
$("#al-out").addEventListener("click", (e) => {
  const sg = e.target.closest("[data-sig]");
  if (sg) { activateTab("sig"); selectSignal(+sg.dataset.sig); return; }
  const st = e.target.closest("[data-st]");
  if (st) { activateTab("sig"); $("#q").value = "st" + st.dataset.st; $("#f-kind").value = ""; $("#f-cab").value = ""; renderResults(); return; }
  const op = e.target.closest("[data-open]");
  if (op) { e.preventDefault(); const d = document.getElementById(op.dataset.open); if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "start" }); } }
});
$("#al-go").addEventListener("click", runAlarms);
$("#al-clear").addEventListener("click", () => { $("#al-in").value = ""; $("#al-out").innerHTML = ""; });
$("#al-in").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runAlarms(); });
$("#al-sample").innerHTML = '<option value="">ตัวอย่างจากหน้างาน…</option>' + KB.samples.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join("");
$("#al-sample").addEventListener("change", (e) => { if (e.target.value === "") return; $("#al-in").value = KB.samples[+e.target.value].text; runAlarms(); e.target.value = ""; });

const sigCabs = [...new Set(S.map((s) => s.l))].sort();
$("#f-cab").insertAdjacentHTML("beforeend", sigCabs.map((l) => `<option value="${esc(l)}">${esc(cabLabel(l))}</option>`).join(""));
const allCabs = Object.keys(D.locs).filter((l) => P.some((p) => p.l === l)).sort();
$("#d-cab").insertAdjacentHTML("beforeend", allCabs.map((l) => `<option value="${esc(l)}">${esc(locShort(l))} · ${esc(cabLabel(l))}</option>`).join(""));
$("#examples").innerHTML = ["crawler brake 1", "E701.1", "-FC08", "emergency stop", "beltdrift", "earth fault", "luffing"].map((x) => `<button class="chip" data-ex="${esc(x)}">${esc(x)}</button>`).join("");
$("#examples").addEventListener("click", (e) => { const b = e.target.closest("[data-ex]"); if (b) { $("#q").value = b.dataset.ex; renderResults(); } });
$("#stats").textContent = `${S.length} สัญญาณ I/O · ${P.length} หน้าแบบ${MAN ? ` · ${M.length} หน้าคู่มือ` : ""} · ${KB.events.length} รูปแบบ Event`;
$("#glossary").innerHTML = KB.glossary.map(([k, v, src]) => `<tr><th class="mono">${esc(k)}</th><td>${esc(v)} <span class="badge ${src === "inferred" ? "lowc" : "src"}">${{ drawing: "ยืนยันจากแบบ", manual: "ยืนยันจากคู่มือ", inferred: "อนุมาน" }[src]}</span></td></tr>`).join("");
renderResults();
renderDrawings();

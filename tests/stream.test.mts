// הזרם הרציף: הדבקת קבצים וחיתוך לפי Range (אחסון מקומי).
process.env.MOCK_AI = "1";
delete process.env.BLOB_READ_WRITE_TOKEN;
import assert from "node:assert/strict";
import * as store from "../src/lib/storage";
import { resolveStream, rangeStream, buildManifest, BYTES_PER_SEC } from "../src/lib/stream";
import { audioDirFor, questionDirFor } from "../src/lib/prepare";
import type { Book } from "../src/lib/books";

const book: Book = {
  id: "test-stream",
  title: "ספר",
  lang: "he",
  source: { type: "upload", url: "x", filename: "x.txt", kind: "txt" },
  createdAt: new Date().toISOString(),
  chapters: [{ title: "א", start: 0, end: 1 }, { title: "ב", start: 2, end: 2 }],
  sections: [0, 1, 2].map((i) => ({ i, chapter: i < 2 ? 0 : 1, text: "t" })),
};
const dir = audioDirFor(book, "Puck", "he");
const qdir = questionDirFor(book, "Puck");
const f0 = Buffer.alloc(6000, 0xa0), f1 = Buffer.alloc(12000, 0xb1), q0 = Buffer.alloc(3000, 0xc2), f2 = Buffer.alloc(6000, 0xd3);
await store.writeBytes(dir + "0.mp3", f0, "audio/mpeg");
await store.writeBytes(dir + "1.mp3", f1, "audio/mpeg");
await store.writeBytes(qdir + "0.mp3", q0, "audio/mpeg");
await store.writeBytes(dir + "2.mp3", f2, "audio/mpeg");

const m = await buildManifest(book, 0, "he", "Puck", true);
assert.deepEqual(m.items.map((x) => [x.kind, x.i, x.start]), [["section", 0, 0], ["section", 1, 1], ["question", 0, 3], ["section", 2, 3.5]]);
assert.equal(m.totalSeconds, 27000 / BYTES_PER_SEC);
assert.deepEqual(m.qs, [0]);
// בלי מצב לימוד — בלי שאלה
assert.equal((await buildManifest(book, 0, "he", "Puck", false)).items.length, 3);

const { parts, total } = await resolveStream(book, 0, 2, [0], "he", "Puck");
assert.equal(total, 27000);
const read = async (s: number, e: number) => { const chunks: Buffer[] = []; const r = rangeStream(parts, s, e).getReader(); for (;;) { const { value, done } = await r.read(); if (done) break; chunks.push(Buffer.from(value)); } return Buffer.concat(chunks); };
const all = await read(0, total - 1);
assert.equal(all.length, 27000);
assert.equal(all[0], 0xa0); assert.equal(all[6000], 0xb1); assert.equal(all[18000], 0xc2); assert.equal(all[21000], 0xd3);
const mid = await read(5990, 6010); // חוצה גבול בין קבצים
assert.equal(mid.length, 21);
assert.equal(mid[9], 0xa0); assert.equal(mid[10], 0xb1);
const tail = await read(26990, 26999);
assert.equal(tail.length, 10); assert.equal(tail[9], 0xd3);
for (const p of [dir + "0.mp3", dir + "1.mp3", dir + "2.mp3", qdir + "0.mp3"]) await store.remove(p);
console.log("stream ok");

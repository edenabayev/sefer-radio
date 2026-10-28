// ניקוד עזר: האותיות לא משתנות לעולם, ורק מילים שזהות למקור מקבלות ניקוד.
import assert from "node:assert/strict";
import { mergeNiqqud, stripNiqqud, chunksForNiqqud } from "../src/lib/niqqud";
import { parseGen, encodeGen } from "../src/lib/stream";
import { nqTagFor } from "../src/lib/books";

const orig = "הוא ספר לה את הספר, ושמח מאוד.\n\nבית־הספר היה סגור.";
// מושלם: אותן מילים בדיוק
let r = mergeNiqqud(orig, "הוא סִפֵּר לה את הַסֵּפֶר, וְשָׂמַח מאוד.\n\nבית־הספר היה סגור.");
assert.equal(stripNiqqud(r.text), orig);
assert.ok(r.text.includes("סִפֵּר") && r.text.includes("הַסֵּפֶר,") && r.text.includes("וְשָׂמַח"));
assert.equal(r.marked, 3);
assert.ok(r.text.includes("\n\nבית־הספר"), "מקף עברי ומעברי פסקה נשמרים");

// המודל הוסיף כותרת, השמיט מילה ושינה מילה אחת (הוסיף ו) — רק המילים הזהות נכנסות
r = mergeNiqqud(orig, "הנה הטקסט:\nהוּא סִפֵּר את הַסֵּפֶר, וְשׂוֹמֵחַ מאוד.\n\nבית־הספר היה סגור.");
assert.equal(stripNiqqud(r.text), orig);
assert.ok(r.text.includes("סִפֵּר לה"));
assert.ok(r.text.includes("ושמח"), "מילה שהאותיות שלה השתנו נשארת כמו במקור");
assert.ok(!r.text.includes("הנה"));

// תשובה ריקה או זבל — הטקסט המקורי כמו שהוא
assert.equal(mergeNiqqud(orig, "").text, orig);
assert.equal(mergeNiqqud(orig, "lorem ipsum").text, orig);

// הסרת ניקוד משאירה מקף עברי
assert.equal(stripNiqqud("בֵּית־סֵפֶר"), "בית־ספר");

// חיתוך לחתיכות: מחברים בחזרה בדיוק לאותו טקסט
const long = Array.from({ length: 40 }, (_, k) => `פסקה ${k} ` + "מילה ".repeat(30).trim()).join("\n\n");
const parts = chunksForNiqqud(long, 1000);
assert.ok(parts.length > 3);
assert.equal(parts.join(""), long);
assert.ok(parts.every((p) => p.length <= 1000));

// "gen" בכתובת הזרם: דור תרגום + הקלטות מחדש עם ניקוד + קטעים בודדים
assert.deepEqual(parseGen(""), { trGen: undefined });
assert.deepEqual(parseGen("~n49"), { trGen: undefined, nqSegs: [{ from: 49, tag: "n" }] });
assert.deepEqual(parseGen("~n53~n90.n2~f1761650000000"), { trGen: undefined, nqSegs: [{ from: 53, tag: "n" }, { from: 90, tag: "n2" }], fixUpTo: 1761650000000 });
assert.deepEqual(parseGen("1730000000000~n7"), { trGen: "1730000000000", nqSegs: [{ from: 7, tag: "n" }] });
assert.deepEqual(parseGen("1730000000000"), { trGen: "1730000000000" });
assert.equal(encodeGen({ lang: "en", trGen: undefined }), undefined);
assert.equal(encodeGen({ lang: "en", trGen: "123", nqSegs: [{ from: 5, tag: "n" }] }), "123~n5");
assert.equal(encodeGen({ lang: "he", trGen: "123", nqSegs: [{ from: 5, tag: "n" }] }), "~n5");
assert.equal(encodeGen({ lang: "en", nqSegs: [{ from: 53, tag: "n" }, { from: 90, tag: "n2" }], fixes: { 62: 100, 80: 200 } }), "~n53~n90.n2~f200");
// כל קטע שייך לסימון עם ה-from הגדול ביותר שלא אחריו
const segBook = { nqSegs: [{ from: 53, tag: "n" }, { from: 90, tag: "n2" }] };
assert.equal(nqTagFor(segBook, 10), undefined);
assert.equal(nqTagFor(segBook, 53), "n");
assert.equal(nqTagFor(segBook, 89), "n");
assert.equal(nqTagFor(segBook, 90), "n2");
assert.equal(nqTagFor(segBook, 300), "n2");
console.log("niqqud tests ok");

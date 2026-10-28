// ניקוד עזר: האותיות לא משתנות לעולם, ורק מילים שזהות למקור מקבלות ניקוד.
import assert from "node:assert/strict";
import { mergeNiqqud, stripNiqqud, chunksForNiqqud } from "../src/lib/niqqud";
import { parseGen, encodeGen } from "../src/lib/stream";

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

// "gen" בכתובת הזרם: דור תרגום + ניקוד
assert.deepEqual(parseGen(""), { trGen: undefined, nqFrom: undefined });
assert.deepEqual(parseGen("~n53~f1761650000000"), { trGen: undefined, nqFrom: 53, fixUpTo: 1761650000000 });
assert.equal(encodeGen({ lang: "en", trGen: undefined, nqFrom: 53, fixes: { 62: 100, 80: 200 } }), "~n53~f200");
assert.deepEqual(parseGen("~n49"), { trGen: undefined, nqFrom: 49 });
assert.deepEqual(parseGen("1730000000000~n7"), { trGen: "1730000000000", nqFrom: 7 });
assert.deepEqual(parseGen("1730000000000"), { trGen: "1730000000000", nqFrom: undefined });
assert.equal(encodeGen({ lang: "en", trGen: undefined, nqFrom: undefined }), undefined);
assert.equal(encodeGen({ lang: "en", trGen: "123", nqFrom: 5 }), "123~n5");
assert.equal(encodeGen({ lang: "he", trGen: "123", nqFrom: 5 }), "~n5");
console.log("niqqud tests ok");

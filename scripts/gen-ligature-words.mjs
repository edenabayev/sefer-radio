// מייצר את src/lib/ligature-words.ts: מילים באנגלית שיש בהן fi / fl / ff (מתוך רשימת מילים בקוד פתוח, MIT).
// ב-PDF שבו הצירופים האלה מודפסים כאות אחת ("ﬁ") בלי מיפוי לטקסט, הם נעלמים — והרשימה עוזרת להחזיר את הנכון.
// הרצה: node scripts/gen-ligature-words.mjs
import { createRequire } from "module";
import { writeFileSync } from "fs";
const require = createRequire(import.meta.url);
const words = require("an-array-of-english-words");
const lig = words.filter((w) => /^[a-z]+$/.test(w) && w.length <= 18 && /fi|fl|ff/.test(w)).sort();
const body = lig.join(" ");
writeFileSync(
  new URL("../src/lib/ligature-words.ts", import.meta.url),
  `// נוצר ע"י scripts/gen-ligature-words.mjs — לא לערוך ידנית. מקור: an-array-of-english-words (MIT).\n` +
    `// ${lig.length} מילים באנגלית שיש בהן fi / fl / ff.\n` +
    `export const LIGATURE_WORDS = ${JSON.stringify(body)};\n`,
);
console.log(lig.length, "words,", body.length, "chars");

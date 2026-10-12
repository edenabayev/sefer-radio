import { parseCsv, searchCatalog, type CatalogEntry } from "@/lib/catalog";
const csv = 'Text#,Type,Issued,Title,Language,Authors,Subjects,LoCC,Bookshelves\n2680,Text,2001-06-01,Meditations,en,"Marcus Aurelius, Emperor of Rome, 121-180",Stoics,B,Philosophy\n55317,Text,2017-08-07,"The Meditations of the Emperor Marcus Aurelius Antoninus",en,"Marcus Aurelius, Emperor of Rome, 121-180; Long, George, 1800-1879",x,y,z\n1342,Text,1998-06-01,"Pride and Prejudice",en,"Austen, Jane, 1775-1817",x,PR,z\n9,Sound,1998,"Audio thing",en,"Someone",x,y,z\n100,Text,2000,"ספר, בעברית\nעם שורה",he,"מישהו, 1900-1950",x,y,z\n';
const rows = parseCsv(csv);
console.log(rows.length, rows[4]);
if (rows.length !== 6 || rows[5][3] !== "ספר, בעברית\nעם שורה") throw new Error("csv parse failed");
const entries: CatalogEntry[] = [
  { gid: 2680, title: "Meditations", author: "Marcus Aurelius, Emperor of Rome", lang: "en" },
  { gid: 55317, title: "The Meditations of the Emperor Marcus Aurelius Antoninus", author: "Marcus Aurelius, Emperor of Rome", lang: "en" },
  { gid: 1342, title: "Pride and Prejudice", author: "Austen, Jane", lang: "en" },
];
const r = searchCatalog(entries, "meditations marcus aurelius");
console.log(r.map((e) => e.gid));
if (r[0].gid !== 2680 || r.length !== 2) throw new Error("search ranking failed");
if (searchCatalog(entries, "jane austen")[0].gid !== 1342) throw new Error("author search failed");
console.log("CATALOG OK");

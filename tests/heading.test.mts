import assert from "node:assert/strict";
import { spokenHeading } from "../src/lib/books";
assert.equal(spokenHeading("CHAPTER IV", "en"), "Chapter 4");
assert.equal(spokenHeading("Chapter XII. The Return", "en"), "Chapter 12. The Return");
assert.equal(spokenHeading("17", "en"), "Chapter 17");
assert.equal(spokenHeading("17", "he"), "פרק 17");
assert.equal(spokenHeading("THE CATCHER IN THE RYE", "en"), "The catcher in the rye");
assert.equal(spokenHeading("סִפּוּר הַמֶּלֶךְ", "he"), "סִפּוּר הַמֶּלֶךְ");
console.log("heading ok");

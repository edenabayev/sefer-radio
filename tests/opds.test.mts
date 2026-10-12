import { searchGutenberg } from "@/lib/books";
const sample = `<?xml version="1.0"?><feed><entry><updated>x</updated><id>https://www.gutenberg.org/ebooks/2680.opds</id><title>Meditations</title><content type="text">Emperor of Rome Marcus Aurelius</content><link type="application/atom+xml;profile=opds-catalog" rel="subsection" href="/ebooks/2680.opds"/></entry><entry><id>https://www.gutenberg.org/ebooks/55317.opds</id><title>The Meditations of the Emperor Marcus Aurelius Antoninus</title><content type="text">Emperor of Rome Marcus Aurelius</content></entry></feed>`;
globalThis.fetch = (async () => new Response(sample, { status: 200 })) as unknown as typeof fetch;
const hits = await searchGutenberg("meditations");
console.log(hits);
if (hits.length !== 2 || hits[0].gid !== 2680 || hits[0].author !== "Emperor of Rome Marcus Aurelius") throw new Error("opds parse failed");
console.log("OPDS OK");

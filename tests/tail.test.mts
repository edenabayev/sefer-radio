import { pcm16ToMp3, fakePcm } from "@/lib/mp3";
import fs from "fs";
const pcm = fakePcm(5);
// add 0.5s of pure silence at the end so the real signal ends cleanly
const silence = Buffer.alloc(24000);
const mp3 = await pcm16ToMp3(Buffer.concat([pcm, silence]));
fs.mkdirSync("tests/out", { recursive: true });
fs.writeFileSync("tests/out/tail.mp3", mp3);
console.log("mp3 bytes", mp3.length, "last 16 bytes", [...mp3.subarray(-16)].map(b => b.toString(16).padStart(2, "0")).join(" "));

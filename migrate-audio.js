const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name:  "djoqczzyj",
  api_key:     "445679147396695",
  api_secret:  "XcKEVdXfzDgzv4hcvcK6RqPvREU",
});

const files = [
  "Genesis","Exodus","Leviticus","Numbers","Deuteronomy","Josue","Judges","Ruth",
  "I-Kings","II-Kings","III-Kings","IV-Kings","I-Paralipomenon","II-Paralipomenon",
  "I-Esdras","II-Esdras","Tobias","Judith","Esther","Job","Psalms","Proverbs",
  "Ecclesiastes","Canticle-of-Canticles","Wisdom","Ecclesiasticus","Isaias",
  "Jeremias","Lamentations","Baruch","Ezekiel","Daniel","Osee","Joel","Amos",
  "Abdias","Jonas","Micheas","Nahum","Habacuc","Sophonias","Aggeus","Zacharias",
  "Malachias","I-Machabees","II-Machabees","Matthew","Mark","Luke","John","Acts",
  "Romans","I-Corinthians","II-Corinthians","Galatians","Ephesians","Philippians",
  "Colossians","I-Thessalonians","II-Thessalonians","I-Timothy","II-Timothy",
  "Titus","Philemon","Hebrews","James","I-Peter","II-Peter","I-John","II-John",
  "III-John","Jude","Apocalypse"
];

async function migrate() {
  let success = 0;
  let failed  = 0;

  for (const name of files) {
    try {
      await cloudinary.uploader.rename(name, `bible-audio/${name}`, { resource_type: "video", overwrite: true });
      console.log(`✅ ${name}`);
      success++;
    } catch (err) {
      console.warn(`❌ ${name}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. ${success} moved, ${failed} failed.`);
}

migrate();

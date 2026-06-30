// Generate the promo voiceover clips with ElevenLabs.
//
//   node scripts/generate-voiceover.js          # generate any missing clips
//   node scripts/generate-voiceover.js --force   # re-generate every clip
//
// Reads ELEVENLABS_API_KEY (or XI_API_KEY) from ../.env. Writes one mp3 per
// line in src/voiceover/manifest.json to public/voiceover/vo-<id>.mp3.
// Already-rendered clips are skipped unless --force is passed, so a partial
// run can be resumed safely.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.resolve(ROOT, "..", ".env");
const MANIFEST = path.resolve(ROOT, "src", "voiceover", "manifest.json");
const OUT_DIR = path.resolve(ROOT, "public", "voiceover");

function loadEnvKey() {
  const names = ["ELEVENLABS_API_KEY", "XI_API_KEY", "ELEVEN_API_KEY"];
  for (const n of names) if (process.env[n]) return process.env[n];
  if (!fs.existsSync(ENV_FILE)) return null;
  const text = fs.readFileSync(ENV_FILE, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (names.includes(m[1])) {
      return m[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  return null;
}

async function main() {
  const force = process.argv.includes("--force");
  const apiKey = loadEnvKey();
  if (!apiKey) {
    console.error(
      "\n  Missing ElevenLabs API key.\n" +
        "  Add a line to " + ENV_FILE + " :\n\n" +
        "      ELEVENLABS_API_KEY=sk_your_key_here\n\n" +
        "  (XI_API_KEY / ELEVEN_API_KEY are also accepted.)\n"
    );
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const { voiceId, modelId, voiceSettings, clips } = manifest;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Voice ${voiceId} · model ${modelId} · ${clips.length} clips\n`);
  let made = 0;
  let skipped = 0;

  for (const clip of clips) {
    const outPath = path.join(OUT_DIR, `vo-${clip.id}.mp3`);
    if (!force && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      console.log(`  [skip] vo-${clip.id}.mp3 (exists)`);
      skipped++;
      continue;
    }
    process.stdout.write(`  [gen]  vo-${clip.id}.mp3  "${clip.text}" ... `);
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: clip.text,
          model_id: modelId,
          voice_settings: voiceSettings,
        }),
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.log("FAILED");
      console.error(`\n  HTTP ${res.status} ${res.statusText}\n  ${detail}\n`);
      process.exit(1);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(outPath, buf);
    console.log(`${(buf.length / 1024).toFixed(0)} KB`);
    made++;
  }

  console.log(`\nDone. ${made} generated, ${skipped} skipped → ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

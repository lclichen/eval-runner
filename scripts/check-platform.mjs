/**
 * Platform driver machinery check — validates PlatformDriver against a REAL
 * platform instance without any deep-swe image: creates a container from an
 * existing image (default: first public one), runs exec/write/read/stop.
 *
 *   node scripts/check-platform.mjs --platform-url http://10.99.9.7:3000 \
 *        --platform-key sk_... [--image-name ubuntu-22.04]
 */
import { parseArgs } from "../src/cli.js";
import { PlatformDriver } from "../src/platform.js";

const args = parseArgs(process.argv.slice(2));
const url = args.platformUrl ?? process.env.PLATFORM_URL;
const key = args.platformKey ?? process.env.PLATFORM_KEY;
if (!url || !key) {
  console.error("need --platform-url/--platform-key (or PLATFORM_URL/PLATFORM_KEY)");
  process.exit(1);
}

const driver = new PlatformDriver({ url, key });
const images = await driver.listImages();
console.log(`images: ${images.map((i) => `${i.id}:${i.name}`).join(", ")}`);
const wanted = args.imageName ?? images[0]?.name;
const image = images.find((i) => i.name === wanted) ?? images[0];
console.log(`using image ${image.id}:${image.name} (default_resources=${JSON.stringify(image.default_resources)})`);

const handle = await driver.createContainer({
  imageId: image.id,
  name: `dswe-machinery-check-${Date.now().toString(36)}`,
  ...(image.default_resources?.cpu ? { cpu: image.default_resources.cpu } : {}),
  ...(image.default_resources?.memoryMb ? { memoryMb: image.default_resources.memoryMb } : {}),
  ...(image.default_resources?.diskGb ? { diskGb: image.default_resources.diskGb } : {}),
});
console.log(`container created: ${handle.name}`);
try {
  await driver.startContainer(handle);
  console.log("started");

  const uname = await driver.exec(handle, "uname -a && id && echo HOME=$HOME && pwd");
  console.log(`exec: exit=${uname.exitCode} out=${(uname.stdout || uname.stderr).trim().slice(0, 120)}`);

  await driver.writeFile(handle, "/tmp/dswe-check.txt", Buffer.from("machinery-check-ok"));
  const back = await driver.readFile(handle, "/tmp/dswe-check.txt");
  console.log(`write/read roundtrip: ${back.toString() === "machinery-check-ok" ? "OK" : `MISMATCH: ${back}`}`);

  const ls = await driver.exec(handle, "ls /app 2>/dev/null && echo HAS_APP || echo NO_APP");
  console.log(`ls /app: ${ls.stdout.trim()}`);
} finally {
  await driver.stopContainer(handle).then(() => console.log("stopped"), (e) => console.log("stop failed:", e.message));
}

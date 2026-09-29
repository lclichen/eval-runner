/**
 * Register a converted task SIF into the platform (admin).
 *
 *   node scripts/register-sif.mjs --platform-url http://10.99.9.7:3000 \
 *     --platform-key sk_... --sif /home/llmx/dswe-sif/abs-module-cache-flags.sif \
 *     --docker-ref "public.ecr.aws/...:tag" [--cpu 2 --memory-mb 8192 --disk-gb 20]
 *
 * Naming convention: docker ref with ":" → "-" (the platform image-name schema
 * rejects colons); eval-runner's ensureImage resolves the same way.
 */
import { parseArgs } from "../src/cli.js";
import { PlatformDriver } from "../src/platform.js";

const args = parseArgs(process.argv.slice(2));
const url = args.platformUrl ?? process.env.PLATFORM_URL;
const key = args.platformKey ?? process.env.PLATFORM_KEY;
const { sif, dockerRef } = args;
if (!url || !key || !sif || !dockerRef) {
  console.error("need --platform-url/--platform-key/--sif <abs path on platform host>/--docker-ref <task.toml docker_image>");
  process.exit(1);
}

const driver = new PlatformDriver({ url, key });
const image = await driver.registerImage({
  name: dockerRef,
  sifPath: sif,
  displayName: dockerRef,
  description: "deep-swe task image (auto-registered by eval-runner)",
  cpu: args.cpu ? Number(args.cpu) : 2,
  memoryMb: args.memoryMb ? Number(args.memoryMb) : 8192,
  diskGb: args.diskGb ? Number(args.diskGb) : 20,
});
console.log("registered:", JSON.stringify(image));
const { imageId } = await driver.ensureImage(dockerRef);
console.log(`ensureImage resolves → imageId=${imageId}`);

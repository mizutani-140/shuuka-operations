import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "owner-id": { type: "string" },
    "tiers-digest": { type: "string" },
    "varieties-digest": { type: "string" },
  },
});

const setupDir = import.meta.dirname;
const sourcePath = path.join(setupDir, "gift_content_2026.json");
const outputPath = path.join(setupDir, "gift_metafields_set.variables.json");
const content = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const ownerId = values["owner-id"] ?? content.productId;

if (!/^gid:\/\/shopify\/Product\/\d+$/.test(ownerId)) {
  throw new Error("Provide a valid Shopify Product GID with --owner-id.");
}

const variables = {
  metafields: [
    {
      ownerId,
      namespace: "gift",
      key: "tiers",
      type: "json",
      compareDigest: values["tiers-digest"] ?? null,
      value: JSON.stringify(content.tiers),
    },
    {
      ownerId,
      namespace: "gift",
      key: "varieties",
      type: "json",
      compareDigest: values["varieties-digest"] ?? null,
      value: JSON.stringify(content.varieties),
    },
  ],
};

fs.writeFileSync(outputPath, `${JSON.stringify(variables, null, 2)}\n`);
console.log(`Wrote ${outputPath}`);

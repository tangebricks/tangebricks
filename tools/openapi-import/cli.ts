import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseImportCliArgs, runOpenApiImportAll, runOpenApiImportCli, runOpenApiImportFile } from "../../packages/integrations/src/cli.ts";

export { parseImportCliArgs, runOpenApiImportAll, runOpenApiImportCli, runOpenApiImportFile };

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  runOpenApiImportCli();
}

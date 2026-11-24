import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "tailwindcss";
import tailwindConfig from "./tailwind.config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default {
  plugins: [
    tailwindcss({
      ...tailwindConfig,
      content: [
        resolve(__dirname, "./index.html"),
        resolve(__dirname, "./src/**/*.{ts,tsx}"),
      ],
    }),
  ],
};

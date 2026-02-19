// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    rules: {
      "import/no-unresolved": [
        "error",
        { ignore: ["^protocol$", "^protocol/browser$", "^protocol/react-native$"] },
      ],
    },
  },
  {
    ignores: ["dist/*"],
  },
]);

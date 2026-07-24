import next from "eslint-config-next";

const config = [
  ...next,
  {
    // eslint-plugin-react-hooks@7.1 promoted the React Compiler rules to
    // errors. This codebase is not written against the compiler ruleset, so
    // keep them off to avoid failing the build on pre-existing patterns.
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/error-boundaries": "off",
      "react-hooks/refs": "off",
    },
  },
];

export default config;
